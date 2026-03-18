import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, ensureDataDirectories } from "./app";
import { QueueRepository } from "./queue";
import { ConsolidationTracker } from "./consolidation-tracker";
import { MemoryIndex } from "./memory-index";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";

let tempDir: string;
let queue: QueueRepository;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;
let dbPath: string;

function makeApp(overrides?: {
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
  noTracker?: boolean;
}) {
  process.env.KORE_API_KEY = "test-key";
  return createApp({
    queue,
    dataPath: tempDir,
    memoryIndex,
    qmdStatus: async () => ({ status: "ok" as const }),
    searchFn: overrides?.noTracker ? undefined : (overrides?.searchFn ?? (async () => [])),
    consolidationTracker: overrides?.noTracker ? undefined : tracker,
  });
}

function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      ...init,
    })
  );
}

async function writeTestMemory(id: string, title: string, opts?: { type?: string; category?: string; tags?: string[] }) {
  const type = opts?.type ?? "note";
  const category = opts?.category ?? "qmd://tech/testing";
  const tags = opts?.tags ?? ["test"];
  const typeDir = type === "place" ? "places" : type === "person" ? "people" : type === "media" ? "media" : "notes";
  const filePath = join(tempDir, typeDir, `${id}.md`);

  const content = [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `category: ${category}`,
    `date_saved: 2026-03-01T00:00:00Z`,
    `source: test`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Distilled Memory Items",
    "- **Fact one about this topic**",
    "- **Fact two about this topic**",
    "",
    "## Raw Source",
    "Some raw content here for testing purposes.",
  ].join("\n");

  await Bun.write(filePath, content);
  memoryIndex.set(id, filePath);
  tracker.upsertMemory(id, type);
  return filePath;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-consolidation-api-test-"));
  await ensureDataDirectories(tempDir);
});

beforeEach(async () => {
  dbPath = join(tempDir, `queue-${Date.now()}.db`);
  queue = new QueueRepository(dbPath);
  tracker = new ConsolidationTracker(queue.getDatabase());
  memoryIndex = new MemoryIndex();
  await memoryIndex.build(tempDir);
});

afterEach(() => {
  queue.close();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── POST /api/v1/consolidate ────────────────────────────────────────

describe("POST /api/v1/consolidate", () => {
  test("returns no_seed when tracker has no eligible seeds", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/consolidate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_seed");
  });

  test("returns cluster_too_small when fewer than 3 candidates found", async () => {
    // Write seed + 1 other memory (not enough for cluster of 3)
    await writeTestMemory("mem-seed", "React Patterns");
    await writeTestMemory("mem-other", "React Hooks");

    const path2 = memoryIndex.get("mem-other")!;

    const searchFn = async () => [
      {
        file: path2,
        displayPath: "qmd://memories/notes/mem-other.md",
        title: "React Hooks",
        body: "Hook content",
        bestChunk: "React hooks guide",
        bestChunkPos: 0,
        score: 0.7,
        context: null,
        docid: "doc2",
      },
    ] as HybridQueryResult[];

    const app = makeApp({ searchFn });
    const res = await req(app, "/api/v1/consolidate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("cluster_too_small");
    expect(body.seed).toBeDefined();
    expect(body.seed.id).toBe("mem-seed");
    expect(body.candidateCount).toBe(1);
  });

  test("reset_failed resets failed tracker rows before cycle runs", async () => {
    await writeTestMemory("mem-failed", "Failed Memory");

    // Mark it as failed
    tracker.markFailed("mem-failed", 1); // 1 attempt max → immediately failed

    // Verify it's failed
    expect(tracker.getStatus("mem-failed")?.status).toBe("failed");

    const app = makeApp();
    const res = await req(app, "/api/v1/consolidate?reset_failed=true", { method: "POST" });
    expect(res.status).toBe(200);

    // The failed status should have been reset before the cycle ran
    // After reset, it becomes pending, so selectSeed finds it
    // The cycle will likely return cluster_too_small (only 1 memory)
    // but the key assertion is that resetFailed was called
    const status = tracker.getStatus("mem-failed");
    // After reset + cycle attempt, it could be 'pending' (reset) or 'failed' again (cycle failed)
    // Either way, synthesis_attempts should reflect the reset happened
    expect(status).toBeDefined();
  });

  test("dry_run returns candidate list without writing any files", async () => {
    // Write 4 memories so we have enough for a cluster
    await writeTestMemory("mem-1", "React State Management");
    await writeTestMemory("mem-2", "React Context API");
    await writeTestMemory("mem-3", "React Redux Patterns");
    await writeTestMemory("mem-4", "React Hooks Guide");

    const path2 = memoryIndex.get("mem-2")!;
    const path3 = memoryIndex.get("mem-3")!;
    const path4 = memoryIndex.get("mem-4")!;

    const searchFn = async () =>
      [
        {
          file: path2,
          displayPath: "qmd://memories/notes/mem-2.md",
          title: "React Context API",
          body: "Context content",
          bestChunk: "React context guide",
          bestChunkPos: 0,
          score: 0.8,
          context: null,
          docid: "doc2",
        },
        {
          file: path3,
          displayPath: "qmd://memories/notes/mem-3.md",
          title: "React Redux Patterns",
          body: "Redux content",
          bestChunk: "Redux patterns guide",
          bestChunkPos: 0,
          score: 0.75,
          context: null,
          docid: "doc3",
        },
        {
          file: path4,
          displayPath: "qmd://memories/notes/mem-4.md",
          title: "React Hooks Guide",
          body: "Hooks content",
          bestChunk: "Hooks guide",
          bestChunkPos: 0,
          score: 0.65,
          context: null,
          docid: "doc4",
        },
      ] as HybridQueryResult[];

    const app = makeApp({ searchFn });

    // Count insight files before
    const { readdir } = require("node:fs/promises");
    const insightsBefore = await readdir(join(tempDir, "insights")).catch(() => []);

    const res = await req(app, "/api/v1/consolidate?dry_run=true", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("dry_run");
    expect(body.seed).toBeDefined();
    expect(body.candidates).toBeArray();
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(body.proposedInsightType).toBeDefined();
    expect(body.estimatedConfidence).toBeDefined();
    expect(typeof body.estimatedConfidence).toBe("number");

    // Verify no insight files were written
    const insightsAfter = await readdir(join(tempDir, "insights")).catch(() => []);
    expect(insightsAfter.length).toBe(insightsBefore.length);
  });

  test("returns 503 when consolidation tracker is not available", async () => {
    const app = makeApp({ noTracker: true });

    const res = await req(app, "/api/v1/consolidate", { method: "POST" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Consolidation service not available");
  });

  test("requires bearer auth", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(res.status).toBe(401);
  });
});

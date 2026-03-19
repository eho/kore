import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createApp, ensureDataDirectories } from "./app";
import { QueueRepository } from "./queue";
import { ConsolidationTracker } from "./consolidation-tracker";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { deleteMemoryById } from "./delete-memory";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";

let tempDir: string;
let queue: QueueRepository;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;
let eventDispatcher: EventDispatcher;
let dbPath: string;

function makeApp(overrides?: {
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
}) {
  process.env.KORE_API_KEY = "test-key";
  return createApp({
    queue,
    dataPath: tempDir,
    memoryIndex,
    eventDispatcher,
    qmdStatus: async () => ({ status: "ok" as const }),
    searchFn: overrides?.searchFn ?? (async () => []),
    consolidationTracker: tracker,
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

async function writeInsightFile(
  id: string,
  title: string,
  opts?: {
    status?: string;
    insight_type?: string;
    source_ids?: string[];
    confidence?: number;
  },
) {
  const status = opts?.status ?? "active";
  const insightType = opts?.insight_type ?? "cluster_summary";
  const sourceIds = opts?.source_ids ?? ["src-1", "src-2", "src-3"];
  const confidence = opts?.confidence ?? 0.75;
  const filePath = join(tempDir, "insights", `${id}-test-insight.md`);

  const content = [
    "---",
    `id: ${id}`,
    `type: insight`,
    `category: qmd://tech/testing`,
    `date_saved: 2026-03-01T00:00:00Z`,
    `source: kore_synthesis`,
    `tags: ["test", "insight"]`,
    `insight_type: ${insightType}`,
    `source_ids: [${sourceIds.map((s) => `"${s}"`).join(", ")}]`,
    `supersedes: []`,
    `superseded_by: []`,
    `confidence: ${confidence}`,
    `status: ${status}`,
    `reinforcement_count: 0`,
    `re_eval_reason: null`,
    `last_synthesized_at: 2026-03-01T00:00:00Z`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Synthesis",
    "This is a test synthesis.",
    "",
    "## Key Connections",
    "No direct connections identified.",
    "",
    "## Distilled Memory Items",
    "- **Test fact one**",
    "- **Test fact two**",
    "",
    "## Source Material",
    `Synthesized from ${sourceIds.length} memories: ${sourceIds.join(", ")}`,
    "",
  ].join("\n");

  await Bun.write(filePath, content);
  memoryIndex.set(id, filePath);
  return filePath;
}

async function writeSourceMemory(
  id: string,
  title: string,
  opts?: { insightRefs?: string[] },
) {
  const filePath = join(tempDir, "notes", `${id}.md`);
  const lines = [
    "---",
    `id: ${id}`,
    `type: note`,
    `category: qmd://tech/testing`,
    `date_saved: 2026-03-01T00:00:00Z`,
    `source: test`,
    `tags: ["test"]`,
  ];
  if (opts?.insightRefs && opts.insightRefs.length > 0) {
    lines.push(`insight_refs: [${opts.insightRefs.map((r) => `"${r}"`).join(", ")}]`);
    lines.push(`consolidated_at: 2026-03-01T00:00:00Z`);
  }
  lines.push("---", "", `# ${title}`, "", "## Distilled Memory Items", "- **Fact one**", "", "## Raw Source", "Some content.");

  const content = lines.join("\n");
  await Bun.write(filePath, content);
  memoryIndex.set(id, filePath);
  return filePath;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-con006-test-"));
  await ensureDataDirectories(tempDir);
});

beforeEach(async () => {
  dbPath = join(tempDir, `queue-${Date.now()}.db`);
  queue = new QueueRepository(dbPath);
  tracker = new ConsolidationTracker(queue.getDatabase());
  memoryIndex = new MemoryIndex();
  eventDispatcher = new EventDispatcher();
  await memoryIndex.build(tempDir);
});

afterEach(() => {
  queue.close();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── MemoryIndex includes insights/ ──────────────────────────────────

describe("MemoryIndex includes insights/", () => {
  test("scans insight files on build", async () => {
    await writeInsightFile("ins-test001", "Test Insight");
    await memoryIndex.build(tempDir);

    const path = memoryIndex.get("ins-test001");
    expect(path).toBeDefined();
    expect(path).toContain("insights/");
  });

  test("prefix matching works for insight IDs", async () => {
    await writeInsightFile("ins-abcd1234", "Prefix Test Insight");
    await memoryIndex.build(tempDir);

    const path = memoryIndex.get("ins-abcd");
    expect(path).toBeDefined();
    expect(path).toContain("insights/");
  });
});

// ─── List API returns insights ───────────────────────────────────────

describe("GET /api/v1/memories?type=insight", () => {
  test("returns insights with insight-specific fields", async () => {
    await writeInsightFile("ins-list0001", "List Test Insight", {
      insight_type: "evolution",
      status: "active",
      confidence: 0.82,
      source_ids: ["s1", "s2", "s3", "s4"],
    });

    const app = makeApp();
    const res = await req(app, "/api/v1/memories?type=insight");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);

    const insight = body.find((m: any) => m.id === "ins-list0001");
    expect(insight).toBeDefined();
    expect(insight.type).toBe("insight");
    expect(insight.insight_type).toBe("evolution");
    expect(insight.status).toBe("active");
    expect(insight.source_ids_count).toBe(4);
  });
});

// ─── Show API works for insights ─────────────────────────────────────

describe("GET /api/v1/memory/:id for insights", () => {
  test("returns full insight with all fields", async () => {
    await writeInsightFile("ins-show0001", "Show Test Insight", {
      insight_type: "connection",
      source_ids: ["src-a", "src-b", "src-c"],
    });

    const app = makeApp();
    const res = await req(app, "/api/v1/memory/ins-show0001");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe("ins-show0001");
    expect(body.type).toBe("insight");
    expect(body.insight_type).toBe("connection");
    expect(body.source_ids).toEqual(["src-a", "src-b", "src-c"]);
    expect(body.content).toContain("## Synthesis");
  });

  test("prefix matching works for insight show", async () => {
    await writeInsightFile("ins-pfx12345", "Prefix Show Test");

    const app = makeApp();
    const res = await req(app, "/api/v1/memory/ins-pfx1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe("ins-pfx12345");
  });
});

// ─── Search filters retired insights ─────────────────────────────────

describe("POST /api/v1/search filters retired insights", () => {
  test("excludes retired insights from search results", async () => {
    const retiredPath = await writeInsightFile("ins-retired1", "Retired Insight", {
      status: "retired",
    });
    const activePath = await writeInsightFile("ins-active1", "Active Insight", {
      status: "active",
    });

    const searchFn = async () =>
      [
        {
          file: retiredPath,
          displayPath: "qmd://memories/insights/ins-retired1.md",
          title: "Retired Insight",
          body: "Retired content",
          bestChunk: "Retired chunk",
          bestChunkPos: 0,
          score: 0.9,
          context: null,
          docid: "doc-retired",
        },
        {
          file: activePath,
          displayPath: "qmd://memories/insights/ins-active1.md",
          title: "Active Insight",
          body: "Active content",
          bestChunk: "Active chunk",
          bestChunkPos: 0,
          score: 0.8,
          context: null,
          docid: "doc-active",
        },
      ] as HybridQueryResult[];

    const app = makeApp({ searchFn });
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "test insight" }),
    });
    expect(res.status).toBe(200);

    const results = await res.json();
    const ids = results.map((r: any) => r.id);
    expect(ids).not.toContain("ins-retired1");
    expect(ids).toContain("ins-active1");
  });

  test("includes non-insight results regardless of path", async () => {
    const notePath = join(tempDir, "notes", "regular-note.md");
    await Bun.write(
      notePath,
      "---\nid: note-regular\ntype: note\ncategory: qmd://test\ndate_saved: 2026-03-01T00:00:00Z\nsource: test\ntags: [\"test\"]\n---\n\n# Regular Note\n"
    );
    memoryIndex.set("note-regular", notePath);

    const searchFn = async () =>
      [
        {
          file: notePath,
          displayPath: "qmd://memories/notes/regular-note.md",
          title: "Regular Note",
          body: "Note content",
          bestChunk: "Note chunk",
          bestChunkPos: 0,
          score: 0.7,
          context: null,
          docid: "doc-note",
        },
      ] as HybridQueryResult[];

    const app = makeApp({ searchFn });
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "regular note" }),
    });
    expect(res.status).toBe(200);

    const results = await res.json();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("note-regular");
  });
});

// ─── Delete cleans up insight_refs ───────────────────────────────────

describe("Delete insight cleans up insight_refs from sources", () => {
  test("removes insight ID from source memory insight_refs", async () => {
    const insightId = "ins-del00001";
    const sourceIds = ["src-del-1", "src-del-2"];

    // Write source memories with insight_refs pointing to the insight
    const src1Path = await writeSourceMemory("src-del-1", "Source One", {
      insightRefs: [insightId, "ins-other"],
    });
    const src2Path = await writeSourceMemory("src-del-2", "Source Two", {
      insightRefs: [insightId],
    });

    // Write the insight
    await writeInsightFile(insightId, "Deletable Insight", {
      source_ids: sourceIds,
    });

    // Delete the insight
    const result = await deleteMemoryById(insightId, { memoryIndex, eventDispatcher });
    expect(result.deleted).toBe(true);

    // Check source 1: should still have "ins-other" but not the deleted insight
    const src1Content = await readFile(src1Path, "utf-8");
    expect(src1Content).not.toContain(insightId);
    expect(src1Content).toContain("ins-other");

    // Check source 2: insight_refs should be empty
    const src2Content = await readFile(src2Path, "utf-8");
    expect(src2Content).not.toContain(insightId);
  });
});

// ─── Reset truncates consolidation_tracker ───────────────────────────

describe("Reset endpoint truncates consolidation_tracker", () => {
  test("DELETE /api/v1/memories clears tracker", async () => {
    // Add some tracker entries
    tracker.upsertMemory("mem-reset-1", "note");
    tracker.upsertMemory("mem-reset-2", "note");
    tracker.upsertMemory("ins-reset-1", "insight");

    expect(tracker.getStatus("mem-reset-1")).not.toBeNull();
    expect(tracker.getStatus("ins-reset-1")).not.toBeNull();

    const app = makeApp();
    const res = await req(app, "/api/v1/memories", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Tracker should be empty
    expect(tracker.getStatus("mem-reset-1")).toBeNull();
    expect(tracker.getStatus("mem-reset-2")).toBeNull();
    expect(tracker.getStatus("ins-reset-1")).toBeNull();
  });
});

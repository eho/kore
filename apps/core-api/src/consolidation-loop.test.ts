import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ConsolidationTracker } from "./consolidation-tracker";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import {
  runConsolidationCycle,
  runConsolidationDryRun,
  startConsolidationLoop,
  reconcileOnStartup,
  buildConsolidationDeps,
} from "./consolidation-loop";
import type { ConsolidationDeps } from "./consolidation-loop";

// ─── Helpers ─────────────────────────────────────────────────────────

let tempDir: string;
let db: Database;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;
let eventDispatcher: EventDispatcher;

function makeMemoryContent(id: string, title: string, type = "note", category = "qmd://tech/programming") {
  return `---
id: ${id}
type: ${type}
category: ${category}
date_saved: 2026-03-01T00:00:00.000Z
source: test
tags: ["test"]
---

# ${title}

## Distilled Memory Items
- **Fact one about ${title}.**
- **Fact two about ${title}.**
- **Fact three about ${title}.**
`;
}

function makeInsightContent(id: string, title: string, sourceIds: string[], status = "active") {
  return `---
id: ${id}
type: insight
category: qmd://tech/programming
date_saved: 2026-03-01T00:00:00.000Z
source: kore_synthesis
tags: ["test"]
insight_type: cluster_summary
source_ids: [${sourceIds.map((s) => `"${s}"`).join(", ")}]
supersedes: []
superseded_by: []
confidence: 0.8
status: ${status}
reinforcement_count: 0
re_eval_reason: null
last_synthesized_at: 2026-03-01T00:00:00.000Z
---

# ${title}

## Synthesis
Test synthesis.

## Key Connections
No direct connections identified.

## Distilled Memory Items
- **Test fact.**

## Source Material
Synthesized from ${sourceIds.length} memories: ${sourceIds.join(", ")}
`;
}

async function writeTestMemory(id: string, title: string, type = "note") {
  const dir = join(tempDir, type === "insight" ? "insights" : "notes");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${id}.md`);
  const content = type === "insight"
    ? makeInsightContent(id, title, [])
    : makeMemoryContent(id, title);
  await Bun.write(filePath, content);
  memoryIndex.set(id, filePath);
  return filePath;
}

function mockQmdSearch(results: Array<{ file: string; score: number; title?: string }>) {
  return mock(async () =>
    results.map((r) => ({
      file: r.file,
      score: r.score,
      title: r.title ?? "Test",
      bestChunk: "test chunk",
    })) as any[],
  );
}

function makeDeps(overrides: Partial<ConsolidationDeps> = {}): ConsolidationDeps {
  return {
    dataPath: tempDir,
    qmdSearch: mockQmdSearch([]),
    tracker,
    memoryIndex,
    eventDispatcher,
    intervalMs: 1_800_000,
    minClusterSize: 3,
    maxClusterSize: 8,
    minSimilarityScore: 0.45,
    cooldownDays: 7,
    maxSynthesisAttempts: 3,
    relevanceThreshold: 0.5,
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-loop-test-"));
  db = new Database(join(tempDir, `loop-${Date.now()}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  tracker = new ConsolidationTracker(db);
  memoryIndex = new MemoryIndex();
  eventDispatcher = new EventDispatcher();
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── runConsolidationCycle Tests ─────────────────────────────────────

describe("runConsolidationCycle", () => {
  test("returns no_seed when tracker has no eligible seeds", async () => {
    const deps = makeDeps();
    const result = await runConsolidationCycle(deps);
    expect(result.status).toBe("no_seed");
  });

  test("returns cluster_too_small when fewer than 3 candidates found", async () => {
    // Create seed and one candidate (need 3 total: seed + 2 candidates)
    const seedPath = await writeTestMemory("mem-001", "React Hooks");
    await writeTestMemory("mem-002", "React Context");
    tracker.upsertMemory("mem-001", "note");

    // QMD returns only 1 candidate (need 2 for minClusterSize=3)
    const qmdSearch = mockQmdSearch([
      { file: memoryIndex.get("mem-002")!, score: 0.7 },
    ]);

    const deps = makeDeps({ qmdSearch });
    const result = await runConsolidationCycle(deps);

    expect(result.status).toBe("cluster_too_small");
    expect(result.seed?.title).toBe("React Hooks");
  });

  test("failed synthesis increments tracker attempts", async () => {
    await writeTestMemory("mem-001", "React Hooks");
    tracker.upsertMemory("mem-001", "note");

    // QMD returns too few candidates, seed gets marked failed
    const qmdSearch = mockQmdSearch([]);
    const deps = makeDeps({ qmdSearch });

    await runConsolidationCycle(deps);

    const status = tracker.getStatus("mem-001");
    expect(status?.synthesis_attempts).toBe(1);
  });

  test("re-eval seeds are processed before new seeds", async () => {
    // Create regular memory (new seed) and insight (re-eval seed)
    await writeTestMemory("mem-001", "React Hooks");
    tracker.upsertMemory("mem-001", "note");

    const insightPath = await writeTestMemory("ins-reeval1", "Insight Title", "insight");
    // Write proper insight content with source_ids
    await Bun.write(
      insightPath,
      makeInsightContent("ins-reeval1", "Insight Title", ["mem-001", "mem-002", "mem-003"]),
    );
    tracker.upsertMemory("ins-reeval1", "insight");
    tracker.markEvolving("ins-reeval1", "new_evidence");

    // Seed selection should pick the re-eval seed first
    const seed = tracker.selectSeed(7, 3);
    expect(seed?.memoryId).toBe("ins-reeval1");
    expect(seed?.isReeval).toBe(true);
  });
});

// ─── runConsolidationDryRun Tests ────────────────────────────────────

describe("runConsolidationDryRun", () => {
  test("returns no_seed when tracker is empty", async () => {
    const deps = makeDeps();
    const result = await runConsolidationDryRun(deps);
    expect(result.status).toBe("no_seed");
  });

  test("returns cluster_too_small with candidate count", async () => {
    await writeTestMemory("mem-001", "React Hooks");
    tracker.upsertMemory("mem-001", "note");

    const qmdSearch = mockQmdSearch([]);
    const deps = makeDeps({ qmdSearch });

    const result = await runConsolidationDryRun(deps);
    expect(result.status).toBe("cluster_too_small");
    expect(result.seed?.id).toBe("mem-001");
  });

  test("returns dry_run result with candidates and proposed type", async () => {
    await writeTestMemory("mem-001", "React Hooks");
    const path2 = await writeTestMemory("mem-002", "React Context");
    const path3 = await writeTestMemory("mem-003", "React State");
    tracker.upsertMemory("mem-001", "note");

    const qmdSearch = mockQmdSearch([
      { file: path2, score: 0.75, title: "React Context" },
      { file: path3, score: 0.65, title: "React State" },
    ]);

    const deps = makeDeps({ qmdSearch });
    const result = await runConsolidationDryRun(deps);

    expect(result.status).toBe("dry_run");
    expect(result.seed?.id).toBe("mem-001");
    expect(result.candidates?.length).toBe(2);
    expect(result.proposedInsightType).toBe("cluster_summary");
    expect(typeof result.estimatedConfidence).toBe("number");
  });
});

// ─── startConsolidationLoop Tests ────────────────────────────────────

describe("startConsolidationLoop", () => {
  test("concurrency guard prevents overlapping cycles", async () => {
    let cycleCount = 0;
    let resolveFirst: (() => void) | undefined;

    // Create a slow mock qmdSearch that blocks the first cycle
    const slowSearch = mock(async () => {
      cycleCount++;
      if (cycleCount === 1) {
        // First cycle blocks
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return [];
    });

    await writeTestMemory("mem-001", "React Hooks");
    tracker.upsertMemory("mem-001", "note");

    const deps = makeDeps({
      qmdSearch: slowSearch,
      intervalMs: 50, // Very short interval for testing
    });

    const handle = startConsolidationLoop(deps);

    // Wait for first cycle to start
    await new Promise((r) => setTimeout(r, 100));

    // The first cycle should still be running, second should be skipped
    expect(cycleCount).toBe(1);

    // Release the first cycle
    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 20));

    await handle.stop();
  });

  test("loop exits early when no seed is available", async () => {
    const qmdSearch = mockQmdSearch([]);
    const deps = makeDeps({ qmdSearch, intervalMs: 50 });

    const handle = startConsolidationLoop(deps);

    // Wait for a few cycles
    await new Promise((r) => setTimeout(r, 150));
    await handle.stop();

    // Should have called selectSeed but not qmdSearch (no seed available)
    expect(qmdSearch).not.toHaveBeenCalled();
  });
});

// ─── Reconciliation Tests ────────────────────────────────────────────

describe("reconcileOnStartup", () => {
  test("adds tracker entries for orphaned insight files", async () => {
    // Write an insight file directly (not via tracker)
    const insightsDir = join(tempDir, "insights");
    await mkdir(insightsDir, { recursive: true });
    const filePath = join(insightsDir, "ins-orphan01.md");
    await Bun.write(filePath, makeInsightContent("ins-orphan01", "Orphaned Insight", ["mem-001"]));

    await reconcileOnStartup({ dataPath: tempDir, tracker, memoryIndex });

    // Tracker should now have an entry for this insight
    const status = tracker.getStatus("ins-orphan01");
    expect(status).not.toBeNull();
    expect(status?.status).toBe("active");
  });

  test("retires tracker entries for insights missing from disk", async () => {
    // Add an insight to tracker that doesn't exist on disk
    tracker.upsertMemory("ins-missing1", "insight");
    tracker.markConsolidated("ins-missing1");

    // Also add it to memoryIndex so the forward check finds it
    memoryIndex.set("ins-missing1", join(tempDir, "insights", "ins-missing1.md"));

    await reconcileOnStartup({ dataPath: tempDir, tracker, memoryIndex });

    const status = tracker.getStatus("ins-missing1");
    expect(status?.status).toBe("retired");
  });
});

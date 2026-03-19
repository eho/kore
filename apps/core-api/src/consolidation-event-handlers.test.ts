import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ConsolidationTracker } from "./consolidation-tracker";
import { MemoryIndex } from "./memory-index";
import { createConsolidationEventHandlers } from "./consolidation-event-handlers";
import type { MemoryEvent } from "@kore/shared-types";

// ─── Helpers ─────────────────────────────────────────────────────────

let tempDir: string;
let db: Database;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;

function makeInsightContent(
  id: string,
  sourceIds: string[],
  status = "active",
) {
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

# Test Insight

## Synthesis
Test synthesis.

## Distilled Memory Items
- **Test fact.**

## Source Material
Synthesized from ${sourceIds.length} memories: ${sourceIds.join(", ")}
`;
}

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "mem-new-001",
    filePath: "/tmp/test/notes/mem-new-001.md",
    frontmatter: { type: "note", title: "Test Memory" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function mockQmdSearch(results: Array<{ file: string; score: number }> = []) {
  return mock(async () =>
    results.map((r) => ({
      file: r.file,
      score: r.score,
      title: "Test",
      bestChunk: "test chunk",
    })) as any[],
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-events-test-"));
  db = new Database(join(tempDir, `events-${Date.now()}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  tracker = new ConsolidationTracker(db);
  memoryIndex = new MemoryIndex();
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── onMemoryIndexed Tests ──────────────────────────────────────────

describe("onMemoryIndexed", () => {
  test("upserts new memories into tracker", async () => {
    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    await handlers.onMemoryIndexed(makeEvent({ id: "mem-new-001" }));

    const status = tracker.getStatus("mem-new-001");
    expect(status).not.toBeNull();
    expect(status?.status).toBe("pending");
    expect(status?.memory_type).toBe("note");
  });

  test("skips reactive check for kore_synthesis source", async () => {
    const qmdSearch = mockQmdSearch();
    const handlers = createConsolidationEventHandlers(
      tracker,
      qmdSearch,
      memoryIndex,
    );

    await handlers.onMemoryIndexed(
      makeEvent({
        id: "ins-new-001",
        frontmatter: { type: "insight", source: "kore_synthesis", title: "Insight" },
      }),
    );

    // Should have upserted but NOT called qmdSearch for reactive check
    expect(tracker.getStatus("ins-new-001")).not.toBeNull();
    expect(qmdSearch).not.toHaveBeenCalled();
  });

  test("flags related insights as evolving on new evidence", async () => {
    // Create an existing insight on disk
    const insightPath = join(tempDir, "insights", "ins-existing.md");
    await Bun.write(
      insightPath,
      makeInsightContent("ins-existing", ["mem-001", "mem-002", "mem-003"]),
    );
    memoryIndex.set("ins-existing", insightPath);
    tracker.upsertMemory("ins-existing", "insight");
    tracker.markConsolidated("ins-existing");

    // Set consolidated_at far in the past to avoid cooldown throttle
    db.run(
      `UPDATE consolidation_tracker SET consolidated_at = datetime('now', '-30 days') WHERE memory_id = ?`,
      ["ins-existing"],
    );

    // Create a new memory file for the event
    const newMemPath = join(tempDir, "notes", "mem-new-001.md");
    await Bun.write(newMemPath, `---
id: mem-new-001
type: note
title: React Advanced Patterns
---

# React Advanced Patterns

## Distilled Memory Items
- **Advanced hook patterns are essential.**
`);

    // QMD returns the insight as related
    const qmdSearch = mockQmdSearch([
      { file: insightPath, score: 0.7 },
    ]);

    const handlers = createConsolidationEventHandlers(
      tracker,
      qmdSearch,
      memoryIndex,
    );

    await handlers.onMemoryIndexed(
      makeEvent({
        id: "mem-new-001",
        filePath: newMemPath,
        frontmatter: { type: "note", title: "React Advanced Patterns" },
      }),
    );

    // Reactive check runs fire-and-forget — wait for it to complete
    await new Promise((r) => setTimeout(r, 100));

    // The insight should be flagged as evolving
    const status = tracker.getStatus("ins-existing");
    expect(status?.status).toBe("evolving");
    expect(status?.re_eval_reason).toBe("new_evidence");
  });
});

// ─── onMemoryDeleted Tests ──────────────────────────────────────────

describe("onMemoryDeleted", () => {
  test("retires deleted insight in tracker", async () => {
    tracker.upsertMemory("ins-del-001", "insight");
    tracker.markConsolidated("ins-del-001");

    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    await handlers.onMemoryDeleted(
      makeEvent({
        id: "ins-del-001",
        filePath: join(tempDir, "insights", "ins-del-001.md"),
        frontmatter: { type: "insight" },
      }),
    );

    const status = tracker.getStatus("ins-del-001");
    expect(status?.status).toBe("retired");
  });

  test("sets insight to evolving when ratio >= 0.5", async () => {
    // Insight with 3 sources, delete 1 → 2/3 = 0.67 ≥ 0.5 → evolving
    const insightPath = join(tempDir, "insights", "ins-ratio-test.md");
    await Bun.write(
      insightPath,
      makeInsightContent("ins-ratio-test", ["mem-001", "mem-002", "mem-003"]),
    );
    memoryIndex.set("ins-ratio-test", insightPath);
    tracker.upsertMemory("ins-ratio-test", "insight");
    tracker.markConsolidated("ins-ratio-test");

    // mem-002 and mem-003 still exist
    memoryIndex.set("mem-002", join(tempDir, "notes", "mem-002.md"));
    memoryIndex.set("mem-003", join(tempDir, "notes", "mem-003.md"));

    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    await handlers.onMemoryDeleted(
      makeEvent({
        id: "mem-001",
        frontmatter: {
          type: "note",
          insight_refs: '["ins-ratio-test"]',
        },
      }),
    );

    const status = tracker.getStatus("ins-ratio-test");
    expect(status?.status).toBe("evolving");
    expect(status?.re_eval_reason).toBe("source_deleted");
  });

  test("sets insight to degraded when ratio < 0.5", async () => {
    // Insight with 3 sources, delete 2 → 1/3 = 0.33 < 0.5 → degraded
    const insightPath = join(tempDir, "insights", "ins-degrade.md");
    await Bun.write(
      insightPath,
      makeInsightContent("ins-degrade", ["mem-001", "mem-002", "mem-003"]),
    );
    memoryIndex.set("ins-degrade", insightPath);
    tracker.upsertMemory("ins-degrade", "insight");
    tracker.markConsolidated("ins-degrade");

    // Only mem-003 still exists
    memoryIndex.set("mem-003", join(tempDir, "notes", "mem-003.md"));

    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    // Delete mem-001 (mem-002 is also gone from index)
    await handlers.onMemoryDeleted(
      makeEvent({
        id: "mem-001",
        frontmatter: {
          type: "note",
          insight_refs: '["ins-degrade"]',
        },
      }),
    );

    const status = tracker.getStatus("ins-degrade");
    expect(status?.status).toBe("degraded");
  });

  test("sets insight to retired when ratio = 0", async () => {
    // Insight with 2 sources, delete 1 and the other is also gone → 0/2 = 0 → retired
    const insightPath = join(tempDir, "insights", "ins-retire.md");
    await Bun.write(
      insightPath,
      makeInsightContent("ins-retire", ["mem-001", "mem-002"]),
    );
    memoryIndex.set("ins-retire", insightPath);
    tracker.upsertMemory("ins-retire", "insight");
    tracker.markConsolidated("ins-retire");

    // Neither mem-002 exists in the index
    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    await handlers.onMemoryDeleted(
      makeEvent({
        id: "mem-001",
        frontmatter: {
          type: "note",
          insight_refs: '["ins-retire"]',
        },
      }),
    );

    const status = tracker.getStatus("ins-retire");
    expect(status?.status).toBe("retired");
  });

  test("handles insight_refs as array (not string)", async () => {
    const insightPath = join(tempDir, "insights", "ins-array-ref.md");
    await Bun.write(
      insightPath,
      makeInsightContent("ins-array-ref", ["mem-001"]),
    );
    memoryIndex.set("ins-array-ref", insightPath);
    tracker.upsertMemory("ins-array-ref", "insight");
    tracker.markConsolidated("ins-array-ref");

    const handlers = createConsolidationEventHandlers(
      tracker,
      mockQmdSearch(),
      memoryIndex,
    );

    await handlers.onMemoryDeleted(
      makeEvent({
        id: "mem-001",
        frontmatter: {
          type: "note",
          insight_refs: ["ins-array-ref"], // Array format
        },
      }),
    );

    const status = tracker.getStatus("ins-array-ref");
    expect(status?.status).toBe("retired");
  });
});

// ─── onMemoryUpdated Tests ──────────────────────────────────────────

describe("onMemoryUpdated", () => {
  test("treats update as delete + index in sequence", async () => {
    const qmdSearch = mockQmdSearch();
    const handlers = createConsolidationEventHandlers(
      tracker,
      qmdSearch,
      memoryIndex,
    );

    await handlers.onMemoryUpdated(
      makeEvent({
        id: "mem-updated-001",
        frontmatter: { type: "note", title: "Updated Memory" },
      }),
    );

    // Should have upserted the memory into tracker
    const status = tracker.getStatus("mem-updated-001");
    expect(status).not.toBeNull();
    expect(status?.status).toBe("pending");
  });
});

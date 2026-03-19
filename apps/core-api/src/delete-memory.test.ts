import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deleteMemoryById, removeInsightRefFromSource } from "./delete-memory";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { ConsolidationTracker } from "./consolidation-tracker";

let tempDir: string;
let db: Database;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;
let eventDispatcher: EventDispatcher;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-delete-test-"));
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });
  db = new Database(join(tempDir, `test-${Date.now()}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  tracker = new ConsolidationTracker(db);
  memoryIndex = new MemoryIndex();
  eventDispatcher = new EventDispatcher();
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── removeInsightRefFromSource: single-pass I/O ─────────────────────

describe("removeInsightRefFromSource", () => {
  test("strips insight_refs entry and consolidated_at when refs become empty", async () => {
    const filePath = join(tempDir, "notes", "source.md");
    await writeFile(filePath, [
      "---",
      "id: mem-001",
      "type: note",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: test",
      "tags: [\"test\"]",
      "consolidated_at: 2026-03-16T00:00:00Z",
      "insight_refs: [\"ins-001\"]",
      "---",
      "",
      "# Content",
    ].join("\n"), "utf-8");

    const result = await removeInsightRefFromSource(filePath, "ins-001");
    expect(result.refsEmpty).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).not.toContain("consolidated_at");
    expect(content).toContain("insight_refs: []");
    // Other fields preserved
    expect(content).toContain("id: mem-001");
    expect(content).toContain("type: note");
    expect(content).toContain("# Content");
  });

  test("removes only the target ref when multiple refs exist, preserves consolidated_at", async () => {
    const filePath = join(tempDir, "notes", "source.md");
    await writeFile(filePath, [
      "---",
      "id: mem-001",
      "type: note",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: test",
      "tags: [\"test\"]",
      "consolidated_at: 2026-03-16T00:00:00Z",
      "insight_refs: [\"ins-001\", \"ins-002\"]",
      "---",
      "",
      "# Content",
    ].join("\n"), "utf-8");

    const result = await removeInsightRefFromSource(filePath, "ins-001");
    expect(result.refsEmpty).toBe(false);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("consolidated_at: 2026-03-16T00:00:00Z");
    expect(content).toContain("insight_refs: [\"ins-002\"]");
    expect(content).not.toContain("ins-001");
  });

  test("returns refsEmpty: false when source file does not exist", async () => {
    const result = await removeInsightRefFromSource("/nonexistent/file.md", "ins-001");
    expect(result.refsEmpty).toBe(false);
  });

  test("handles consolidated_at appearing before insight_refs in frontmatter", async () => {
    const filePath = join(tempDir, "notes", "source.md");
    await writeFile(filePath, [
      "---",
      "id: mem-001",
      "consolidated_at: 2026-03-16T00:00:00Z",
      "type: note",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: test",
      "tags: [\"test\"]",
      "insight_refs: [\"ins-001\"]",
      "---",
      "",
      "# Content",
    ].join("\n"), "utf-8");

    const result = await removeInsightRefFromSource(filePath, "ins-001");
    expect(result.refsEmpty).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).not.toContain("consolidated_at");
    expect(content).toContain("insight_refs: []");
    // Other fields remain intact
    expect(content).toContain("type: note");
  });
});

// ─── ConsolidationTracker.resetToPending ─────────────────────────────

describe("ConsolidationTracker.resetToPending", () => {
  test("resets active memory to pending, clears all consolidation fields", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");
    // Also simulate some attempts
    tracker.markFailed("mem-1");

    const before = tracker.getStatus("mem-1");
    expect(before!.consolidated_at).not.toBeNull();
    expect(before!.synthesis_attempts).toBeGreaterThan(0);

    tracker.resetToPending("mem-1");

    const after = tracker.getStatus("mem-1");
    expect(after!.status).toBe("pending");
    expect(after!.consolidated_at).toBeNull();
    expect(after!.synthesis_attempts).toBe(0);
    expect(after!.last_attempted_at).toBeNull();
    expect(after!.re_eval_reason).toBeNull();
  });

  test("no-op for non-existent memory", () => {
    // Should not throw
    tracker.resetToPending("nonexistent");
    expect(tracker.getStatus("nonexistent")).toBeNull();
  });
});

// ─── deleteMemoryById with source restoration ────────────────────────

describe("deleteMemoryById", () => {
  function makeSourceFile(id: string, insightRefs: string[]) {
    const refsStr = insightRefs.map(r => `"${r}"`).join(", ");
    return [
      "---",
      `id: ${id}`,
      "type: note",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: test",
      "tags: [\"test\"]",
      "consolidated_at: 2026-03-16T00:00:00Z",
      `insight_refs: [${refsStr}]`,
      "---",
      "",
      "# Content",
    ].join("\n");
  }

  function makeInsightFile(id: string, sourceIds: string[]) {
    const srcStr = sourceIds.map(s => `"${s}"`).join(", ");
    return [
      "---",
      `id: ${id}`,
      "type: insight",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: kore_synthesis",
      "tags: [\"test\"]",
      `source_ids: [${srcStr}]`,
      "---",
      "",
      "# Insight",
    ].join("\n");
  }

  test("returns { deleted: true, restoredSources } with correct count", async () => {
    // Set up two source memories referenced by one insight
    const src1Path = join(tempDir, "notes", "src1.md");
    const src2Path = join(tempDir, "notes", "src2.md");
    const insightPath = join(tempDir, "insights", "ins-001.md");

    await writeFile(src1Path, makeSourceFile("mem-001", ["ins-001"]), "utf-8");
    await writeFile(src2Path, makeSourceFile("mem-002", ["ins-001"]), "utf-8");
    await writeFile(insightPath, makeInsightFile("ins-001", ["mem-001", "mem-002"]), "utf-8");

    memoryIndex.set("mem-001", src1Path);
    memoryIndex.set("mem-002", src2Path);
    memoryIndex.set("ins-001", insightPath);

    tracker.upsertMemory("mem-001", "note");
    tracker.markConsolidated("mem-001");
    tracker.upsertMemory("mem-002", "note");
    tracker.markConsolidated("mem-002");

    const result = await deleteMemoryById("ins-001", {
      memoryIndex,
      eventDispatcher,
      consolidationTracker: tracker,
    });

    expect(result.deleted).toBe(true);
    expect(result.restoredSources).toBe(2);

    // Tracker should show both sources as pending
    expect(tracker.getStatus("mem-001")!.status).toBe("pending");
    expect(tracker.getStatus("mem-002")!.status).toBe("pending");

    // Source files should have consolidated_at stripped
    const src1Content = await readFile(src1Path, "utf-8");
    expect(src1Content).not.toContain("consolidated_at");
    const src2Content = await readFile(src2Path, "utf-8");
    expect(src2Content).not.toContain("consolidated_at");
  });

  test("multi-insight source: only resets to pending when ALL refs removed", async () => {
    const srcPath = join(tempDir, "notes", "src1.md");
    const insightPath = join(tempDir, "insights", "ins-001.md");

    // Source referenced by TWO insights — deleting one should NOT reset it
    await writeFile(srcPath, makeSourceFile("mem-001", ["ins-001", "ins-002"]), "utf-8");
    await writeFile(insightPath, makeInsightFile("ins-001", ["mem-001"]), "utf-8");

    memoryIndex.set("mem-001", srcPath);
    memoryIndex.set("ins-001", insightPath);

    tracker.upsertMemory("mem-001", "note");
    tracker.markConsolidated("mem-001");

    const result = await deleteMemoryById("ins-001", {
      memoryIndex,
      eventDispatcher,
      consolidationTracker: tracker,
    });

    expect(result.deleted).toBe(true);
    expect(result.restoredSources).toBe(0);

    // Source should still be active — not reset
    expect(tracker.getStatus("mem-001")!.status).toBe("active");

    // consolidated_at should still be present
    const content = await readFile(srcPath, "utf-8");
    expect(content).toContain("consolidated_at");
    expect(content).toContain("ins-002");
  });

  test("returns { deleted: false, restoredSources: 0 } for unknown id", async () => {
    const result = await deleteMemoryById("nonexistent", {
      memoryIndex,
      eventDispatcher,
    });
    expect(result.deleted).toBe(false);
    expect(result.restoredSources).toBe(0);
  });

  test("works without consolidationTracker (backward compat)", async () => {
    const filePath = join(tempDir, "notes", "simple.md");
    await writeFile(filePath, [
      "---",
      "id: mem-simple",
      "type: note",
      "category: qmd://tech/test",
      "date_saved: 2026-03-15T00:00:00Z",
      "source: test",
      "tags: [\"test\"]",
      "---",
      "",
      "# Simple",
    ].join("\n"), "utf-8");
    memoryIndex.set("mem-simple", filePath);

    const result = await deleteMemoryById("mem-simple", {
      memoryIndex,
      eventDispatcher,
    });

    expect(result.deleted).toBe(true);
    expect(result.restoredSources).toBe(0);
  });
});

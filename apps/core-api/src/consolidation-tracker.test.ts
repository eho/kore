import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ConsolidationTracker } from "./consolidation-tracker";
import {
  InsightFrontmatterSchema,
  InsightOutputSchema,
  InsightTypeEnum,
  InsightStatusEnum,
  BaseFrontmatterSchema,
} from "@kore/shared-types";

// ─── Zod Schema Tests ─────────────────────────────────────────────────

describe("InsightFrontmatterSchema", () => {
  const validInsight = {
    id: "ins-abc12345",
    type: "insight" as const,
    category: "qmd://tech/programming/react",
    date_saved: "2026-03-14T02:00:00Z",
    source: "kore_synthesis" as const,
    tags: ["react", "state-management"],
    insight_type: "evolution" as const,
    source_ids: ["abc-123", "def-456"],
    supersedes: [],
    superseded_by: [],
    confidence: 0.82,
    status: "active" as const,
    reinforcement_count: 0,
    re_eval_reason: null,
    last_synthesized_at: "2026-03-14T02:00:00Z",
  };

  test("accepts valid insight frontmatter", () => {
    const result = InsightFrontmatterSchema.safeParse(validInsight);
    expect(result.success).toBe(true);
  });

  test("applies defaults for status, reinforcement_count, re_eval_reason", () => {
    const { status, reinforcement_count, re_eval_reason, ...minimal } = validInsight;
    const result = InsightFrontmatterSchema.parse(minimal);
    expect(result.status).toBe("active");
    expect(result.reinforcement_count).toBe(0);
    expect(result.re_eval_reason).toBeNull();
  });

  test("rejects invalid type (must be literal 'insight')", () => {
    const result = InsightFrontmatterSchema.safeParse({ ...validInsight, type: "note" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid source (must be literal 'kore_synthesis')", () => {
    const result = InsightFrontmatterSchema.safeParse({ ...validInsight, source: "apple_notes" });
    expect(result.success).toBe(false);
  });

  test("rejects confidence out of range", () => {
    expect(InsightFrontmatterSchema.safeParse({ ...validInsight, confidence: 1.5 }).success).toBe(false);
    expect(InsightFrontmatterSchema.safeParse({ ...validInsight, confidence: -0.1 }).success).toBe(false);
  });

  test("rejects invalid insight_type", () => {
    const result = InsightFrontmatterSchema.safeParse({ ...validInsight, insight_type: "unknown" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid status", () => {
    const result = InsightFrontmatterSchema.safeParse({ ...validInsight, status: "unknown" });
    expect(result.success).toBe(false);
  });

  test("rejects more than 5 tags", () => {
    const result = InsightFrontmatterSchema.safeParse({
      ...validInsight,
      tags: ["a", "b", "c", "d", "e", "f"],
    });
    expect(result.success).toBe(false);
  });
});

describe("InsightOutputSchema", () => {
  const validOutput = {
    title: "React State Management Evolution",
    insight_type: "evolution" as const,
    synthesis: "Over time, the user has shifted from Redux to Zustand for state management.",
    connections: [
      { source_id: "abc-123", target_id: "def-456", relationship: "evolved_from" },
    ],
    distilled_items: ["User prefers Zustand over Redux", "Migration happened in Q1 2026"],
    tags: ["react", "state-management"],
  };

  test("accepts valid output", () => {
    const result = InsightOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  test("rejects empty distilled_items", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, distilled_items: [] });
    expect(result.success).toBe(false);
  });

  test("rejects more than 7 distilled_items", () => {
    const result = InsightOutputSchema.safeParse({
      ...validOutput,
      distilled_items: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty tags", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, tags: [] });
    expect(result.success).toBe(false);
  });

  test("rejects more than 5 tags", () => {
    const result = InsightOutputSchema.safeParse({
      ...validOutput,
      tags: ["a", "b", "c", "d", "e", "f"],
    });
    expect(result.success).toBe(false);
  });

  test("allows contradiction insight_type from LLM override", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, insight_type: "contradiction" });
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    expect(InsightOutputSchema.safeParse({ title: "x" }).success).toBe(false);
    expect(InsightOutputSchema.safeParse({}).success).toBe(false);
  });
});

describe("InsightTypeEnum", () => {
  test("accepts all valid types", () => {
    for (const t of ["cluster_summary", "evolution", "contradiction", "connection"]) {
      expect(InsightTypeEnum.safeParse(t).success).toBe(true);
    }
  });

  test("rejects invalid type", () => {
    expect(InsightTypeEnum.safeParse("unknown").success).toBe(false);
  });
});

describe("InsightStatusEnum", () => {
  test("accepts all valid statuses", () => {
    for (const s of ["active", "evolving", "degraded", "retired", "failed"]) {
      expect(InsightStatusEnum.safeParse(s).success).toBe(true);
    }
  });
});

describe("BaseFrontmatterSchema consolidation extensions", () => {
  const validBase = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    type: "note" as const,
    category: "qmd://tech/programming",
    date_saved: "2026-03-14T02:00:00Z",
    source: "apple_notes",
    tags: ["react"],
  };

  test("accepts consolidated_at and insight_refs", () => {
    const result = BaseFrontmatterSchema.safeParse({
      ...validBase,
      consolidated_at: "2026-03-15T00:00:00Z",
      insight_refs: ["ins-abc12345"],
    });
    expect(result.success).toBe(true);
  });

  test("consolidated_at and insight_refs are optional", () => {
    const result = BaseFrontmatterSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});

// ─── ConsolidationTracker Tests ───────────────────────────────────────

let tempDir: string;
let db: Database;
let tracker: ConsolidationTracker;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-tracker-test-"));
  db = new Database(join(tempDir, `tracker-${Date.now()}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  tracker = new ConsolidationTracker(db);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("upsertMemory", () => {
  test("inserts a new memory with pending status", () => {
    tracker.upsertMemory("mem-1", "note");
    const row = tracker.getStatus("mem-1");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.memory_type).toBe("note");
    expect(row!.synthesis_attempts).toBe(0);
    expect(row!.consolidated_at).toBeNull();
  });

  test("is idempotent — does not overwrite existing row", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");
    tracker.upsertMemory("mem-1", "note"); // should be no-op
    const row = tracker.getStatus("mem-1");
    expect(row!.status).toBe("active");
  });
});

describe("markConsolidated", () => {
  test("sets status to active and consolidated_at", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");
    const row = tracker.getStatus("mem-1");
    expect(row!.status).toBe("active");
    expect(row!.consolidated_at).not.toBeNull();
  });
});

describe("markCooledDown", () => {
  test("sets consolidated_at without touching status or synthesis_attempts", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markCooledDown("mem-1");
    const row = tracker.getStatus("mem-1");
    expect(row!.status).toBe("pending");
    expect(row!.synthesis_attempts).toBe(0);
    expect(row!.consolidated_at).not.toBeNull();
    expect(row!.last_attempted_at).not.toBeNull();
  });

  test("cooled-down seed is excluded by selectSeed until cooldown expires", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markCooledDown("mem-1");

    // With a large cooldown the seed should not be selected
    const result = tracker.selectSeed(999);
    expect(result).toBeNull();
  });
});

describe("markFailed", () => {
  test("increments synthesis_attempts", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markFailed("mem-1");
    const row = tracker.getStatus("mem-1");
    expect(row!.synthesis_attempts).toBe(1);
    expect(row!.status).toBe("pending"); // not yet at max
  });

  test("sets status to failed after reaching maxSynthesisAttempts", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markFailed("mem-1", 3);
    tracker.markFailed("mem-1", 3);
    tracker.markFailed("mem-1", 3);
    const row = tracker.getStatus("mem-1");
    expect(row!.synthesis_attempts).toBe(3);
    expect(row!.status).toBe("failed");
  });

  test("sets last_attempted_at", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markFailed("mem-1");
    const row = tracker.getStatus("mem-1");
    expect(row!.last_attempted_at).not.toBeNull();
  });
});

describe("markEvolving", () => {
  test("sets status and reason", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markEvolving("ins-1", "new_evidence");
    const row = tracker.getStatus("ins-1");
    expect(row!.status).toBe("evolving");
    expect(row!.re_eval_reason).toBe("new_evidence");
  });
});

describe("markDegraded", () => {
  test("sets status to degraded", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markDegraded("ins-1");
    expect(tracker.getStatus("ins-1")!.status).toBe("degraded");
  });
});

describe("markRetired", () => {
  test("sets status to retired", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markRetired("ins-1");
    expect(tracker.getStatus("ins-1")!.status).toBe("retired");
  });
});

describe("selectSeed", () => {
  test("returns re-eval seed (evolving insight) before pending memories", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.upsertMemory("ins-1", "insight");
    tracker.markEvolving("ins-1", "new_evidence");

    const result = tracker.selectSeed();
    expect(result).not.toBeNull();
    expect(result!.memoryId).toBe("ins-1");
    expect(result!.isReeval).toBe(true);
  });

  test("returns degraded insight as re-eval seed", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markDegraded("ins-1");

    const result = tracker.selectSeed();
    expect(result).not.toBeNull();
    expect(result!.memoryId).toBe("ins-1");
    expect(result!.isReeval).toBe(true);
  });

  test("returns pending non-insight memory when no re-eval work", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.upsertMemory("mem-2", "place");

    const result = tracker.selectSeed();
    expect(result).not.toBeNull();
    expect(result!.isReeval).toBe(false);
  });

  test("returns null when no seeds available", () => {
    const result = tracker.selectSeed();
    expect(result).toBeNull();
  });

  test("skips failed memories", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markFailed("mem-1", 1); // will fail on first attempt

    const result = tracker.selectSeed(7, 1); // maxAttempts=1
    expect(result).toBeNull();
  });

  test("skips retired memories", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markRetired("mem-1");

    const result = tracker.selectSeed();
    expect(result).toBeNull();
  });

  test("respects cooldown window for previously consolidated memories", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");

    // With a very large cooldown, the recently consolidated memory should not be selected
    const result = tracker.selectSeed(999);
    expect(result).toBeNull();
  });

  test("selects never-consolidated before previously consolidated", () => {
    tracker.upsertMemory("mem-old", "note");
    tracker.markConsolidated("mem-old");

    // Set consolidated_at far in the past so cooldown is satisfied
    db.run(
      `UPDATE consolidation_tracker SET consolidated_at = datetime('now', '-30 days') WHERE memory_id = 'mem-old'`
    );

    tracker.upsertMemory("mem-new", "note");

    const result = tracker.selectSeed(7);
    expect(result).not.toBeNull();
    expect(result!.memoryId).toBe("mem-new"); // never-consolidated first
  });

  test("skips re-eval insights that exceeded maxSynthesisAttempts", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markEvolving("ins-1", "new_evidence");
    // Exhaust attempts
    tracker.markFailed("ins-1", 3);
    tracker.markFailed("ins-1", 3);
    tracker.markFailed("ins-1", 3);

    // ins-1 is now 'failed', not in re-eval queue
    tracker.upsertMemory("mem-1", "note");
    const result = tracker.selectSeed();
    expect(result).not.toBeNull();
    expect(result!.memoryId).toBe("mem-1");
    expect(result!.isReeval).toBe(false);
  });
});

describe("resetFailed", () => {
  test("resets all failed rows to pending with zero attempts", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.upsertMemory("mem-2", "note");
    // Fail both until they reach 'failed' status
    for (let i = 0; i < 3; i++) {
      tracker.markFailed("mem-1", 3);
      tracker.markFailed("mem-2", 3);
    }
    expect(tracker.getStatus("mem-1")!.status).toBe("failed");
    expect(tracker.getStatus("mem-2")!.status).toBe("failed");

    tracker.resetFailed();

    expect(tracker.getStatus("mem-1")!.status).toBe("pending");
    expect(tracker.getStatus("mem-1")!.synthesis_attempts).toBe(0);
    expect(tracker.getStatus("mem-2")!.status).toBe("pending");
    expect(tracker.getStatus("mem-2")!.synthesis_attempts).toBe(0);
  });

  test("does not affect non-failed rows", () => {
    tracker.upsertMemory("mem-ok", "note");
    tracker.markConsolidated("mem-ok");
    tracker.upsertMemory("mem-fail", "note");
    for (let i = 0; i < 3; i++) tracker.markFailed("mem-fail", 3);

    tracker.resetFailed();

    expect(tracker.getStatus("mem-ok")!.status).toBe("active");
    expect(tracker.getStatus("mem-fail")!.status).toBe("pending");
  });
});

describe("resetToPending", () => {
  test("resets active memory to pending, clears all consolidation fields", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");

    tracker.resetToPending("mem-1");

    const row = tracker.getStatus("mem-1");
    expect(row!.status).toBe("pending");
    expect(row!.consolidated_at).toBeNull();
    expect(row!.synthesis_attempts).toBe(0);
    expect(row!.last_attempted_at).toBeNull();
    expect(row!.re_eval_reason).toBeNull();
  });

  test("clears re_eval_reason from evolving state", () => {
    tracker.upsertMemory("ins-1", "insight");
    tracker.markEvolving("ins-1", "new_evidence");

    tracker.resetToPending("ins-1");

    const row = tracker.getStatus("ins-1");
    expect(row!.status).toBe("pending");
    expect(row!.re_eval_reason).toBeNull();
  });

  test("no-op for non-existent memory", () => {
    tracker.resetToPending("nonexistent");
    expect(tracker.getStatus("nonexistent")).toBeNull();
  });

  test("makes memory selectable as seed again", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.markConsolidated("mem-1");

    // Active memory with recent consolidated_at — not selectable
    const before = tracker.selectSeed(999);
    expect(before).toBeNull();

    tracker.resetToPending("mem-1");

    // Now pending with no consolidated_at — should be selectable
    const after = tracker.selectSeed();
    expect(after).not.toBeNull();
    expect(after!.memoryId).toBe("mem-1");
  });
});

describe("truncateAll", () => {
  test("deletes all rows", () => {
    tracker.upsertMemory("mem-1", "note");
    tracker.upsertMemory("mem-2", "place");
    tracker.truncateAll();
    expect(tracker.getStatus("mem-1")).toBeNull();
    expect(tracker.getStatus("mem-2")).toBeNull();
  });
});

describe("getStatus", () => {
  test("returns null for non-existent id", () => {
    expect(tracker.getStatus("nonexistent")).toBeNull();
  });

  test("returns full row", () => {
    tracker.upsertMemory("mem-1", "note");
    const row = tracker.getStatus("mem-1");
    expect(row).toMatchObject({
      memory_id: "mem-1",
      memory_type: "note",
      status: "pending",
      synthesis_attempts: 0,
    });
  });
});

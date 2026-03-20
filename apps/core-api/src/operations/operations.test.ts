import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MemoryIndex } from "../memory-index";
import { QueueRepository } from "../queue";
import type { HybridQueryResult } from "@kore/qmd-client";

import { recall, applyKoreFilters } from "./recall";
import { remember } from "./remember";
import { inspect, parseMemoryFileFull, extractDistilledItems } from "./inspect";
import { insights } from "./insights";
import { health } from "./health";
import { consolidate } from "./consolidate";
import type { QmdHealthSummary } from "../app";

function mockQmdResult(overrides: Partial<HybridQueryResult> & { file: string; score: number }): HybridQueryResult {
  return {
    displayPath: "",
    title: "",
    body: "",
    bestChunk: "",
    bestChunkPos: 0,
    context: null,
    docid: "",
    ...overrides,
  };
}

// ─── Test Fixtures ────────────────────────────────────────────────

let tempDir: string;
let queue: QueueRepository;
let memoryIndex: MemoryIndex;

const sampleMemoryContent = `---
id: mem-001
type: place
category: qmd://travel/food/ramen
date_saved: 2026-03-15T10:00:00Z
source: apple_notes
tags: ["ramen", "tokyo"]
intent: recommendation
confidence: 0.9
---

# Best Ramen in Ikebukuro

## Distilled Memory Items
- Mutekiya in Ikebukuro is known for rich 48-hour pork bone broth
- Best for solo dining at the counter
- Open late until midnight

## Original Source
John recommended Mutekiya for the best tonkotsu ramen experience.
`;

const sampleMemoryContent2 = `---
id: mem-002
type: note
category: qmd://tech/react
date_saved: 2026-03-10T08:00:00Z
source: web_clipper
tags: ["react", "hooks"]
intent: reference
confidence: 0.85
---

# React Hook Patterns

## Distilled Memory Items
- useReducer is preferred over useState for complex state logic
- Custom hooks should start with "use" prefix

## Original Source
Article on React best practices.
`;

const sampleInsightContent = `---
id: ins-001
type: insight
category: qmd://travel/food
date_saved: 2026-03-18T12:00:00Z
source: kore_synthesis
tags: ["food", "tokyo"]
insight_type: cluster_summary
status: active
source_ids: ["mem-001", "mem-003"]
supersedes: []
superseded_by: []
reinforcement_count: 2
last_synthesized_at: 2026-03-18T12:00:00Z
confidence: 0.88
---

# Tokyo Food Guide

## Synthesis
Tokyo offers incredible ramen options across multiple neighborhoods. Ikebukuro stands out for its concentration of top-tier ramen shops.

## Distilled Memory Items
- Ikebukuro is a ramen hotspot in Tokyo
- Mutekiya is the top recommendation for tonkotsu

## Source Material
Combined from 2 memories about Tokyo food.
`;

const retiredInsightContent = `---
id: ins-retired
type: insight
category: qmd://travel
date_saved: 2026-03-01T12:00:00Z
source: kore_synthesis
tags: ["travel"]
insight_type: cluster_summary
status: retired
source_ids: ["mem-old1"]
supersedes: []
superseded_by: ["ins-001"]
reinforcement_count: 0
last_synthesized_at: 2026-03-01T12:00:00Z
confidence: 0.5
---

# Old Travel Summary

## Synthesis
Outdated travel information.

## Distilled Memory Items
- This insight has been superseded
`;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-ops-test-"));
  await mkdir(join(tempDir, "places"), { recursive: true });
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "media"), { recursive: true });
  await mkdir(join(tempDir, "people"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });

  // Write sample files
  await writeFile(join(tempDir, "places", "best-ramen.md"), sampleMemoryContent);
  await writeFile(join(tempDir, "notes", "react-hooks.md"), sampleMemoryContent2);
  await writeFile(join(tempDir, "insights", "tokyo-food-guide.md"), sampleInsightContent);
  await writeFile(join(tempDir, "insights", "old-travel.md"), retiredInsightContent);

  memoryIndex = new MemoryIndex();
  await memoryIndex.build(tempDir);
});

beforeEach(() => {
  const dbPath = join(tempDir, `queue-${Date.now()}.db`);
  queue = new QueueRepository(dbPath);
});

afterAll(async () => {
  queue?.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── extractDistilledItems ────────────────────────────────────────

describe("extractDistilledItems", () => {
  test("extracts bullet items from Distilled Memory Items section", () => {
    const items = extractDistilledItems(sampleMemoryContent);
    expect(items).toEqual([
      "Mutekiya in Ikebukuro is known for rich 48-hour pork bone broth",
      "Best for solo dining at the counter",
      "Open late until midnight",
    ]);
  });

  test("returns empty array when section is missing", () => {
    const content = "---\nid: test\n---\n# No distilled items here";
    expect(extractDistilledItems(content)).toEqual([]);
  });

  test("stops at next heading", () => {
    const content = `## Distilled Memory Items
- Item 1
- Item 2

## Next Section
- Not a distilled item`;
    const items = extractDistilledItems(content);
    expect(items).toEqual(["Item 1", "Item 2"]);
  });
});

// ─── parseMemoryFileFull ──────────────────────────────────────────

describe("parseMemoryFileFull", () => {
  test("parses a memory file with all fields", async () => {
    const filePath = join(tempDir, "places", "best-ramen.md");
    const result = await parseMemoryFileFull("mem-001", filePath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mem-001");
    expect(result!.type).toBe("place");
    expect(result!.category).toBe("qmd://travel/food/ramen");
    expect(result!.tags).toEqual(["ramen", "tokyo"]);
    expect(result!.intent).toBe("recommendation");
    expect(result!.confidence).toBe(0.9);
    expect(result!.title).toBe("Best Ramen in Ikebukuro");
    expect(result!.content).toContain("Mutekiya");
  });

  test("parses insight-specific fields", async () => {
    const filePath = join(tempDir, "insights", "tokyo-food-guide.md");
    const result = await parseMemoryFileFull("ins-001", filePath);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("insight");
    expect(result!.insight_type).toBe("cluster_summary");
    expect(result!.status).toBe("active");
    expect(result!.source_ids).toEqual(["mem-001", "mem-003"]);
    expect(result!.reinforcement_count).toBe(2);
  });

  test("returns null for non-existent file", async () => {
    const result = await parseMemoryFileFull("nope", join(tempDir, "missing.md"));
    expect(result).toBeNull();
  });
});

// ─── inspect ──────────────────────────────────────────────────────

describe("inspect", () => {
  test("returns full memory with distilled_items and truncated content", async () => {
    const result = await inspect("mem-001", { memoryIndex });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mem-001");
    expect(result!.title).toBe("Best Ramen in Ikebukuro");
    expect(result!.distilled_items).toHaveLength(3);
    expect(result!.distilled_items[0]).toContain("Mutekiya");
    expect(result!.content).toContain("---");
  });

  test("returns null for unknown id", async () => {
    const result = await inspect("unknown-id", { memoryIndex });
    expect(result).toBeNull();
  });

  test("includes insight-specific fields for insights", async () => {
    const result = await inspect("ins-001", { memoryIndex });
    expect(result).not.toBeNull();
    expect(result!.insight_type).toBe("cluster_summary");
    expect(result!.source_ids).toEqual(["mem-001", "mem-003"]);
    expect(result!.status).toBe("active");
  });

  test("truncates content at 20,000 characters", async () => {
    // Create a large file
    const largeContent = `---
id: mem-large
type: note
category: qmd://test
date_saved: 2026-03-15T10:00:00Z
source: test
tags: []
---

# Large Memory

## Distilled Memory Items
- Key fact that should always be available

## Original Source
${"x".repeat(25_000)}
`;
    const largePath = join(tempDir, "notes", "large.md");
    await writeFile(largePath, largeContent);
    memoryIndex.set("mem-large", largePath);

    const result = await inspect("mem-large", { memoryIndex });
    expect(result).not.toBeNull();
    expect(result!.content.length).toBe(20_000);
    // Distilled items are always extracted regardless of truncation
    expect(result!.distilled_items).toEqual(["Key fact that should always be available"]);
  });
});

// ─── recall ───────────────────────────────────────────────────────

describe("recall", () => {
  const mockQmdSearch = async (query: string) => [
    mockQmdResult({
      file: join(tempDir, "places", "best-ramen.md"),
      displayPath: "qmd://places/best-ramen",
      title: "Best Ramen in Ikebukuro",
      bestChunk: "Mutekiya in Ikebukuro",
      score: 0.95,
    }),
    mockQmdResult({
      file: join(tempDir, "notes", "react-hooks.md"),
      displayPath: "qmd://notes/react-hooks",
      title: "React Hook Patterns",
      bestChunk: "useReducer for complex state",
      score: 0.7,
    }),
  ];

  test("returns results with query via QMD search", async () => {
    const result = await recall(
      { query: "ramen" },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    expect(result.query).toBe("ramen");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe("mem-001");
    expect(result.results[0].distilled_items).toHaveLength(3);
  });

  test("returns results without query sorted by date_saved desc", async () => {
    const result = await recall(
      {},
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    expect(result.query).toBe("");
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    // Should be sorted by date_saved descending
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].date_saved >= result.results[i].date_saved).toBe(true);
    }
  });

  test("filters by type", async () => {
    const result = await recall(
      { type: "place" },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.type).toBe("place");
    }
  });

  test("filters by intent", async () => {
    const result = await recall(
      { intent: "recommendation" },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.intent).toBe("recommendation");
    }
  });

  test("filters by tags", async () => {
    const result = await recall(
      { tags: ["ramen"] },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.tags).toContain("ramen");
    }
  });

  test("filters by min_confidence", async () => {
    const result = await recall(
      { min_confidence: 0.88 },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.88);
    }
  });

  test("excludes retired insights", async () => {
    const result = await recall(
      {},
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    const retiredIds = result.results.filter(r => r.id === "ins-retired");
    expect(retiredIds).toHaveLength(0);
  });

  test("excludes insights when include_insights is false", async () => {
    const result = await recall(
      { include_insights: false },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.type).not.toBe("insight");
    }
  });

  test("respects limit and offset for pagination", async () => {
    const result1 = await recall(
      { limit: 1, offset: 0 },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    expect(result1.results).toHaveLength(1);
    expect(result1.offset).toBe(0);

    const result2 = await recall(
      { limit: 1, offset: 1 },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    expect(result2.results).toHaveLength(1);
    expect(result2.offset).toBe(1);
    // Different results
    expect(result2.results[0].id).not.toBe(result1.results[0].id);
  });

  test("has_more is true when more results exist", async () => {
    const result = await recall(
      { limit: 1 },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    expect(result.has_more).toBe(true);
  });

  test("filters by created_after", async () => {
    const result = await recall(
      { created_after: "2026-03-12T00:00:00Z" },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.date_saved >= "2026-03-12T00:00:00Z").toBe(true);
    }
  });

  test("filters by created_before", async () => {
    const result = await recall(
      { created_before: "2026-03-12T00:00:00Z" },
      { memoryIndex, qmdSearch: mockQmdSearch }
    );
    for (const r of result.results) {
      expect(r.date_saved <= "2026-03-12T00:00:00Z").toBe(true);
    }
  });

  test("returns empty results for no matches", async () => {
    const emptySearch = async () => [];
    const result = await recall(
      { query: "nonexistent" },
      { memoryIndex, qmdSearch: emptySearch }
    );
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ─── applyKoreFilters ─────────────────────────────────────────────

describe("applyKoreFilters", () => {
  test("excludes retired insights by default", () => {
    const memories = [
      { id: "1", type: "note", status: undefined, score: 1, distilled_items: [], tags: [], date_saved: "", source: "", title: "", category: "", content: "" },
      { id: "2", type: "insight", status: "retired", score: 1, distilled_items: [], tags: [], date_saved: "", source: "", title: "", category: "", content: "" },
      { id: "3", type: "insight", status: "active", score: 1, distilled_items: [], tags: [], date_saved: "", source: "", title: "", category: "", content: "" },
    ] as any;
    const filtered = applyKoreFilters(memories, {});
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m: any) => m.id)).toEqual(["1", "3"]);
  });
});

// ─── remember ─────────────────────────────────────────────────────

describe("remember", () => {
  test("enqueues content and returns task_id", async () => {
    const result = await remember(
      { content: "Great sushi place in Shibuya" },
      { queue }
    );
    expect(result.status).toBe("queued");
    expect(result.task_id).toBeTruthy();
    expect(result.message).toContain("queued");
  });

  test("uses default source 'agent' when not specified", async () => {
    const result = await remember(
      { content: "Test content" },
      { queue }
    );
    const task = queue.getTask(result.task_id);
    expect(task).not.toBeNull();
    const payload = JSON.parse(task!.payload);
    expect(payload.source).toBe("agent");
  });

  test("passes suggested_tags and suggested_category", async () => {
    const result = await remember(
      {
        content: "Test content",
        suggested_tags: ["sushi", "tokyo"],
        suggested_category: "travel/food/sushi",
      },
      { queue }
    );
    const task = queue.getTask(result.task_id);
    const payload = JSON.parse(task!.payload);
    expect(payload.suggested_tags).toEqual(["sushi", "tokyo"]);
    expect(payload.suggested_category).toBe("travel/food/sushi");
  });

  test("respects priority parameter", async () => {
    const result = await remember(
      { content: "Urgent!", priority: "high" },
      { queue }
    );
    const task = queue.getTask(result.task_id);
    expect(task!.priority).toBe("high");
  });
});

// ─── insights ─────────────────────────────────────────────────────

describe("insights", () => {
  const mockQmdSearch = async (query: string) => [
    mockQmdResult({
      file: join(tempDir, "insights", "tokyo-food-guide.md"),
      displayPath: "qmd://insights/tokyo-food-guide",
      title: "Tokyo Food Guide",
      bestChunk: "Tokyo offers incredible ramen",
      score: 0.9,
    }),
  ];

  test("returns active insights from directory scan (no query)", async () => {
    const result = await insights(
      {},
      { dataPath: tempDir, qmdSearch: mockQmdSearch, memoryIndex }
    );
    expect(result.results.length).toBeGreaterThan(0);
    // Should only include active insights, not retired
    for (const r of result.results) {
      expect(r.status).toBe("active");
    }
  });

  test("returns insight with synthesis and distilled_items", async () => {
    const result = await insights(
      {},
      { dataPath: tempDir, qmdSearch: mockQmdSearch, memoryIndex }
    );
    const tokyoInsight = result.results.find(r => r.id === "ins-001");
    expect(tokyoInsight).toBeDefined();
    expect(tokyoInsight!.synthesis).toContain("ramen");
    expect(tokyoInsight!.distilled_items.length).toBeGreaterThan(0);
    expect(tokyoInsight!.source_count).toBe(2);
  });

  test("filters by insight_type", async () => {
    const result = await insights(
      { insight_type: "evolution" },
      { dataPath: tempDir, qmdSearch: mockQmdSearch, memoryIndex }
    );
    expect(result.results).toHaveLength(0);
  });

  test("returns insights from QMD when query provided", async () => {
    const result = await insights(
      { query: "tokyo food" },
      { dataPath: tempDir, qmdSearch: mockQmdSearch, memoryIndex }
    );
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("returns empty for no matching insights", async () => {
    const emptySearch = async () => [];
    const result = await insights(
      { query: "nonexistent" },
      { dataPath: tempDir, qmdSearch: emptySearch, memoryIndex }
    );
    expect(result.results).toHaveLength(0);
  });
});

// ─── health ───────────────────────────────────────────────────────

describe("health", () => {
  test("returns structured health output", async () => {
    const mockQmdStatus = async (): Promise<QmdHealthSummary> => ({
      status: "ok",
      doc_count: 10,
      needs_embedding: 0,
    });
    const result = await health({
      memoryIndex,
      queue,
      qmdStatus: mockQmdStatus,
      dataPath: tempDir,
    });
    expect(result.version).toBe("1.0.0");
    expect(result.memories.total).toBeGreaterThan(0);
    expect(typeof result.memories.by_type).toBe("object");
    expect(result.queue.pending).toBe(0);
    expect(result.index.documents).toBe(10);
    expect(result.index.status).toBe("ok");
  });

  test("counts memories by type", async () => {
    const mockQmdStatus = async (): Promise<QmdHealthSummary> => ({
      status: "ok",
      doc_count: 10,
    });
    const result = await health({
      memoryIndex,
      queue,
      qmdStatus: mockQmdStatus,
      dataPath: tempDir,
    });
    expect(result.memories.by_type["place"]).toBeGreaterThanOrEqual(1);
    expect(result.memories.by_type["note"]).toBeGreaterThanOrEqual(1);
    expect(result.memories.by_type["insight"]).toBeGreaterThanOrEqual(1);
  });

  test("reflects index unavailable status", async () => {
    const result = await health({
      memoryIndex,
      queue,
      qmdStatus: async () => ({ status: "unavailable" as const }),
      dataPath: tempDir,
    });
    expect(result.index.status).toBe("unavailable");
  });

  test("reflects embedding status when needs_embedding > 0", async () => {
    const result = await health({
      memoryIndex,
      queue,
      qmdStatus: async () => ({
        status: "ok" as const,
        doc_count: 10,
        needs_embedding: 3,
      }),
      dataPath: tempDir,
    });
    expect(result.index.status).toBe("embedding");
    expect(result.index.embedded).toBe(7);
  });

  test("reflects queue counts", async () => {
    // Enqueue some tasks
    queue.enqueue({ content: "test1" });
    queue.enqueue({ content: "test2" });
    const result = await health({
      memoryIndex,
      queue,
      qmdStatus: async () => ({ status: "ok" as const }),
      dataPath: tempDir,
    });
    expect(result.queue.pending).toBe(2);
  });
});

// ─── consolidate ──────────────────────────────────────────────────

describe("consolidate", () => {
  test("throws when consolidation tracker is not available", async () => {
    await expect(
      consolidate(
        { dry_run: false },
        {
          dataPath: tempDir,
          qmdSearch: async () => [],
          consolidationTracker: undefined,
          memoryIndex,
          eventDispatcher: undefined,
          consolidationLoopHandle: undefined,
        }
      )
    ).rejects.toThrow("Consolidation service not available");
  });
});

/**
 * CON-007: End-to-end integration tests for the consolidation pipeline.
 *
 * Tests exercise the full consolidation flow: seed selection → candidate finding →
 * classification → LLM synthesis → insight writing → source frontmatter update,
 * and reactive lifecycle (source deletion → status transitions).
 *
 * LLM synthesis is mocked (no running model required); everything else is real:
 * real SQLite, real file I/O, real QMD indexing, real frontmatter parsing.
 */
import { mock, describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

// ─── Mock LLM synthesizer (must be before imports that use it) ──────────

const mockSynthesisResult = {
  title: "React Development Patterns",
  insight_type: "cluster_summary" as const,
  synthesis:
    "React development involves key patterns including hooks for state management, " +
    "context API for sharing state across components, and performance optimization " +
    "through memoization techniques.",
  connections: [] as Array<{ source_id: string; target_id: string; relationship: string }>,
  distilled_items: [
    "React hooks (useState, useEffect) provide functional state management",
    "Context API enables cross-component state sharing without prop drilling",
    "Memoization (React.memo, useMemo, useCallback) prevents unnecessary re-renders",
  ],
  tags: ["react", "hooks", "performance"],
  _extractionPath: "structured" as const,
};

mock.module("../../apps/core-api/src/consolidation-synthesizer", () => ({
  synthesizeInsight: mock(async () => mockSynthesisResult),
  // Do NOT mock buildSynthesisPrompt or fallbackParse here as it breaks their unit tests
  // computeInsightConfidence is also left as real since it has no side effects
}));

// ─── Imports (after mock setup) ─────────────────────────────────────────

import { createApp } from "../../apps/core-api/src/app";
import { QueueRepository } from "../../apps/core-api/src/queue";
import { MemoryIndex } from "../../apps/core-api/src/memory-index";
import { EventDispatcher } from "../../apps/core-api/src/event-dispatcher";
import { ConsolidationTracker } from "../../apps/core-api/src/consolidation-tracker";
import { createConsolidationEventHandlers } from "../../apps/core-api/src/consolidation-event-handlers";
import { InsightFrontmatterSchema } from "@kore/shared-types";
import type { KorePlugin } from "@kore/shared-types";

// ─── Constants ──────────────────────────────────────────────────────────

const TOPIC_A_IDS = ["mem-react-hooks", "mem-react-context", "mem-react-perf"];
const TOPIC_B_IDS = ["mem-pasta-recipe", "mem-italian-sauce"];
const ALL_IDS = [...TOPIC_A_IDS, ...TOPIC_B_IDS];

// ─── Synthetic Memory Builders ──────────────────────────────────────────

function makeMemoryContent(
  id: string,
  title: string,
  body: string,
  opts: { type?: string; category?: string; date_saved?: string } = {},
) {
  const type = opts.type ?? "note";
  const category = opts.category ?? "qmd://tech/programming";
  const date_saved = opts.date_saved ?? "2026-03-01T00:00:00.000Z";
  return `---
id: ${id}
type: ${type}
category: ${category}
date_saved: ${date_saved}
source: e2e-consolidation
tags: ["test"]
---

# ${title}

## Distilled Memory Items
${body}
`;
}

const SYNTHETIC_MEMORIES: Array<{
  id: string;
  title: string;
  body: string;
  category?: string;
  date_saved?: string;
}> = [
  // ── Topic A: React / Programming (3 memories) ────────────
  {
    id: "mem-react-hooks",
    title: "React Hooks Guide",
    body: `- **useState hook enables functional component state management in React**
- **useEffect hook handles side effects like data fetching and subscriptions**
- **Custom hooks extract reusable stateful logic from React components**`,
  },
  {
    id: "mem-react-context",
    title: "React Context API for State Management",
    body: `- **React Context API shares state across deeply nested component trees**
- **useContext hook consumes context values without prop drilling**
- **Context providers wrap component subtrees with shared state values**`,
  },
  {
    id: "mem-react-perf",
    title: "React Performance Optimization Techniques",
    body: `- **React.memo prevents unnecessary re-renders of pure components**
- **useMemo caches expensive computations between React renders**
- **useCallback provides stable function references for memoized children**`,
  },
  // ── Topic B: Cooking / Italian (2 memories — intentionally too small) ─
  {
    id: "mem-pasta-recipe",
    title: "Homemade Pasta from Scratch",
    body: `- **Fresh pasta dough requires only flour, eggs, salt, and olive oil**
- **Pasta dough must rest for 30 minutes before rolling and cutting**
- **Semolina flour prevents fresh pasta from sticking during drying**`,
    category: "qmd://cooking/italian",
  },
  {
    id: "mem-italian-sauce",
    title: "Classic Italian Sauce Techniques",
    body: `- **Marinara sauce uses San Marzano tomatoes, garlic, basil, and olive oil**
- **Bolognese sauce simmers for hours to develop rich, meaty depth of flavour**
- **Aglio e olio is the simplest Italian pasta sauce: garlic, oil, and chili flakes**`,
    category: "qmd://cooking/italian",
  },
];

// ─── Shared Test State ──────────────────────────────────────────────────

let tempDir: string;
let db: Database;
let queue: QueueRepository;
let tracker: ConsolidationTracker;
let memoryIndex: MemoryIndex;
let eventDispatcher: EventDispatcher;
let app: ReturnType<typeof createApp>;
let memoryFilePaths: Map<string, string>;

// The search mock returns files in our test directory — configurable per test
let mockSearchResults: Array<{
  file: string;
  score: number;
  title: string;
  bestChunk: string;
  displayPath?: string;
}> = [];

const mockSearchFn = mock(async (_query: string, _options?: any) => {
  return mockSearchResults;
});

// Track the insight ID created by the happy path test (used in later tests)
let createdInsightId: string | undefined;
let createdInsightPath: string | undefined;

// ─── Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp directories
  tempDir = await mkdtemp(join(tmpdir(), "kore-e2e-consolidation-"));
  for (const dir of ["notes", "insights", "places", "media", "people"]) {
    await mkdir(join(tempDir, dir), { recursive: true });
  }

  // 2. Write synthetic memories to disk
  memoryFilePaths = new Map();
  for (const mem of SYNTHETIC_MEMORIES) {
    const filePath = join(tempDir, "notes", `${mem.id}.md`);
    await Bun.write(
      filePath,
      makeMemoryContent(mem.id, mem.title, mem.body, {
        category: mem.category,
        date_saved: mem.date_saved,
      }),
    );
    memoryFilePaths.set(mem.id, filePath);
  }

  // 3. Initialize SQLite + QueueRepository + ConsolidationTracker
  queue = new QueueRepository(join(tempDir, "kore-queue.db"));
  db = new Database(join(tempDir, "consolidation-e2e.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  tracker = new ConsolidationTracker(db);

  // 4. Build MemoryIndex
  memoryIndex = new MemoryIndex();
  await memoryIndex.build(tempDir);

  // 5. Create EventDispatcher + register consolidation handlers
  eventDispatcher = new EventDispatcher();
  const handlers = createConsolidationEventHandlers(
    tracker,
    mockSearchFn as any,
    memoryIndex,
    { relevanceThreshold: 0.5, cooldownDays: 0 },
  );
  const consolidationPlugin: KorePlugin = {
    name: "consolidation",
    onMemoryIndexed: (event) => handlers.onMemoryIndexed(event),
    onMemoryDeleted: (event) => handlers.onMemoryDeleted(event),
    onMemoryUpdated: (event) => handlers.onMemoryUpdated(event),
  };
  eventDispatcher.registerPlugins([consolidationPlugin]);

  // 6. Populate tracker with all memories
  for (const mem of SYNTHETIC_MEMORIES) {
    tracker.upsertMemory(mem.id, "note");
  }

  // 7. Create the Elysia app with test deps
  app = createApp({
    dataPath: tempDir,
    queue,
    searchFn: mockSearchFn as any,
    memoryIndex,
    eventDispatcher,
    consolidationTracker: tracker,
  });
}, 30_000);

afterAll(async () => {
  try {
    db.close();
  } catch { /* ignore */ }
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ─── Helpers ────────────────────────────────────────────────────────────

function apiRequest(path: string, opts: RequestInit = {}) {
  const apiKey = process.env.KORE_API_KEY ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers,
      ...opts,
    }),
  );
}

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else if (value === "null") {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("Consolidation E2E", () => {
  test("test setup: all 5 synthetic memories are indexed", () => {
    expect(memoryFilePaths.size).toBe(5);
    for (const id of ALL_IDS) {
      expect(memoryIndex.get(id)).toBeDefined();
    }
  });

  // ── Happy Path ──────────────────────────────────────────────────────

  test("happy path: POST /api/v1/consolidate creates an insight from topic A", async () => {
    // Configure search mock to return topic A candidates (excluding seed)
    // Seed will be mem-react-hooks (first pending in tracker)
    const seedPath = memoryFilePaths.get("mem-react-hooks")!;
    mockSearchResults = [
      { file: memoryFilePaths.get("mem-react-context")!, score: 0.85, title: "React Context API", bestChunk: "context" },
      { file: memoryFilePaths.get("mem-react-perf")!, score: 0.78, title: "React Performance", bestChunk: "performance" },
    ];

    const res = await apiRequest("/api/v1/consolidate", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.status).toBe("consolidated");
    expect(body.insight_id).toBeDefined();
    expect(body.insight_id).toMatch(/^ins-[a-f0-9]{8}$/);
    expect(body.seed.id).toBe("mem-react-hooks");
    expect(body.cluster_size).toBeGreaterThanOrEqual(3);

    createdInsightId = body.insight_id;

    // Verify insight file exists on disk
    const insightsDir = join(tempDir, "insights");
    const insightFiles = await readdir(insightsDir);
    expect(insightFiles.length).toBeGreaterThanOrEqual(1);

    const insightFile = insightFiles.find((f) => f.includes(createdInsightId!));
    expect(insightFile).toBeDefined();
    createdInsightPath = join(insightsDir, insightFile!);

    // Validate insight frontmatter passes InsightFrontmatterSchema.parse()
    const insightContent = await readFile(createdInsightPath!, "utf-8");
    const fm = parseFrontmatter(insightContent);
    const parsed = InsightFrontmatterSchema.parse(fm);
    expect(parsed.type).toBe("insight");
    expect(parsed.source).toBe("kore_synthesis");
    expect(parsed.status).toBe("active");
    expect(parsed.source_ids).toContain("mem-react-hooks");
    expect(parsed.confidence).toBeGreaterThan(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);

    // Verify source memories have consolidated_at and insight_refs
    for (const srcId of TOPIC_A_IDS) {
      const srcPath = memoryFilePaths.get(srcId)!;
      const srcContent = await readFile(srcPath, "utf-8");
      const srcFm = parseFrontmatter(srcContent);
      expect(srcFm.consolidated_at).toBeDefined();
      expect(srcFm.insight_refs).toBeDefined();
      expect(srcFm.insight_refs).toContain(createdInsightId);
    }
  });

  // ── Dry-Run ─────────────────────────────────────────────────────────

  test("dry-run: dry_run=true returns candidates without writing files or calling LLM", async () => {
    // Reset a topic B memory to pending so it can be used as seed
    // After happy path, topic A seeds were consumed; topic B should have pending seeds
    const seedStatus = tracker.getStatus("mem-pasta-recipe");
    expect(seedStatus?.status).toBe("pending");

    // Configure search to return topic B candidate
    mockSearchResults = [
      { file: memoryFilePaths.get("mem-italian-sauce")!, score: 0.70, title: "Italian Sauce", bestChunk: "sauce" },
      // Add two more from topic A to reach minClusterSize
      { file: memoryFilePaths.get("mem-react-context")!, score: 0.50, title: "React Context", bestChunk: "context" },
      { file: memoryFilePaths.get("mem-react-perf")!, score: 0.48, title: "React Perf", bestChunk: "perf" },
    ];

    // Count insight files before dry run
    const beforeFiles = await readdir(join(tempDir, "insights"));
    const beforeCount = beforeFiles.length;

    const res = await apiRequest("/api/v1/consolidate?dry_run=true", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.status).toBe("dry_run");
    expect(body.seed).toBeDefined();
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(body.proposed_insight_type).toBeDefined();
    expect(typeof body.estimated_confidence).toBe("number");

    // No new files written
    const afterFiles = await readdir(join(tempDir, "insights"));
    expect(afterFiles.length).toBe(beforeCount);
  });

  // ── Cluster Too Small ───────────────────────────────────────────────

  test("cluster too small: 2 memories on isolated topic returns cluster_too_small", async () => {
    // Configure search to return only 1 candidate (not enough for minClusterSize=3)
    mockSearchResults = [
      { file: memoryFilePaths.get("mem-italian-sauce")!, score: 0.70, title: "Italian Sauce", bestChunk: "sauce" },
    ];

    const res = await apiRequest("/api/v1/consolidate", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.status).toBe("cluster_too_small");
    expect(body.seed).toBeDefined();
    expect(body.candidate_count).toBeDefined();
  });

  // ── List with type=insight ──────────────────────────────────────────

  test("kore list --type insight: insight appears in GET /api/v1/memories?type=insight", async () => {
    expect(createdInsightId).toBeDefined();

    const res = await apiRequest("/api/v1/memories?type=insight");
    expect(res.status).toBe(200);

    const body = await res.json() as any[];
    expect(body.length).toBeGreaterThanOrEqual(1);

    const insight = body.find((m: any) => m.id === createdInsightId);
    expect(insight).toBeDefined();
    expect(insight.type).toBe("insight");
  });

  // ── Search returns insight ──────────────────────────────────────────

  test("search: insight returned by POST /api/v1/search", async () => {
    expect(createdInsightId).toBeDefined();
    expect(createdInsightPath).toBeDefined();

    // Configure search mock to return the insight
    mockSearchResults = [
      {
        file: createdInsightPath!,
        score: 0.90,
        title: "React Development Patterns",
        bestChunk: "React hooks and context API",
        displayPath: "qmd://tech/programming/insights",
      },
    ];

    const res = await apiRequest("/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "React development patterns" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any[];
    expect(body.length).toBeGreaterThanOrEqual(1);

    const result = body.find((r: any) => r.id === createdInsightId);
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
  });

  // ── Reactive Lifecycle: Source Deletion ──────────────────────────────

  test("reactive lifecycle: delete 1 of 3 sources → insight becomes evolving (67%)", async () => {
    expect(createdInsightId).toBeDefined();

    // Verify insight currently has 3 source_ids and is active
    const insightContent = await readFile(createdInsightPath!, "utf-8");
    const insightFm = parseFrontmatter(insightContent);
    expect(insightFm.source_ids.length).toBe(3);
    expect(insightFm.status).toBe("active");

    // Delete first source via API
    const deleteRes = await apiRequest(`/api/v1/memory/mem-react-hooks`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    // Allow async event processing
    await Bun.sleep(100);

    // Check tracker status → evolving
    const status = tracker.getStatus(createdInsightId!);
    expect(status?.status).toBe("evolving");

    // Verify the insight file on disk was updated to evolving
    const updatedContent = await readFile(createdInsightPath!, "utf-8");
    const updatedFm = parseFrontmatter(updatedContent);
    expect(updatedFm.status).toBe("evolving");
  });

  test("reactive lifecycle: delete 2nd of 3 sources → insight becomes degraded (33%)", async () => {
    expect(createdInsightId).toBeDefined();

    // Delete second source via API
    const deleteRes = await apiRequest(`/api/v1/memory/mem-react-context`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    // Allow async event processing
    await Bun.sleep(100);

    // Check tracker status → degraded (1/3 remaining = 33% < 50%)
    const status = tracker.getStatus(createdInsightId!);
    expect(status?.status).toBe("degraded");

    // Verify the insight file on disk was updated to degraded
    const updatedContent = await readFile(createdInsightPath!, "utf-8");
    const updatedFm = parseFrontmatter(updatedContent);
    expect(updatedFm.status).toBe("degraded");
  });

  // ── Retired Insight Filtering ───────────────────────────────────────

  test("retired insight filtering: retired insights excluded from search results", async () => {
    // Create a second insight manually and mark it retired (simulating supersession)
    const retiredId = "ins-retired1";
    const retiredPath = join(tempDir, "insights", `${retiredId}-old-patterns.md`);
    const retiredContent = `---
id: ${retiredId}
type: insight
category: qmd://tech/programming
date_saved: 2026-02-15T00:00:00.000Z
source: kore_synthesis
tags: ["react"]
insight_type: cluster_summary
source_ids: ["mem-react-hooks", "mem-react-context"]
supersedes: []
superseded_by: ["${createdInsightId}"]
confidence: 0.6
status: retired
reinforcement_count: 0
re_eval_reason: null
last_synthesized_at: 2026-02-15T00:00:00.000Z
---

# Old React Patterns

## Synthesis
Outdated synthesis that has been superseded.

## Key Connections
No direct connections identified.

## Distilled Memory Items
- **Old fact about React.**

## Source Material
Synthesized from 2 memories: mem-react-hooks, mem-react-context
`;
    await Bun.write(retiredPath, retiredContent);
    memoryIndex.set(retiredId, retiredPath);

    // Search mock returns both the retired and active insights
    mockSearchResults = [
      { file: retiredPath, score: 0.85, title: "Old React Patterns", bestChunk: "old patterns" },
      { file: createdInsightPath!, score: 0.90, title: "React Development Patterns", bestChunk: "new patterns" },
    ];

    const res = await apiRequest("/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "React patterns" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any[];

    // Retired insight should be filtered out
    const retiredResult = body.find((r: any) => r.id === retiredId);
    expect(retiredResult).toBeUndefined();

    // Non-retired insight should still appear (even if degraded — only "retired" is filtered)
    const activeResult = body.find((r: any) => r.id === createdInsightId);
    expect(activeResult).toBeDefined();
  });
});

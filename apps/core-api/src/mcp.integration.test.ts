/**
 * MCP Integration Tests (MCP-005)
 *
 * Connects a real MCP SDK Client to the embedded MCP server over HTTP,
 * using a real test environment: real MemoryIndex, real SQLite queue,
 * real memory files on disk. QMD is mocked (external service).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MemoryIndex } from "./memory-index";
import { QueueRepository } from "./queue";
import { ConsolidationTracker } from "./consolidation-tracker";
import { createMcpRequestHandler } from "./mcp";
import type { OperationDeps } from "./operations";
import type { HybridQueryResult } from "@kore/qmd-client";

// ─── Test Fixtures ────────────────────────────────────────────────

const PLACE_MEMORY = `---
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

const NOTE_MEMORY = `---
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

const ACTIVE_INSIGHT = `---
id: ins-001
type: insight
insight_type: cluster_summary
status: active
category: qmd://travel/food
date_saved: 2026-03-16T12:00:00Z
source: consolidation
tags: ["ramen", "food"]
confidence: 0.88
source_ids: ["mem-001"]
reinforcement_count: 2
last_synthesized_at: 2026-03-16T12:00:00Z
---

# Ramen Knowledge

## Synthesis
The user has extensive knowledge about ramen restaurants in Tokyo.

## Distilled Memory Items
- Mutekiya is the top recommended spot in Ikebukuro
- Solo dining at counter is preferred
`;

const RETIRED_INSIGHT = `---
id: ret-001
type: insight
insight_type: cluster_summary
status: retired
category: qmd://travel/food
date_saved: 2026-03-01T00:00:00Z
source: consolidation
tags: ["food"]
confidence: 0.5
source_ids: []
reinforcement_count: 0
---

# Old Food Knowledge

## Synthesis
This insight has been superseded.

## Distilled Memory Items
- Outdated recommendation
`;

function makeQmdResult(
  overrides: Partial<HybridQueryResult> & { file: string; score: number }
): HybridQueryResult {
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

// ─── Server Setup ──────────────────────────────────────────────────

let tempDir: string;
let queue: QueueRepository;
let memoryIndex: MemoryIndex;
let consolidationTracker: ConsolidationTracker;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

// Mutable mock QMD results — set before each test that needs query-based recall
let mockQmdResults: HybridQueryResult[] = [];

beforeAll(async () => {
  // Create temp directory with real memory files
  tempDir = await mkdtemp(join(tmpdir(), "kore-mcp-integ-"));

  await mkdir(join(tempDir, "places"), { recursive: true });
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });
  await mkdir(join(tempDir, "media"), { recursive: true });
  await mkdir(join(tempDir, "people"), { recursive: true });

  await writeFile(join(tempDir, "places", "best-ramen.md"), PLACE_MEMORY);
  await writeFile(join(tempDir, "notes", "react-hooks.md"), NOTE_MEMORY);
  await writeFile(join(tempDir, "insights", "ramen-knowledge.md"), ACTIVE_INSIGHT);
  await writeFile(join(tempDir, "insights", "retired-insight.md"), RETIRED_INSIGHT);

  // Real MemoryIndex built from real files
  memoryIndex = new MemoryIndex();
  await memoryIndex.build(tempDir);

  // Real SQLite queue
  queue = new QueueRepository(join(tempDir, "queue.db"));

  // ConsolidationTracker backed by same DB
  consolidationTracker = new ConsolidationTracker(queue.getDatabase());

  // Build operation deps with mock QMD
  const deps: OperationDeps = {
    dataPath: tempDir,
    memoryIndex,
    queue,
    qmdSearch: async (_query, _opts) => [...mockQmdResults],
    qmdStatus: async () => ({
      status: "ok" as const,
      doc_count: 4,
      collections: 1,
      needs_embedding: 0,
    }),
    consolidationTracker,
  };

  const handleMcpRequest = createMcpRequestHandler(deps);

  // Start a real HTTP server on a random port
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") {
        return handleMcpRequest(req);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Connect MCP SDK Client via HTTP transport
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${server.port}/mcp`)
  );
  client = new Client({ name: "kore-integration-test", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  server.stop();
  queue.close();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset mock QMD results before each test
  mockQmdResults = [];
});

// ─── Helper ────────────────────────────────────────────────────────

async function callTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string; data: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  const isError = result.isError === true;
  let data: unknown = null;
  if (!isError) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { isError, text, data };
}

// ─── recall tool ───────────────────────────────────────────────────

describe("recall tool", () => {
  test("no-query path returns results matching RecallOutput schema", async () => {
    const { isError, data } = await callTool("recall", {});
    expect(isError).toBe(false);

    const out = data as any;
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    expect(typeof out.query).toBe("string");
    expect(typeof out.total).toBe("number");
    expect(typeof out.offset).toBe("number");
    expect(typeof out.has_more).toBe("boolean");

    // Each result must have required fields
    for (const r of out.results) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.type).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(typeof r.date_saved).toBe("string");
      expect(Array.isArray(r.distilled_items)).toBe(true);
      expect(typeof r.score).toBe("number");
    }
  });

  test("no-query path results are sorted by date_saved descending", async () => {
    const { data } = await callTool("recall", {});
    const out = data as any;
    const dates = out.results.map((r: any) => r.date_saved);

    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
  });

  test("pagination: offset and has_more work correctly", async () => {
    // Page 1: first 2 results
    const page1 = await callTool("recall", { limit: 2, offset: 0 });
    const p1 = page1.data as any;
    expect(p1.results.length).toBe(2);
    expect(p1.offset).toBe(0);
    expect(p1.has_more).toBe(true);

    // Page 2: next 2 results (only 1 remaining out of 3 active memories)
    const page2 = await callTool("recall", { limit: 2, offset: 2 });
    const p2 = page2.data as any;
    expect(p2.results.length).toBe(1);
    expect(p2.offset).toBe(2);
    expect(p2.has_more).toBe(false);
  });

  test("type filter returns only matching results", async () => {
    const { isError, data } = await callTool("recall", { type: "place" });
    expect(isError).toBe(false);
    const out = data as any;
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.type).toBe("place");
    }

    const noteResult = await callTool("recall", { type: "note" });
    const notes = noteResult.data as any;
    expect(notes.results.length).toBeGreaterThan(0);
    for (const r of notes.results) {
      expect(r.type).toBe("note");
    }
  });

  test("intent filter returns only matching results", async () => {
    const { data } = await callTool("recall", { intent: "recommendation" });
    const out = data as any;
    for (const r of out.results) {
      expect(r.intent).toBe("recommendation");
    }
    expect(out.results.some((r: any) => r.id === "mem-001")).toBe(true);
  });

  test("min_confidence filter works", async () => {
    // Only mem-001 (0.9) should pass min_confidence: 0.9
    const { data } = await callTool("recall", { min_confidence: 0.9 });
    const out = data as any;
    for (const r of out.results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  test("query path uses QMD and returns structured results", async () => {
    mockQmdResults = [
      makeQmdResult({
        file: join(tempDir, "places", "best-ramen.md"),
        score: 0.95,
        title: "Best Ramen in Ikebukuro",
      }),
    ];

    const { isError, data } = await callTool("recall", { query: "ramen tokyo" });
    expect(isError).toBe(false);
    const out = data as any;
    expect(out.query).toBe("ramen tokyo");
    expect(out.results.length).toBe(1);
    expect(out.results[0].id).toBe("mem-001");
    expect(out.results[0].type).toBe("place");
    expect(out.results[0].score).toBe(0.95);
  });

  test("include_insights=false excludes insight-type results", async () => {
    const { data } = await callTool("recall", { include_insights: false });
    const out = data as any;
    for (const r of out.results) {
      expect(r.type).not.toBe("insight");
    }
  });
});

// ─── Retired insight exclusion ────────────────────────────────────

describe("retired insight exclusion", () => {
  test("recall does not return retired insights by default", async () => {
    const { data } = await callTool("recall", {});
    const out = data as any;
    const retiredIds = out.results
      .filter((r: any) => r.type === "insight" && r.status === "retired")
      .map((r: any) => r.id);
    expect(retiredIds).toEqual([]);

    // The retired insight ID should not appear at all
    const allIds = out.results.map((r: any) => r.id);
    expect(allIds).not.toContain("ret-001");
  });
});

// ─── remember tool ────────────────────────────────────────────────

describe("remember tool", () => {
  test("returns { status: 'queued', task_id } with a valid task ID", async () => {
    const { isError, data } = await callTool("remember", {
      content: "Great sushi spot in Shibuya called Sushi Dai — recommended by local guide",
      source: "agent",
      suggested_tags: ["sushi", "tokyo"],
      suggested_category: "travel/food/sushi",
    });
    expect(isError).toBe(false);
    const out = data as any;
    expect(out.status).toBe("queued");
    expect(typeof out.task_id).toBe("string");
    expect(out.task_id.length).toBeGreaterThan(0);
    expect(typeof out.message).toBe("string");

    // Verify the task actually exists in the real queue
    const task = queue.getTask(out.task_id);
    expect(task).not.toBeNull();
    expect(task?.status).toBe("queued");
  });
});

// ─── remember → recall round-trip ────────────────────────────────

describe("remember → recall round-trip", () => {
  test("enqueue content, process file, verify memory appears in recall results", async () => {
    // Step 1: enqueue via remember
    const rememberResult = await callTool("remember", {
      content: "Craft beer bar in Shimokitazawa — excellent selection of local IPAs",
      source: "agent",
    });
    expect(rememberResult.isError).toBe(false);
    const { task_id } = rememberResult.data as any;
    expect(task_id).toBeTruthy();

    // Step 2: simulate the worker by writing a processed memory file to disk
    // (in tests we cannot run the LLM extraction worker)
    const processedMemory = `---
id: mem-rttrip
type: place
category: qmd://travel/food/beer
date_saved: 2026-03-20T10:00:00Z
source: agent
tags: ["craft-beer", "shimokitazawa"]
intent: recommendation
confidence: 0.88
---

# Craft Beer Bar in Shimokitazawa

## Distilled Memory Items
- Excellent selection of local IPAs
- Located in Shimokitazawa area

## Original Source
Craft beer bar in Shimokitazawa — excellent selection of local IPAs
`;
    await writeFile(join(tempDir, "places", "craft-beer-shimokitazawa.md"), processedMemory);

    // Step 3: rebuild the memory index to pick up the new file
    await memoryIndex.build(tempDir);

    // Step 4: verify recall finds the new memory (no query, type filter)
    const { data } = await callTool("recall", { type: "place" });
    const out = data as any;
    const ids = out.results.map((r: any) => r.id);
    expect(ids).toContain("mem-rttrip");
  });
});

// ─── inspect tool ─────────────────────────────────────────────────

describe("inspect tool", () => {
  test("returns full memory with content and distilled_items", async () => {
    const { isError, data } = await callTool("inspect", { id: "mem-001" });
    expect(isError).toBe(false);

    const out = data as any;
    expect(out.id).toBe("mem-001");
    expect(out.title).toBe("Best Ramen in Ikebukuro");
    expect(out.type).toBe("place");
    expect(out.category).toBe("qmd://travel/food/ramen");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("---"); // frontmatter present
    expect(out.content.length).toBeGreaterThan(0);
    expect(Array.isArray(out.distilled_items)).toBe(true);
    expect(out.distilled_items.length).toBe(3);
    expect(out.distilled_items[0]).toContain("Mutekiya");
  });

  test("unknown ID returns isError: true", async () => {
    const { isError, text } = await callTool("inspect", { id: "nonexistent-xyz" });
    expect(isError).toBe(true);
    expect(text).toContain("Error:");
  });

  test("returns insight-specific fields for insight memories", async () => {
    const { isError, data } = await callTool("inspect", { id: "ins-001" });
    expect(isError).toBe(false);
    const out = data as any;
    expect(out.id).toBe("ins-001");
    expect(out.type).toBe("insight");
    expect(out.insight_type).toBe("cluster_summary");
    expect(out.status).toBe("active");
    expect(Array.isArray(out.source_ids)).toBe(true);
  });
});

// ─── insights tool ────────────────────────────────────────────────

describe("insights tool", () => {
  test("returns only active insights by default (no query)", async () => {
    const { isError, data } = await callTool("insights", {});
    expect(isError).toBe(false);

    const out = data as any;
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    expect(typeof out.total).toBe("number");

    // All returned results must be active (retired insight excluded)
    for (const r of out.results) {
      expect(r.status).toBe("active");
    }
    // The retired insight must not appear
    const retiredIds = out.results.filter((r: any) => r.id === "ret-001");
    expect(retiredIds).toHaveLength(0);
  });

  test("insight_type filter returns only matching insights", async () => {
    const { data: clusterData } = await callTool("insights", {
      insight_type: "cluster_summary",
    });
    const clusterOut = clusterData as any;
    for (const r of clusterOut.results) {
      expect(r.insight_type).toBe("cluster_summary");
    }
    expect(clusterOut.results.some((r: any) => r.id === "ins-001")).toBe(true);

    // Filter for evolution type — no fixtures have this type
    const { data: evolveData } = await callTool("insights", {
      insight_type: "evolution",
    });
    const evolveOut = evolveData as any;
    expect(evolveOut.results).toHaveLength(0);
  });

  test("query path uses QMD and filters to insights only", async () => {
    mockQmdResults = [
      makeQmdResult({
        file: join(tempDir, "insights", "ramen-knowledge.md"),
        score: 0.92,
        title: "Ramen Knowledge",
      }),
      // QMD might return non-insight files — these should be excluded
      makeQmdResult({
        file: join(tempDir, "places", "best-ramen.md"),
        score: 0.8,
        title: "Best Ramen in Ikebukuro",
      }),
    ];

    const { isError, data } = await callTool("insights", { query: "ramen" });
    expect(isError).toBe(false);
    const out = data as any;
    expect(Array.isArray(out.results)).toBe(true);
    // Only the insight file should be returned (non-insight path filtered out)
    for (const r of out.results) {
      expect(r.id).toBe("ins-001");
    }
  });
});

// ─── health tool ──────────────────────────────────────────────────

describe("health tool", () => {
  test("returns memories.total, queue, and index fields with correct types", async () => {
    const { isError, data } = await callTool("health", {});
    expect(isError).toBe(false);

    const out = data as any;
    expect(typeof out.version).toBe("string");
    expect(out.version.length).toBeGreaterThan(0);

    // memories
    expect(typeof out.memories).toBe("object");
    expect(typeof out.memories.total).toBe("number");
    expect(out.memories.total).toBeGreaterThan(0);
    expect(typeof out.memories.by_type).toBe("object");

    // queue
    expect(typeof out.queue).toBe("object");
    expect(typeof out.queue.pending).toBe("number");
    expect(typeof out.queue.processing).toBe("number");
    expect(typeof out.queue.failed).toBe("number");

    // index
    expect(typeof out.index).toBe("object");
    expect(typeof out.index.documents).toBe("number");
    expect(typeof out.index.status).toBe("string");
  });

  test("memories.by_type reflects actual memory types in index", async () => {
    const { data } = await callTool("health", {});
    const out = data as any;
    // We have place and note types in fixtures
    expect(out.memories.by_type).toHaveProperty("place");
    expect(out.memories.by_type).toHaveProperty("note");
    expect(out.memories.by_type.place).toBeGreaterThanOrEqual(1);
    expect(out.memories.by_type.note).toBeGreaterThanOrEqual(1);
  });
});

// ─── consolidate tool ─────────────────────────────────────────────

describe("consolidate tool", () => {
  test("dry_run=true returns dry_run status or no_seed (without writing files)", async () => {
    const { isError, data } = await callTool("consolidate", { dry_run: true });
    expect(isError).toBe(false);

    const out = data as any;
    // With an empty consolidation tracker (no seeds registered),
    // result is either "no_seed" or "dry_run" (if a seed is found from the index)
    const validStatuses = ["no_seed", "dry_run", "cluster_too_small"];
    expect(validStatuses).toContain(out.status);

    // If dry_run, verify shape
    if (out.status === "dry_run") {
      expect(out.seed).toBeDefined();
      expect(Array.isArray(out.candidates)).toBe(true);
    }
    // If no_seed, no extra fields required
  });
});

// ─── error handling ───────────────────────────────────────────────

describe("error handling", () => {
  test("inspect with unknown ID returns isError: true with Error: prefix", async () => {
    const { isError, text } = await callTool("inspect", { id: "does-not-exist" });
    expect(isError).toBe(true);
    expect(text).toMatch(/^Error: /);
  });

  test("listTools returns all 6 tool names", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("recall");
    expect(names).toContain("remember");
    expect(names).toContain("inspect");
    expect(names).toContain("insights");
    expect(names).toContain("health");
    expect(names).toContain("consolidate");
    expect(names.length).toBe(6);
  });

  test("all successful tools return JSON-parseable text in content[0]", async () => {
    const toolCalls: Array<[string, Record<string, unknown>]> = [
      ["recall", {}],
      ["remember", { content: "test content for schema verification" }],
      ["health", {}],
      ["insights", {}],
    ];

    for (const [name, args] of toolCalls) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      expect(() => JSON.parse(content[0]?.text)).not.toThrow();
    }
  });
});

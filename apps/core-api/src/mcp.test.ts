import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MemoryIndex } from "./memory-index";
import { QueueRepository } from "./queue";
import { createMcpServer } from "./mcp";
import type { OperationDeps } from "./operations";
import type { QmdHealthSummary } from "./app";
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";

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

function createMockDeps(overrides?: Partial<OperationDeps>): OperationDeps {
  return {
    dataPath: tempDir,
    memoryIndex,
    queue,
    qmdSearch: async () => [],
    qmdStatus: async () => ({ status: "ok" as const, doc_count: 10, collections: 1, needs_embedding: 0 }),
    ...overrides,
  };
}

// ─── Helper: call a tool via the McpServer ─────────────────────────

function getTools(server: ReturnType<typeof createMcpServer>): Record<string, any> {
  return (server as any)._registeredTools;
}

async function callTool(
  server: ReturnType<typeof createMcpServer>,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<{ isError?: boolean; text: string }> {
  const tools = getTools(server);
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);

  const result = await tool.handler(args, {});
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError ?? false, text };
}

// ─── Setup / Teardown ─────────────────────────────────────────────

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-mcp-test-"));
  const dbPath = join(tempDir, "queue.db");
  queue = new QueueRepository(dbPath);

  // Create data directories
  await mkdir(join(tempDir, "places"), { recursive: true });
  await mkdir(join(tempDir, "notes"), { recursive: true });
  await mkdir(join(tempDir, "insights"), { recursive: true });

  // Write sample memory files
  await writeFile(join(tempDir, "places", "best-ramen.md"), sampleMemoryContent);
  await writeFile(join(tempDir, "notes", "react-hooks.md"), sampleMemoryContent2);
  await writeFile(join(tempDir, "insights", "ramen-knowledge.md"), sampleInsightContent);

  // Build memory index
  memoryIndex = new MemoryIndex();
  await memoryIndex.build(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────

describe("MCP Server", () => {
  describe("createMcpServer", () => {
    test("registers all 6 tools", () => {
      const server = createMcpServer(createMockDeps());
      const tools = getTools(server);
      const names = Object.keys(tools);
      expect(names).toContain("recall");
      expect(names).toContain("remember");
      expect(names).toContain("inspect");
      expect(names).toContain("insights");
      expect(names).toContain("health");
      expect(names).toContain("consolidate");
      expect(names.length).toBe(6);
    });

    test("tool descriptions contain WHEN TO USE sections", () => {
      const server = createMcpServer(createMockDeps());
      const tools = getTools(server);
      for (const [name, tool] of Object.entries(tools)) {
        expect(tool.description).toContain("WHEN TO USE");
      }
    });

    test("server has instructions set", () => {
      const server = createMcpServer(createMockDeps());
      const lowLevelServer = (server as any).server;
      expect(lowLevelServer._instructions).toBeTruthy();
      expect(lowLevelServer._instructions).toContain("PROACTIVE RECALL");
      expect(lowLevelServer._instructions).toContain("PREFER INSIGHTS");
      expect(lowLevelServer._instructions).toContain("OFFER TO REMEMBER");
      expect(lowLevelServer._instructions).toContain("NEVER FABRICATE");
      expect(lowLevelServer._instructions).toContain("RESPECT CONFIDENCE");
    });
  });

  describe("recall tool", () => {
    test("returns results from no-query path", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "recall", { type: "place" });
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.results).toBeArray();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].type).toBe("place");
      expect(data.offset).toBe(0);
      expect(typeof data.has_more).toBe("boolean");
    });

    test("returns results from query path", async () => {
      const deps = createMockDeps({
        qmdSearch: async (query: string) => [
          mockQmdResult({
            file: join(tempDir, "places", "best-ramen.md"),
            score: 0.95,
            title: "Best Ramen",
          }),
        ],
      });
      const server = createMcpServer(deps);
      const result = await callTool(server, "recall", { query: "ramen" });
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.results.length).toBe(1);
      expect(data.results[0].id).toBe("mem-001");
      expect(data.query).toBe("ramen");
    });

    test("returns structured error for search failures", async () => {
      const deps = createMockDeps({
        qmdSearch: async () => { throw new Error("Index not available"); },
      });
      const server = createMcpServer(deps);
      const result = await callTool(server, "recall", { query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Search index is not available");
    });
  });

  describe("remember tool", () => {
    test("enqueues content and returns task_id", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "remember", {
        content: "Great sushi spot in Shibuya called Sushi Dai",
        source: "agent",
        suggested_tags: ["sushi", "tokyo"],
      });
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.status).toBe("queued");
      expect(data.task_id).toBeTruthy();
      expect(data.message).toContain("Memory queued");
    });

    test("returns error when queue is unavailable", async () => {
      const brokenQueue = {
        enqueue: () => { throw new Error("Queue unavailable"); },
      } as any;
      const deps = createMockDeps({ queue: brokenQueue });
      const server = createMcpServer(deps);
      const result = await callTool(server, "remember", { content: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ingestion queue is not available");
    });
  });

  describe("inspect tool", () => {
    test("returns full memory details for valid ID", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "inspect", { id: "mem-001" });
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.id).toBe("mem-001");
      expect(data.title).toBe("Best Ramen in Ikebukuro");
      expect(data.type).toBe("place");
      expect(data.category).toBe("qmd://travel/food/ramen");
      expect(data.distilled_items).toBeArray();
      expect(data.distilled_items.length).toBe(3);
      expect(data.content).toContain("---");
    });

    test("returns error for unknown ID", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "inspect", { id: "nonexistent-id" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("was not found");
    });
  });

  describe("insights tool", () => {
    test("returns active insights when no query", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "insights", {});
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.results).toBeArray();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].insight_type).toBe("cluster_summary");
      expect(data.results[0].status).toBe("active");
    });

    test("filters by insight_type", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "insights", { insight_type: "evolution" });
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.results.length).toBe(0); // no evolution insights in fixtures
    });

    test("returns structured error for search failures", async () => {
      const deps = createMockDeps({
        qmdSearch: async () => { throw new Error("unavailable"); },
      });
      const server = createMcpServer(deps);
      const result = await callTool(server, "insights", { query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Search index is not available");
    });
  });

  describe("health tool", () => {
    test("returns system health", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "health");
      expect(result.isError).toBe(false);

      const data = JSON.parse(result.text);
      expect(data.version).toBeTruthy();
      expect(data.memories).toBeDefined();
      expect(data.memories.total).toBeGreaterThan(0);
      expect(data.memories.by_type).toBeDefined();
      expect(data.queue).toBeDefined();
      expect(typeof data.queue.pending).toBe("number");
      expect(typeof data.queue.processing).toBe("number");
      expect(typeof data.queue.failed).toBe("number");
      expect(data.index).toBeDefined();
      expect(typeof data.index.documents).toBe("number");
      expect(typeof data.index.status).toBe("string");
    });

    test("returns error on health check failure", async () => {
      const deps = createMockDeps({
        qmdStatus: async () => { throw new Error("QMD down"); },
      });
      const server = createMcpServer(deps);
      const result = await callTool(server, "health");
      expect(result.isError).toBe(true);
    });
  });

  describe("consolidate tool", () => {
    test("returns error when consolidation tracker not available", async () => {
      const deps = createMockDeps({
        consolidationTracker: undefined,
      });
      const server = createMcpServer(deps);
      const result = await callTool(server, "consolidate", { dry_run: false });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("consolidation system is not available");
    });
  });

  describe("error handling", () => {
    test("all tools return structured MCP error format", async () => {
      // Use a server with broken deps to trigger errors
      const brokenDeps = createMockDeps({
        qmdSearch: async () => { throw new Error("broken"); },
        qmdStatus: async () => { throw new Error("broken"); },
      });
      const server = createMcpServer(brokenDeps);

      // recall with query should fail on broken search
      const recallResult = await callTool(server, "recall", { query: "test" });
      expect(recallResult.isError).toBe(true);
      expect(recallResult.text).toContain("Error:");

      // health should fail on broken qmdStatus
      const healthResult = await callTool(server, "health");
      expect(healthResult.isError).toBe(true);
      expect(healthResult.text).toContain("Error:");

      // inspect with nonexistent ID should return structured error
      const inspectResult = await callTool(server, "inspect", { id: "xxx" });
      expect(inspectResult.isError).toBe(true);
      expect(inspectResult.text).toContain("Error:");
    });

    test("no unhandled exceptions reach the agent", async () => {
      const deps = createMockDeps({
        qmdSearch: async () => { throw new TypeError("Cannot read properties of undefined"); },
      });
      const server = createMcpServer(deps);

      // Should NOT throw — should return structured error
      const result = await callTool(server, "recall", { query: "test" });
      expect(result.isError).toBe(true);
      // The error text should be present (not an unhandled rejection)
      expect(result.text).toBeTruthy();
    });
  });

  describe("result passthrough to MCP format", () => {
    test("successful results are JSON-serialized in content[0].text", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "recall", { type: "place" });

      // The result should be valid JSON
      const parsed = JSON.parse(result.text);
      expect(parsed).toBeDefined();
      expect(parsed.results).toBeArray();
    });

    test("error results have isError: true and human-readable text", async () => {
      const server = createMcpServer(createMockDeps());
      const result = await callTool(server, "inspect", { id: "missing" });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Error: /);
    });
  });
});

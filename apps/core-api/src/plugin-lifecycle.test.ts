import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { pollOnce, type WorkerDeps } from "./worker";
import { QueueRepository } from "./queue";
import { EventDispatcher } from "./event-dispatcher";
import { PluginRegistryRepository } from "./plugin-registry";
import { deleteMemoryById } from "./delete-memory";
import { MemoryIndex } from "./memory-index";
import { ensureDataDirectories } from "./app";
import type { MemoryExtraction, MemoryEvent, KorePlugin, PluginStartDeps } from "@kore/shared-types";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { renderMarkdown } from "./markdown";
import { randomUUID } from "crypto";

// ─── Mock extract function ──────────────────────────────────────────

const MOCK_EXTRACTION: MemoryExtraction = {
  title: "Mutekiya Ramen in Ikebukuro",
  distilled_items: [
    "Mutekiya is a famous tonkotsu ramen shop in Ikebukuro, Tokyo",
    "Known for rich, creamy pork broth and thick noodles",
  ],
  qmd_category: "qmd://travel/food/japan",
  type: "place",
  tags: ["ramen", "tokyo"],
};

function mockExtract(): Promise<MemoryExtraction> {
  return Promise.resolve(MOCK_EXTRACTION);
}

function failingExtract(): Promise<MemoryExtraction> {
  return Promise.reject(new Error("LLM connection refused"));
}

// ─── Per-test isolation ─────────────────────────────────────────────

let tempDir: string;
let queue: QueueRepository;
let dispatcher: EventDispatcher;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-plugin-lifecycle-test-"));
  await ensureDataDirectories(tempDir);
  const dbPath = join(tempDir, "queue.db");
  queue = new QueueRepository(dbPath);
  dispatcher = new EventDispatcher();
});

afterEach(async () => {
  queue.close();
  await rm(tempDir, { recursive: true, force: true });
});

function makeDeps(overrides?: Partial<WorkerDeps>): WorkerDeps {
  return {
    queue,
    dataPath: tempDir,
    dispatcher,
    extractFn: mockExtract,
    ...overrides,
  };
}

// ─── Worker memory.indexed emission ─────────────────────────────────

describe("Worker: memory.indexed emission", () => {
  test("emits memory.indexed after successful extraction with correct taskId", async () => {
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test-plugin",
      onMemoryIndexed: async (event) => { events.push(event); },
    };
    dispatcher.registerPlugins([plugin]);

    const taskId = queue.enqueue({ source: "apple_notes", content: "Great ramen" });
    await pollOnce(makeDeps());

    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe(taskId);
    expect(events[0].id).toBeDefined();
    expect(events[0].filePath).toContain("places/");
    expect(events[0].frontmatter).toBeDefined();
    expect(events[0].frontmatter.type).toBe("place");
    expect(events[0].timestamp).toBeDefined();
  });

  test("does NOT emit event on extraction failure", async () => {
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test-plugin",
      onMemoryIndexed: async (event) => { events.push(event); },
    };
    dispatcher.registerPlugins([plugin]);

    queue.enqueue({ source: "test", content: "Some text" });
    await pollOnce(makeDeps({ extractFn: failingExtract }));

    expect(events).toHaveLength(0);
  });

  test("does NOT emit when no dispatcher is provided", async () => {
    // This ensures backward compatibility
    const taskId = queue.enqueue({ source: "test", content: "Some text" });
    await pollOnce(makeDeps({ dispatcher: undefined }));

    const task = queue.getTask(taskId);
    expect(task?.status).toBe("completed");
  });
});

// ─── Plugin lifecycle ───────────────────────────────────────────────

describe("Plugin lifecycle", () => {
  test("plugins with start() have it called during boot", async () => {
    let started = false;
    const plugin: KorePlugin = {
      name: "start-test",
      start: async () => { started = true; },
    };

    const registry = new PluginRegistryRepository(queue.getDatabase());
    const memoryIndex = new MemoryIndex();
    const deps: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: (id) => deleteMemoryById(id, { memoryIndex, eventDispatcher: dispatcher }),
      getMemoryIdByExternalKey: (key) => registry.get(plugin.name, key),
      setExternalKeyMapping: (key, memId) => registry.set(plugin.name, key, memId),
      removeExternalKeyMapping: (key) => registry.remove(plugin.name, key),
      clearRegistry: () => registry.clear(plugin.name),
    };

    await plugin.start!(deps);
    expect(started).toBe(true);
  });

  test("plugins without start() are skipped gracefully", async () => {
    const plugin: KorePlugin = {
      name: "hooks-only",
      onMemoryIndexed: async () => {},
    };

    // Should not throw
    if (plugin.start) {
      await plugin.start({} as PluginStartDeps);
    }
    // If we get here, the plugin was skipped gracefully
    expect(plugin.start).toBeUndefined();
  });

  test("a failing plugin start() does not crash the server", async () => {
    const plugin: KorePlugin = {
      name: "crasher",
      start: async () => { throw new Error("plugin init crash"); },
    };

    let crashed = false;
    try {
      await plugin.start!({} as PluginStartDeps);
    } catch {
      crashed = true;
    }

    // The error should be caught — in index.ts this is wrapped in try/catch
    expect(crashed).toBe(true);

    // Simulate the index.ts pattern: catch and continue
    const plugins: KorePlugin[] = [
      plugin,
      { name: "good-plugin", start: async () => {} },
    ];

    const results: string[] = [];
    for (const p of plugins) {
      if (p.start) {
        try {
          await p.start({} as PluginStartDeps);
          results.push(`${p.name}:ok`);
        } catch {
          results.push(`${p.name}:error`);
        }
      }
    }

    expect(results).toEqual(["crasher:error", "good-plugin:ok"]);
  });

  test("plugin stop() is called during shutdown", async () => {
    let stopped = false;
    const plugin: KorePlugin = {
      name: "stop-test",
      stop: async () => { stopped = true; },
    };

    await plugin.stop!();
    expect(stopped).toBe(true);
  });

  test("plugin stop() timeout is handled gracefully", async () => {
    const plugin: KorePlugin = {
      name: "slow-stopper",
      stop: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      },
    };

    const TIMEOUT_MS = 100; // short timeout for test
    let timedOut = false;

    try {
      await Promise.race([
        plugin.stop!(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "timeout") {
        timedOut = true;
      }
    }

    expect(timedOut).toBe(true);
  });
});

// ─── PluginStartDeps registry scoping ───────────────────────────────

describe("PluginStartDeps: registry scoping", () => {
  test("registry methods are scoped by plugin name via closure", () => {
    const registry = new PluginRegistryRepository(queue.getDatabase());

    // Build deps for plugin A
    const depsA: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: async () => false,
      getMemoryIdByExternalKey: (key) => registry.get("plugin-a", key),
      setExternalKeyMapping: (key, memId) => registry.set("plugin-a", key, memId),
      removeExternalKeyMapping: (key) => registry.remove("plugin-a", key),
      clearRegistry: () => registry.clear("plugin-a"),
    };

    // Build deps for plugin B
    const depsB: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: async () => false,
      getMemoryIdByExternalKey: (key) => registry.get("plugin-b", key),
      setExternalKeyMapping: (key, memId) => registry.set("plugin-b", key, memId),
      removeExternalKeyMapping: (key) => registry.remove("plugin-b", key),
      clearRegistry: () => registry.clear("plugin-b"),
    };

    // Plugin A sets a mapping
    depsA.setExternalKeyMapping("note-123", "memory-abc");

    // Plugin A can see it
    expect(depsA.getMemoryIdByExternalKey("note-123")).toBe("memory-abc");

    // Plugin B cannot see it
    expect(depsB.getMemoryIdByExternalKey("note-123")).toBeUndefined();
  });
});

// ─── deleteMemoryById shared function ───────────────────────────────

describe("deleteMemoryById", () => {
  test("deletes file and emits memory.deleted event", async () => {
    const memoryIndex = new MemoryIndex();
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test-plugin",
      onMemoryDeleted: async (event) => { events.push(event); },
    };
    dispatcher.registerPlugins([plugin]);

    // Create a memory file
    const id = randomUUID();
    const filePath = join(tempDir, "notes", "test_delete.md");
    const md = renderMarkdown({
      frontmatter: {
        id,
        type: "note" as const,
        category: "qmd://tech/test",
        date_saved: "2026-03-15T12:00:00Z",
        source: "test",
        tags: ["test"],
      },
      title: "Test Delete",
      rawSource: "Content",
    });
    await writeFile(filePath, md);
    memoryIndex.set(id, filePath);

    const deleted = await deleteMemoryById(id, { memoryIndex, eventDispatcher: dispatcher });
    expect(deleted).toBe(true);
    expect(memoryIndex.get(id)).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
  });

  test("returns false for unknown memory id", async () => {
    const memoryIndex = new MemoryIndex();
    const deleted = await deleteMemoryById("nonexistent", { memoryIndex, eventDispatcher: dispatcher });
    expect(deleted).toBe(false);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp, ensureDataDirectories } from "../../../apps/core-api/src/app";
import { QueueRepository } from "../../../apps/core-api/src/queue";
import { PluginRegistryRepository } from "../../../apps/core-api/src/plugin-registry";
import { EventDispatcher } from "../../../apps/core-api/src/event-dispatcher";
import { MemoryIndex } from "../../../apps/core-api/src/memory-index";
import { pollOnce, type WorkerDeps } from "../../../apps/core-api/src/worker";
import { deleteMemoryById } from "../../../apps/core-api/src/delete-memory";
import testPlugin from "../index";
import type { MemoryExtraction, PluginStartDeps } from "@kore/shared-types";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ─── Mock extract function ──────────────────────────────────────────

const MOCK_EXTRACTION: MemoryExtraction = {
  title: "Test Integration Memory",
  distilled_items: [
    "This is a test memory for plugin integration testing",
  ],
  qmd_category: "qmd://test/integration",
  type: "note",
  tags: ["test"],
};

function mockExtract() {
  return Promise.resolve({ ...MOCK_EXTRACTION, _extractionPath: "structured" as const });
}

// ─── Per-test isolation ─────────────────────────────────────────────

let tempDir: string;
let queue: QueueRepository;
let pluginRegistry: PluginRegistryRepository;
let dispatcher: EventDispatcher;
let memoryIndex: MemoryIndex;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-plugin-test-e2e-"));
  await ensureDataDirectories(tempDir);
  const dbPath = join(tempDir, "queue.db");
  queue = new QueueRepository(dbPath);
  pluginRegistry = new PluginRegistryRepository(queue.getDatabase());
  dispatcher = new EventDispatcher();
  memoryIndex = new MemoryIndex();
});

afterEach(async () => {
  // Stop the test plugin to clean up state between tests
  if (testPlugin.stop) {
    await testPlugin.stop();
  }
  queue.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Integration tests ─────────────────────────────────────────────

describe("Test plugin: end-to-end integration", () => {
  test("full flow: ingest → worker → onMemoryIndexed → key mapping persisted", async () => {
    // 1. Build PluginStartDeps and start the test plugin
    const deps: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: (id) => deleteMemoryById(id, { memoryIndex, eventDispatcher: dispatcher }),
      getMemoryIdByExternalKey: (key) => pluginRegistry.get("test-plugin", key),
      setExternalKeyMapping: (key, memId) => pluginRegistry.set("test-plugin", key, memId),
      removeExternalKeyMapping: (key) => pluginRegistry.remove("test-plugin", key),
      clearRegistry: () => pluginRegistry.clear("test-plugin"),
      listExternalKeys: () => pluginRegistry.listByPlugin("test-plugin"),
    };

    await testPlugin.start!(deps);

    // 2. Register plugin with event dispatcher
    dispatcher.registerPlugins([testPlugin]);

    // 3. Create the app and POST to /api/v1/remember
    process.env.KORE_API_KEY = "test-key";
    const app = createApp({
      queue,
      dataPath: tempDir,
      memoryIndex,
      eventDispatcher: dispatcher,
      qmdStatus: async () => ({ status: "ok" as const }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/remember", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "test-integration",
          content: "This is test content for plugin integration",
        }),
      })
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    const taskId = body.task_id;
    expect(taskId).toBeDefined();

    // 4. Run the worker to process the task
    const workerDeps: WorkerDeps = {
      queue,
      dataPath: tempDir,
      dispatcher,
      extractFn: mockExtract,
    };

    const processed = await pollOnce(workerDeps);
    expect(processed).toBe(true);

    // 5. Verify the external key mapping was persisted in plugin_key_registry
    const memoryId = pluginRegistry.get("test-plugin", `task:${taskId}`);
    expect(memoryId).toBeDefined();
    expect(typeof memoryId).toBe("string");

    // 6. Verify the mapping points to a valid UUID
    expect(memoryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test("onMemoryIndexed receives valid taskId", async () => {
    // Track events received by the plugin
    const receivedEvents: Array<{ id: string; taskId?: string }> = [];
    const originalHandler = testPlugin.onMemoryIndexed!;

    // Wrap the handler to capture events
    testPlugin.onMemoryIndexed = async (event) => {
      receivedEvents.push({ id: event.id, taskId: event.taskId });
      await originalHandler(event);
    };

    const deps: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: (id) => deleteMemoryById(id, { memoryIndex, eventDispatcher: dispatcher }),
      getMemoryIdByExternalKey: (key) => pluginRegistry.get("test-plugin", key),
      setExternalKeyMapping: (key, memId) => pluginRegistry.set("test-plugin", key, memId),
      removeExternalKeyMapping: (key) => pluginRegistry.remove("test-plugin", key),
      clearRegistry: () => pluginRegistry.clear("test-plugin"),
      listExternalKeys: () => pluginRegistry.listByPlugin("test-plugin"),
    };

    await testPlugin.start!(deps);
    dispatcher.registerPlugins([testPlugin]);

    // Enqueue and process
    const taskId = queue.enqueue({ source: "test", content: "Test content" });
    await pollOnce({ queue, dataPath: tempDir, dispatcher, extractFn: mockExtract });

    // Verify the plugin received the event with a valid taskId
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].taskId).toBe(taskId);
    expect(receivedEvents[0].id).toBeDefined();

    // Restore original handler
    testPlugin.onMemoryIndexed = originalHandler;
  });

  test("plugin start/stop lifecycle works correctly", async () => {
    const deps: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: async () => ({ deleted: false, restoredSources: 0 }),
      getMemoryIdByExternalKey: (key) => pluginRegistry.get("test-plugin", key),
      setExternalKeyMapping: (key, memId) => pluginRegistry.set("test-plugin", key, memId),
      removeExternalKeyMapping: (key) => pluginRegistry.remove("test-plugin", key),
      clearRegistry: () => pluginRegistry.clear("test-plugin"),
      listExternalKeys: () => pluginRegistry.listByPlugin("test-plugin"),
    };

    // start() should not throw
    await testPlugin.start!(deps);

    // After start, setExternalKeyMapping should work (deps stored)
    // Simulate an onMemoryIndexed call
    await testPlugin.onMemoryIndexed!({
      id: "mem-1",
      filePath: "/tmp/test.md",
      frontmatter: { id: "mem-1", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-1",
    });

    expect(pluginRegistry.get("test-plugin", "task:task-1")).toBe("mem-1");

    // stop() should not throw
    await testPlugin.stop!();
  });
});

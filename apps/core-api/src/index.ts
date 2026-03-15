import { createApp, ensureDataDirectories } from "./app";
import type { QmdHealthSummary } from "./app";
import { QueueRepository } from "./queue";
import { PluginRegistryRepository } from "./plugin-registry";
import { resolveDataPath, resolveQueueDbPath, resolveQmdDbPath, ensureKoreDirectories } from "./config";
import { initLogger, closeLogger } from "./logger";
import { startWorker } from "./worker";
import { startWatcher } from "./watcher";
import { startEmbedInterval } from "./embedder";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { deleteMemoryById } from "./delete-memory";
import * as qmdClient from "@kore/qmd-client";
import type { KorePlugin, PluginStartDeps } from "@kore/shared-types";

initLogger();

const dataPath = resolveDataPath();

// Ensure $KORE_HOME/data and $KORE_HOME/db exist before any SQLite connections
await ensureKoreDirectories();
await ensureDataDirectories(dataPath);

// ── Initialize QMD store ────────────────────────────────────────────────

const qmdDbPath = resolveQmdDbPath();

try {
  await qmdClient.initStore(qmdDbPath);
  console.log("QMD store initialized");
} catch (err) {
  console.error("Failed to initialize QMD store:", err);
  process.exit(1);
}

// ── Bootstrap tracking ──────────────────────────────────────────────────

let bootstrapping = false;

const qmdStatus = async (): Promise<QmdHealthSummary> => {
  try {
    const index = await qmdClient.getStatus();
    const health = await qmdClient.getIndexHealth();

    return {
      status: bootstrapping ? "bootstrapping" : "ok",
      doc_count: index.totalDocuments,
      collections: index.collections?.length || 0,
      needs_embedding: health.needsEmbedding,
    };
  } catch {
    return { status: "unavailable" };
  }
};

// ── Build memory index & start server ───────────────────────────────────

const queue = new QueueRepository(resolveQueueDbPath());
const memoryIndex = new MemoryIndex();
await memoryIndex.build(dataPath);
console.log(`Memory index built: ${memoryIndex.size} files indexed`);

const eventDispatcher = new EventDispatcher();

// ── Initialize plugins ──────────────────────────────────────────────────

// Plugin modules are imported explicitly (code-driven, not config-driven).
// To add a new plugin, import it here and add it to the plugins array.
const plugins: KorePlugin[] = [];

// Conditionally load test plugin for end-to-end validation
if (process.env.KORE_TEST_PLUGIN === "true") {
  const { default: testPlugin } = await import("@kore/plugin-test");
  plugins.push(testPlugin);
  console.log("Test plugin loaded (KORE_TEST_PLUGIN=true)");
}

// Create plugin registry from the same database instance as QueueRepository
const pluginRegistry = new PluginRegistryRepository(queue.getDatabase());

// Build PluginStartDeps for each plugin and call start()
for (const plugin of plugins) {
  if (plugin.start) {
    const deps: PluginStartDeps = {
      enqueue: (payload, priority) => queue.enqueue(payload, priority),
      deleteMemory: (id) => deleteMemoryById(id, { memoryIndex, eventDispatcher }),
      getMemoryIdByExternalKey: (externalKey) => pluginRegistry.get(plugin.name, externalKey),
      setExternalKeyMapping: (externalKey, memoryId) => pluginRegistry.set(plugin.name, externalKey, memoryId),
      removeExternalKeyMapping: (externalKey) => pluginRegistry.remove(plugin.name, externalKey),
      clearRegistry: () => pluginRegistry.clear(plugin.name),
    };

    try {
      await plugin.start(deps);
      console.log(`Plugin "${plugin.name}" started`);
    } catch (err) {
      console.error(`Plugin "${plugin.name}" failed to start (non-fatal):`, err);
    }
  }
}

// Register all plugins with EventDispatcher
eventDispatcher.registerPlugins(plugins);

const app = createApp({
  dataPath,
  queue,
  memoryIndex,
  eventDispatcher,
  qmdStatus,
  searchFn: qmdClient.search,
});

app.listen(3000);
console.log(`Kore Core API running on http://localhost:3000`);

// ── Background bootstrap (if index is empty) ───────────────────────────

try {
  const status = await qmdClient.getStatus();
  if (status.totalDocuments === 0) {
    bootstrapping = true;
    console.log("QMD index is empty, bootstrapping in background...");

    // Run update + embed asynchronously — do not block startup
    (async () => {
      try {
        await qmdClient.update();
        await qmdClient.embed();
        console.log("QMD bootstrap complete");
      } catch (err) {
        console.error("QMD bootstrap error (non-fatal):", err);
      } finally {
        bootstrapping = false;
      }
    })();
  }
} catch (err) {
  console.error("QMD status check failed (non-fatal):", err);
}

// ── Start background services ───────────────────────────────────────────

const worker = startWorker({ queue, dataPath, dispatcher: eventDispatcher });
console.log("Kore extraction worker started (polling every 5s)");

const watcher = startWatcher({ dataPath });
console.log("Kore file watcher started (watching for .md changes)");

const embedder = startEmbedInterval();
console.log("Kore embed interval started");

// ── Graceful shutdown ───────────────────────────────────────────────────

const PLUGIN_STOP_TIMEOUT_MS = 5_000;

async function shutdown() {
  console.log("Shutting down...");
  watcher.stop();
  embedder.stop();
  worker.stop();

  // Stop plugins gracefully with timeout
  for (const plugin of plugins) {
    if (plugin.stop) {
      try {
        await Promise.race([
          plugin.stop(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), PLUGIN_STOP_TIMEOUT_MS)
          ),
        ]);
        console.log(`Plugin "${plugin.name}" stopped`);
      } catch (err) {
        const msg = err instanceof Error && err.message === "timeout"
          ? `Plugin "${plugin.name}" stop() timed out after ${PLUGIN_STOP_TIMEOUT_MS}ms, continuing shutdown`
          : `Plugin "${plugin.name}" stop() failed: ${err}`;
        console.warn(msg);
      }
    }
  }

  await qmdClient.closeStore();
  console.log("QMD store closed");
  closeLogger();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

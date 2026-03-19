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
import { ConsolidationTracker } from "./consolidation-tracker";
import { createConsolidationEventHandlers } from "./consolidation-event-handlers";
import {
  startConsolidationLoop,
  buildConsolidationDeps,
  reconcileOnStartup,
} from "./consolidation-loop";
import type { ConsolidationHandle } from "./consolidation-loop";
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

// ── Initialize consolidation tracker & event handlers ───────────────
const consolidationTracker = new ConsolidationTracker(queue.getDatabase());

const consolidationHandlers = createConsolidationEventHandlers(
  consolidationTracker,
  qmdClient.search,
  memoryIndex,
  {
    relevanceThreshold: 0.5,
    cooldownDays: Number(process.env.CONSOLIDATION_COOLDOWN_DAYS) || 7,
  },
);

// Register consolidation handlers as a pseudo-plugin
const consolidationPlugin: KorePlugin = {
  name: "consolidation",
  onMemoryIndexed: (event) => consolidationHandlers.onMemoryIndexed(event),
  onMemoryDeleted: (event) => consolidationHandlers.onMemoryDeleted(event),
  onMemoryUpdated: (event) => consolidationHandlers.onMemoryUpdated(event),
};

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

// Conditionally load Apple Notes plugin
if (process.env.KORE_APPLE_NOTES_ENABLED === "true") {
  const { default: appleNotesPlugin } = await import("@kore/plugin-apple-notes");
  plugins.push(appleNotesPlugin);
  console.log("Apple Notes plugin loaded (KORE_APPLE_NOTES_ENABLED=true)");
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
      setExternalKeyMapping: (externalKey, memoryId, metadata?) => pluginRegistry.set(plugin.name, externalKey, memoryId, metadata),
      removeExternalKeyMapping: (externalKey) => pluginRegistry.remove(plugin.name, externalKey),
      clearRegistry: () => pluginRegistry.clear(plugin.name),
      listExternalKeys: () => pluginRegistry.listByPlugin(plugin.name),
    };

    try {
      await plugin.start(deps);
      console.log(`Plugin "${plugin.name}" started`);
    } catch (err) {
      console.error(`Plugin "${plugin.name}" failed to start (non-fatal):`, err);
    }
  }
}

// Register all plugins (including consolidation pseudo-plugin) with EventDispatcher
eventDispatcher.registerPlugins([consolidationPlugin, ...plugins]);

let app = createApp({
  dataPath,
  queue,
  memoryIndex,
  eventDispatcher,
  qmdStatus,
  searchFn: qmdClient.search,
  consolidationTracker,
  pluginRegistry,
});

// Mount plugin routes
for (const plugin of plugins) {
  if (plugin.routes) {
    try {
      plugin.routes(app as any);
      console.log(`Plugin "${plugin.name}" routes mounted`);
    } catch (err) {
      console.error(`Plugin "${plugin.name}" routes failed (non-fatal):`, err);
    }
  }
}

app.listen({ port: 3000, reusePort: false });
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

const worker = startWorker({ queue, dataPath, dispatcher: eventDispatcher, memoryIndex });
console.log("Kore extraction worker started (polling every 5s)");

const watcher = startWatcher({ dataPath });
console.log("Kore file watcher started (watching for .md changes)");

const embedder = startEmbedInterval();
console.log("Kore embed interval started");

// ── Start consolidation loop (step 10, after embedder) ──────────────

const consolidationDeps = buildConsolidationDeps({
  dataPath,
  qmdSearch: qmdClient.search,
  tracker: consolidationTracker,
  memoryIndex,
  eventDispatcher,
});

// Run startup reconciliation before starting loop
await reconcileOnStartup({ dataPath, tracker: consolidationTracker, memoryIndex });

const consolidation = startConsolidationLoop(consolidationDeps);
console.log("Kore consolidation loop started");

// ── Graceful shutdown ───────────────────────────────────────────────────

const PLUGIN_STOP_TIMEOUT_MS = 5_000;

async function shutdown() {
  console.log("Shutting down...");
  watcher.stop();
  embedder.stop();
  worker.stop();
  await consolidation.stop();

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

  try {
    await Promise.race([
      qmdClient.closeStore(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5_000)
      ),
    ]);
    console.log("QMD store closed");
  } catch {
    console.warn("QMD store close timed out, forcing exit");
  }
  closeLogger();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

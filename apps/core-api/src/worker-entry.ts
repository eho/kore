/**
 * Standalone entry point for the notification/extraction worker.
 *
 * Runs only the background extraction worker and file watcher,
 * without starting the HTTP API server. Used as the Docker Compose
 * command override for the `notification-worker` service.
 */
import { QueueRepository } from "./queue";
import { resolveDataPath, resolveQueueDbPath, resolveQmdDbPath, ensureKoreDirectories } from "./config";
import { ensureDataDirectories } from "./app";
import { startWorker } from "./worker";
import { startWatcher } from "./watcher";
import * as qmdClient from "@kore/qmd-client";

const dataPath = resolveDataPath();

// Ensure $KORE_HOME/data and $KORE_HOME/db exist before any SQLite connections
await ensureKoreDirectories();
await ensureDataDirectories(dataPath);

// ── Initialize QMD store ────────────────────────────────────────────────

const qmdDbPath = resolveQmdDbPath();

try {
  await qmdClient.initStore(qmdDbPath);
  console.log("QMD store initialized in worker");
} catch (err) {
  console.error("Failed to initialize QMD store in worker:", err);
  process.exit(1);
}

const queue = new QueueRepository(resolveQueueDbPath());

const worker = startWorker({ queue, dataPath });
console.log("Kore extraction worker started (polling every 5s)");

const watcher = startWatcher({ dataPath });
console.log("Kore file watcher started (watching for .md changes)");

// ── Graceful shutdown ───────────────────────────────────────────────────

async function shutdown() {
  console.log("Shutting down worker...");
  watcher.stop();
  worker.stop();
  await qmdClient.closeStore();
  console.log("QMD store closed");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

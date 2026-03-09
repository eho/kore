/**
 * Standalone entry point for the notification/extraction worker.
 *
 * Runs only the background extraction worker and file watcher,
 * without starting the HTTP API server. Used as the Docker Compose
 * command override for the `notification-worker` service.
 */
import { QueueRepository } from "./queue";
import { resolveDataPath, resolveQueueDbPath } from "./config";
import { ensureDataDirectories } from "./app";
import { startWorker } from "./worker";
import { startWatcher } from "./watcher";

const dataPath = resolveDataPath();

await ensureDataDirectories(dataPath);

const queue = new QueueRepository(resolveQueueDbPath());

const worker = startWorker({ queue, dataPath });
console.log("Kore extraction worker started (polling every 5s)");

const watcher = startWatcher({ dataPath });
console.log("Kore file watcher started (watching for .md changes)");

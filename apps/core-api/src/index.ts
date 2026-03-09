import { createApp, ensureDataDirectories } from "./app";
import { QueueRepository } from "./queue";
import { resolveDataPath, resolveQueueDbPath } from "./config";
import { startWorker } from "./worker";
import { startWatcher } from "./watcher";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";

const dataPath = resolveDataPath();

// Ensure data directories exist on startup
await ensureDataDirectories(dataPath);

const queue = new QueueRepository(resolveQueueDbPath());
const memoryIndex = new MemoryIndex();
await memoryIndex.build(dataPath);
console.log(`Memory index built: ${memoryIndex.size} files indexed`);

const eventDispatcher = new EventDispatcher();
const app = createApp({ dataPath, queue, memoryIndex, eventDispatcher });

app.listen(3000);
console.log(`Kore Core API running on http://localhost:3000`);

// Start background extraction worker
const worker = startWorker({ queue, dataPath });
console.log("Kore extraction worker started (polling every 5s)");

// Start file watcher for QMD re-indexing
const watcher = startWatcher({ dataPath });
console.log("Kore file watcher started (watching for .md changes)");

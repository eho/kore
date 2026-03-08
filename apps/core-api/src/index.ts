import { createApp, ensureDataDirectories } from "./app";
import { QueueRepository } from "./queue";
import { resolveDataPath } from "./config";
import { startWorker } from "./worker";

const dataPath = resolveDataPath();

// Ensure data directories exist on startup
await ensureDataDirectories(dataPath);

const queue = new QueueRepository();
const app = createApp({ dataPath, queue });

app.listen(3000);
console.log(`Kore Core API running on http://localhost:3000`);

// Start background extraction worker
const worker = startWorker({ queue, dataPath });
console.log("Kore extraction worker started (polling every 5s)");

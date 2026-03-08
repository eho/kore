import { createApp, ensureDataDirectories } from "./app";
import { resolveDataPath } from "./config";

const dataPath = resolveDataPath();

// Ensure data directories exist on startup
await ensureDataDirectories(dataPath);

const app = createApp({ dataPath });

app.listen(3000);

console.log(`Kore Core API running on http://localhost:3000`);

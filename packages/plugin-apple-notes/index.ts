import type { KorePlugin, PluginStartDeps, MemoryEvent } from "@kore/shared-types";
import { startSyncLoop, type SyncLoopOpts } from "./sync-loop";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

let deps: PluginStartDeps | null = null;
let syncHandle: { stop: () => void } | null = null;

const appleNotesPlugin: KorePlugin = {
  name: "apple-notes",

  async start(d: PluginStartDeps) {
    deps = d;

    // Resolve staging directory
    const koreHome = process.env.KORE_HOME || join(process.env.HOME || "~", ".kore");
    const stagingDir = join(koreHome, "staging", "apple-notes");

    // Create staging directories
    await mkdir(join(stagingDir, "notes"), { recursive: true });
    await mkdir(join(stagingDir, "attachments"), { recursive: true });

    // Read config from env vars
    const intervalMs = process.env.KORE_AN_SYNC_INTERVAL_MS
      ? parseInt(process.env.KORE_AN_SYNC_INTERVAL_MS, 10)
      : undefined;
    const includeHandwriting = process.env.KORE_AN_INCLUDE_HANDWRITING === "true";
    const folderAllowlist = process.env.KORE_AN_FOLDER_ALLOWLIST
      ? process.env.KORE_AN_FOLDER_ALLOWLIST.split(",").map((s) => s.trim())
      : undefined;
    const folderBlocklist = process.env.KORE_AN_FOLDER_BLOCKLIST
      ? process.env.KORE_AN_FOLDER_BLOCKLIST.split(",").map((s) => s.trim())
      : undefined;

    const opts: SyncLoopOpts = {
      stagingDir,
      intervalMs,
      includeHandwriting,
      folderAllowlist,
      folderBlocklist,
    };

    syncHandle = startSyncLoop(deps, opts);
    console.log(`[apple-notes] Plugin started (staging: ${stagingDir})`);
  },

  async stop() {
    if (syncHandle) {
      syncHandle.stop();
      syncHandle = null;
    }
    deps = null;
    console.log("[apple-notes] Plugin stopped");
  },

  async onMemoryIndexed(event: MemoryEvent) {
    if (!deps) return;

    // Only handle apple_notes source events
    if (event.frontmatter.source !== "apple_notes") return;

    // Must have a taskId to resolve
    if (!event.taskId) return;

    // Scan registry for a matching pending:{taskId} entry
    const entries = deps.listExternalKeys();
    const pendingKey = `pending:${event.taskId}`;

    for (const entry of entries) {
      if (entry.memoryId === pendingKey) {
        deps.setExternalKeyMapping(entry.externalKey, event.id);
        console.log(
          `[apple-notes] Resolved pending entry: ${entry.externalKey} → ${event.id}`,
        );
        return;
      }
    }
  },
};

export default appleNotesPlugin;

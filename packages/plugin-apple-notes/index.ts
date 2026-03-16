import type { KorePlugin, PluginStartDeps, MemoryEvent } from "@kore/shared-types";
import { startSyncLoop, type SyncLoopOpts, type SyncLoopHandle } from "./sync-loop";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Elysia } from "elysia";

let deps: PluginStartDeps | null = null;
let syncHandle: SyncLoopHandle | null = null;
let pluginStagingDir: string = "";

const appleNotesPlugin: KorePlugin = {
  name: "apple-notes",

  async start(d: PluginStartDeps) {
    deps = d;

    // Resolve staging directory
    const koreHome = process.env.KORE_HOME || join(process.env.HOME || "~", ".kore");
    const stagingDir = join(koreHome, "staging", "apple-notes");
    pluginStagingDir = stagingDir;

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

  routes(app: Elysia): any {
    return app
      .get("/api/v1/plugins/apple-notes/status", () => {
        const state = syncHandle?.getState();
        const trackedNotes = deps?.listExternalKeys().length ?? 0;
        const nextSyncInSeconds = state?.nextSyncAt
          ? Math.max(0, Math.round((state.nextSyncAt - Date.now()) / 1000))
          : null;

        return {
          enabled: true,
          last_sync_at: state?.lastSyncAt ?? null,
          last_sync_result: state?.lastSyncResult ?? null,
          total_tracked_notes: trackedNotes,
          next_sync_in_seconds: nextSyncInSeconds,
          staging_path: pluginStagingDir,
        };
      })
      .post("/api/v1/plugins/apple-notes/sync", async ({ set }) => {
        if (!syncHandle) {
          set.status = 503;
          return { error: "Apple Notes plugin is not running" };
        }

        // Trigger sync in the background (don't await in the response)
        syncHandle.triggerSync();

        set.status = 202;
        return { status: "sync_triggered", message: "Sync cycle started" };
      });
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

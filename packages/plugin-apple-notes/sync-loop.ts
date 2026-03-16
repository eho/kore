import { join } from "node:path";
import { syncNotes, type SyncManifest } from "@kore/an-export";
import type { PluginStartDeps } from "@kore/shared-types";
import { buildIngestContent } from "./content-builder";

export type SyncNotesFn = typeof syncNotes;

export interface SyncLoopOpts {
  /** Absolute path to the staging directory (e.g. $KORE_HOME/staging/apple-notes) */
  stagingDir: string;
  /** Sync interval in milliseconds (default: 900_000 = 15 min) */
  intervalMs?: number;
  /** Include handwriting summary text */
  includeHandwriting?: boolean;
  /** Comma-separated folder allowlist (e.g. "Work,Personal") */
  folderAllowlist?: string[];
  /** Comma-separated folder blocklist (e.g. "Archive,Old") */
  folderBlocklist?: string[];
  /** Override syncNotes for testing */
  _syncNotesFn?: SyncNotesFn;
}

const DEFAULT_INTERVAL_MS = 900_000; // 15 minutes
const INITIAL_DELAY_MS = 10_000; // 10 seconds

/**
 * Returns true if the note's folder path passes the allowlist/blocklist filter.
 * The folder path comes from the manifest entry's `path` field (e.g. "Work/Projects/Q1.md").
 */
export function passesFilter(
  notePath: string,
  allowlist?: string[],
  blocklist?: string[],
): boolean {
  // Extract top-level folder from path (first segment before /)
  const segments = notePath.split("/");
  // If the note is at root level (no folder), it passes by default
  if (segments.length <= 1) return true;
  const topFolder = segments[0];

  // Blocklist takes precedence
  if (blocklist && blocklist.length > 0) {
    if (blocklist.some((b) => topFolder.toLowerCase() === b.toLowerCase())) {
      return false;
    }
  }

  // If allowlist is set, only allow listed folders
  if (allowlist && allowlist.length > 0) {
    return allowlist.some((a) => topFolder.toLowerCase() === a.toLowerCase());
  }

  return true;
}

/**
 * Run a single sync cycle: export notes, diff manifest, enqueue/delete as needed.
 */
export async function runSyncCycle(
  deps: PluginStartDeps,
  opts: SyncLoopOpts,
): Promise<{ newNotes: number; deletedNotes: number; updatedNotes: number; skipped: number }> {
  const stagingNotesDir = join(opts.stagingDir, "notes");
  const syncFn = opts._syncNotesFn ?? syncNotes;

  // 1. Call syncNotes to export/update notes to staging
  await syncFn({
    dest: stagingNotesDir,
    omitFirstLine: false,
    includeTrashed: false,
    includeHandwriting: opts.includeHandwriting ?? false,
  });

  // 2. Load the manifest
  const manifestPath = join(stagingNotesDir, "an-export-manifest.json");
  const manifestFile = Bun.file(manifestPath);
  let manifest: SyncManifest;
  try {
    manifest = await manifestFile.json() as SyncManifest;
  } catch {
    console.warn("[apple-notes] Could not load manifest, skipping cycle");
    return { newNotes: 0, deletedNotes: 0, updatedNotes: 0, skipped: 0 };
  }

  // 3. Get current registry entries
  const registryEntries = deps.listExternalKeys();
  const registryMap = new Map(
    registryEntries.map((e) => [e.externalKey, { memoryId: e.memoryId, metadata: e.metadata }]),
  );

  // 4. Build set of manifest Z_PKs
  const manifestKeys = new Set(Object.keys(manifest.notes));

  let newNotes = 0;
  let deletedNotes = 0;
  let updatedNotes = 0;
  let skipped = 0;

  // 5. Process manifest entries (new + updated notes)
  for (const [zpk, entry] of Object.entries(manifest.notes)) {
    // Apply folder filtering
    if (!passesFilter(entry.path, opts.folderAllowlist, opts.folderBlocklist)) {
      skipped++;
      continue;
    }

    const existing = registryMap.get(zpk);

    if (!existing) {
      // NEW note — not in registry
      const absolutePath = join(stagingNotesDir, entry.path);
      const content = await buildIngestContent(absolutePath, `notes/${entry.path}`, entry.title);
      if (!content) {
        skipped++;
        continue;
      }

      const taskId = deps.enqueue(
        { source: "apple_notes", content },
        "low",
      );
      const metadata = JSON.stringify({ mtime: entry.mtime });
      deps.setExternalKeyMapping(zpk, `pending:${taskId}`, metadata);
      newNotes++;
    } else if (existing.memoryId.startsWith("pending:")) {
      // PENDING — still waiting for worker, skip
      skipped++;
    } else {
      // RESOLVED entry — check if an-export re-exported it (meaning it was updated)
      // an-export's syncNotes() only re-exports modified files, so if the file
      // is in the manifest with a different mtime, it was updated
      const existingMeta = existing.metadata ? JSON.parse(existing.metadata) : null;
      const previousMtime = existingMeta?.mtime;

      if (previousMtime != null && entry.mtime !== previousMtime) {
        // UPDATED — delete old memory and re-enqueue
        await deps.deleteMemory(existing.memoryId);
        deps.removeExternalKeyMapping(zpk);

        const absolutePath = join(stagingNotesDir, entry.path);
        const content = await buildIngestContent(absolutePath, `notes/${entry.path}`, entry.title);
        if (!content) {
          skipped++;
          continue;
        }

        const taskId = deps.enqueue(
          { source: "apple_notes", content },
          "low",
        );
        const metadata = JSON.stringify({ mtime: entry.mtime });
        deps.setExternalKeyMapping(zpk, `pending:${taskId}`, metadata);
        updatedNotes++;
      } else {
        // Unchanged
        skipped++;
      }
    }
  }

  // 6. Detect deleted notes (in registry but not in manifest)
  for (const [externalKey, entry] of registryMap) {
    if (!manifestKeys.has(externalKey)) {
      // Note was deleted from Apple Notes
      if (!entry.memoryId.startsWith("pending:")) {
        await deps.deleteMemory(entry.memoryId);
      }
      deps.removeExternalKeyMapping(externalKey);
      deletedNotes++;
    }
  }

  return { newNotes, deletedNotes, updatedNotes, skipped };
}

export interface SyncLoopState {
  lastSyncAt: string | null;
  lastSyncResult: "success" | "error" | null;
  nextSyncAt: number | null;
}

export interface SyncLoopHandle {
  stop: () => void;
  getState: () => SyncLoopState;
  triggerSync: () => Promise<void>;
}

/**
 * Start the background sync loop. Returns a handle with stop(), getState(), and triggerSync().
 */
export function startSyncLoop(
  deps: PluginStartDeps,
  opts: SyncLoopOpts,
): SyncLoopHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSyncAt: string | null = null;
  let lastSyncResult: "success" | "error" | null = null;
  let nextSyncAt: number | null = null;

  async function cycle() {
    if (stopped) return;
    if (running) {
      console.log("[apple-notes] Previous sync cycle still running, skipping");
      return;
    }

    running = true;
    try {
      const result = await runSyncCycle(deps, opts);
      lastSyncAt = new Date().toISOString();
      lastSyncResult = "success";
      console.log(
        `[apple-notes] Sync complete: ${result.newNotes} new, ${result.updatedNotes} updated, ${result.deletedNotes} deleted, ${result.skipped} skipped`,
      );
    } catch (err) {
      lastSyncAt = new Date().toISOString();
      lastSyncResult = "error";
      console.error("[apple-notes] Sync cycle error (non-fatal):", err);
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    nextSyncAt = Date.now() + intervalMs;
    timer = setTimeout(async () => {
      await cycle();
      scheduleNext();
    }, intervalMs);
  }

  // Initial delay before first cycle
  nextSyncAt = Date.now() + INITIAL_DELAY_MS;
  timer = setTimeout(async () => {
    await cycle();
    scheduleNext();
  }, INITIAL_DELAY_MS);

  return {
    stop() {
      stopped = true;
      nextSyncAt = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    getState() {
      return { lastSyncAt, lastSyncResult, nextSyncAt };
    },
    async triggerSync() {
      await cycle();
      // Reset the timer so the next scheduled cycle is a full interval away
      if (!stopped && timer) {
        clearTimeout(timer);
        scheduleNext();
      }
    },
  };
}

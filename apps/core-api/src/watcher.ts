import { watch, type FSWatcher } from "node:fs";
import { update } from "@kore/qmd-client";

const DEFAULT_DEBOUNCE_MS = 2_000;

export interface WatcherDeps {
  dataPath: string;
  debounceMs?: number;
  updateFn?: typeof update;
}

export interface WatcherHandle {
  stop: () => void;
}

/**
 * Create a debounced file watcher that triggers QMD re-indexing
 * when `.md` files change in `$KORE_DATA_PATH`.
 *
 * Debounces changes by waiting `debounceMs` (default 2s) after the
 * last write event before calling `qmdClient.update()`.
 */
export function startWatcher(deps: WatcherDeps): WatcherHandle {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const updateFn = deps.updateFn ?? update;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  function scheduleUpdate() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        const result = await updateFn();
        console.log(`Watcher: QMD update complete (indexed: ${result.indexed}, updated: ${result.updated})`);
      } catch (err) {
        console.error("Watcher: QMD update error:", err);
      }
    }, debounceMs);
  }

  watcher = watch(deps.dataPath, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith(".md")) {
      scheduleUpdate();
    }
  });

  return {
    stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

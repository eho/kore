import { watch, type FSWatcher } from "node:fs";
import { update } from "@kore/qmd-client";

const DEFAULT_DEBOUNCE_MS = 2_000;
// After a no-op update (0 indexed, 0 updated), suppress further events for
// this long. Prevents cascading spurious FSEvents from OS metadata activity.
const NOOP_COOLDOWN_MS = 30_000;

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
 *
 * Inflight guard: at most one updateFn() runs at a time. Events that
 * arrive while updateFn() is running are collapsed into a single
 * follow-up. This prevents the FSEvents cascade where QMD reading
 * files triggers OS metadata events which schedule more updates.
 */
export function startWatcher(deps: WatcherDeps): WatcherHandle {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const updateFn = deps.updateFn ?? update;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let noopCooldownUntil = 0;
  let pendingDuringCooldown = false;
  let stopped = false;
  let inflight = false;
  let pendingWhileInflight = false;
  let watcher: FSWatcher | null = null;

  function scheduleUpdate() {
    if (stopped) return;

    // While updateFn() is running, collapse all events into one follow-up.
    // Without this, FSEvents fired by QMD reading files during updateFn()
    // set debounce timers that fire after the noop cooldown is set but
    // were scheduled before it — bypassing the cooldown entirely.
    if (inflight) {
      pendingWhileInflight = true;
      return;
    }

    if (Date.now() < noopCooldownUntil) {
      // We're in the no-op cooldown window, but remember that a real event came
      // in so we run update() once when the cooldown expires.
      pendingDuringCooldown = true;
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      if (stopped) return;
      inflight = true;
      pendingWhileInflight = false;
      try {
        const result = await updateFn();
        if (stopped) return;
        console.log(`Watcher: QMD update complete (indexed: ${result.indexed}, updated: ${result.updated})`);
        if (result.indexed === 0 && result.updated === 0) {
          noopCooldownUntil = Date.now() + NOOP_COOLDOWN_MS;
          // Discard any events that fired during the noop update —
          // they were caused by QMD reading files, not real writes.
          pendingWhileInflight = false;
          // Schedule a deferred check in case a real write lands during cooldown
          cooldownTimer = setTimeout(() => {
            cooldownTimer = null;
            if (pendingDuringCooldown) scheduleUpdate();
          }, NOOP_COOLDOWN_MS);
        }
      } catch (err) {
        console.error("Watcher: QMD update error:", err);
      } finally {
        inflight = false;
        if (pendingWhileInflight && !stopped) {
          pendingWhileInflight = false;
          scheduleUpdate(); // goes through cooldown check
        }
      }
    }, debounceMs);
  }

  watcher = watch(deps.dataPath, { recursive: true }, (_eventType, filename) => {
    if (filename && filename.endsWith(".md")) {
      scheduleUpdate();
    }
  });

  return {
    stop() {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (cooldownTimer) {
        clearTimeout(cooldownTimer);
        cooldownTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

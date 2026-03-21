import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { MemoryIndex } from "./memory-index";
import type { EventDispatcher } from "./event-dispatcher";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import { parseFrontmatter } from "./lib/frontmatter";
import {
  runConsolidationCycle,
  runConsolidationDryRun,
} from "./consolidation-cycle";
import type {
  ConsolidationDeps,
  ConsolidationCycleResult,
  DryRunResult,
} from "./consolidation-cycle";

// Re-export so existing imports from ./consolidation-loop continue to work
export { runConsolidationCycle, runConsolidationDryRun };
export type { ConsolidationDeps, ConsolidationCycleResult, DryRunResult };

// ─── Types ───────────────────────────────────────────────────────────

export interface ConsolidationHandle {
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => void;
}

// ─── Startup Reconciliation (design doc §7.1) ────────────────────────

/**
 * Run startup consistency check between tracker and filesystem.
 */
export async function reconcileOnStartup(deps: Pick<ConsolidationDeps, "dataPath" | "tracker" | "memoryIndex">): Promise<void> {
  const { dataPath, tracker, memoryIndex } = deps;

  // Forward check: for each active insight in tracker, verify file exists on disk
  const insightsDir = join(dataPath, "insights");
  let insightFiles: string[];
  try {
    insightFiles = (await readdir(insightsDir)).filter((f) => f.endsWith(".md"));
  } catch {
    insightFiles = [];
  }

  // Build set of insight IDs found on disk
  const diskInsightIds = new Set<string>();
  for (const file of insightFiles) {
    const filePath = join(insightsDir, file);
    try {
      const content = await Bun.file(filePath).text();
      const fm = parseFrontmatter(content);
      if (fm.id) {
        diskInsightIds.add(fm.id);
      }
    } catch {
      continue;
    }
  }

  // Forward: remove tracker entries for insights not on disk
  for (const [id] of memoryIndex.entries()) {
    if (!id.startsWith("ins-")) continue;
    const status = tracker.getStatus(id);
    if (status && status.status === "active" && !diskInsightIds.has(id)) {
      // Insight in tracker but not on disk — remove
      tracker.markRetired(id);
      console.log(`[consolidation] Reconciliation: retired orphaned tracker entry ${id}`);
    }
  }

  // Backward check: for each insight file on disk, ensure tracker entry exists
  for (const id of diskInsightIds) {
    const status = tracker.getStatus(id);
    if (!status) {
      tracker.upsertMemory(id, "insight");
      tracker.markConsolidated(id);
      console.log(`[consolidation] Reconciliation: added tracker entry for ${id}`);
    }
  }

  // Backfill: ensure all indexed memories are in the tracker.
  // Handles memories ingested before the consolidation system was added.
  // upsertMemory is INSERT ... ON CONFLICT DO NOTHING, so this is a no-op
  // for memories already tracked.
  let backfilled = 0;
  for (const [id, filePath] of memoryIndex.entries()) {
    if (id.startsWith("ins-")) continue; // insights handled above
    const existing = tracker.getStatus(id);
    if (!existing) {
      // Infer type from directory name
      const type = filePath.includes("/people/") ? "person"
        : filePath.includes("/places/") ? "place"
        : filePath.includes("/media/") ? "media"
        : "note";
      tracker.upsertMemory(id, type);
      backfilled++;
    }
  }
  if (backfilled > 0) {
    console.log(`[consolidation] Reconciliation: backfilled ${backfilled} memories into tracker`);
  }
}

// ─── Consolidation Loop ──────────────────────────────────────────────

/**
 * Start the consolidation loop as a background service.
 * Uses a boolean concurrency guard — skips a cycle if a previous one is still running.
 */
export function startConsolidationLoop(deps: ConsolidationDeps): ConsolidationHandle {
  let running = false;
  let stopped = false;
  let paused = false;
  let resolveInProgress: (() => void) | null = null;

  async function cycle() {
    if (stopped || paused) return;
    if (running) {
      console.log("[consolidation] Previous cycle still running, skipping");
      return;
    }

    running = true;
    try {
      const result = await runConsolidationCycle(deps);
      if (result.status === "consolidated") {
        console.log(
          `[consolidation] Cycle complete: created insight ${result.insightId} from seed "${result.seed?.title}" (cluster: ${result.clusterSize})`,
        );
      } else if (result.status === "no_seed") {
        console.debug("[consolidation] No seed available, skipping cycle");
      } else if (result.status === "cluster_too_small") {
        console.log(
          `[consolidation] Cluster too small for seed "${result.seed?.title}" (${result.candidateCount} candidates)`,
        );
      } else if (result.status === "retired_reeval") {
        console.log(`[consolidation] Retired re-eval seed "${result.seed?.title}" (insufficient sources)`);
      } else if (result.status === "synthesis_failed") {
        console.log(`[consolidation] Synthesis failed for seed "${result.seed?.title}", marked as failed`);
      }
    } catch (err) {
      console.error("[consolidation] Cycle error:", err);
    } finally {
      running = false;
      if (resolveInProgress) {
        resolveInProgress();
        resolveInProgress = null;
      }
    }
  }

  const handle = setInterval(cycle, deps.intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(handle);
      if (running) {
        // Wait for in-progress cycle to finish
        await new Promise<void>((resolve) => {
          resolveInProgress = resolve;
        });
      }
    },
    async pause() {
      paused = true;
      if (running) {
        // Wait for in-progress cycle to finish
        await new Promise<void>((resolve) => {
          resolveInProgress = resolve;
        });
      }
    },
    resume() {
      paused = false;
    },
  };
}

// ─── Default Deps Factory ────────────────────────────────────────────

type QmdSearchFn = (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;

/**
 * Build ConsolidationDeps from environment and runtime dependencies.
 */
export function buildConsolidationDeps(params: {
  dataPath: string;
  qmdSearch: QmdSearchFn;
  tracker: ConsolidationTracker;
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
}): ConsolidationDeps {
  return {
    ...params,
    intervalMs: Number(process.env.CONSOLIDATION_INTERVAL_MS) || 1_800_000,
    minClusterSize: 3,
    maxClusterSize: 8,
    minSimilarityScore: 0.45,
    cooldownDays: Number(process.env.CONSOLIDATION_COOLDOWN_DAYS) || 7,
    maxSynthesisAttempts: Number(process.env.CONSOLIDATION_MAX_ATTEMPTS) || 3,
    relevanceThreshold: 0.5,
  };
}

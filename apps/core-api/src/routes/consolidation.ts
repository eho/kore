import { Elysia, t } from "elysia";
import { resetConsolidation } from "../consolidation-reset";
import type { MemoryIndex } from "../memory-index";
import type { EventDispatcher } from "../event-dispatcher";
import type { ConsolidationTracker } from "../consolidation-tracker";
import type { ConsolidationHandle } from "../consolidation-loop";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import { consolidate as consolidateOp } from "../operations";
import type { ConsolidateInput } from "../operations";

interface ConsolidationDeps {
  dataPath: string;
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
  consolidationTracker?: ConsolidationTracker;
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
  consolidationLoopHandle?: ConsolidationHandle;
  qmdUpdateFn?: () => Promise<unknown>;
}

export function createConsolidationRoutes(deps: ConsolidationDeps) {
  const { dataPath, searchFn, consolidationTracker, memoryIndex, eventDispatcher, consolidationLoopHandle, qmdUpdateFn } = deps;

  return new Elysia()
    // ─── Consolidate ─────────────────────────────────────────────
    .post("/api/v1/consolidate", async ({ body, query, set }) => {
      // Support reset_failed as query param (backward compat) or body param
      const resetFailed = query.reset_failed === "true" || (body as any)?.reset_failed === true;
      if (resetFailed) {
        if (consolidationTracker) consolidationTracker.resetFailed();
      }

      const params = (body ?? {}) as ConsolidateInput;
      // Also accept dry_run from query param for backward compat
      if (query.dry_run === "true") params.dry_run = true;

      try {
        return await consolidateOp(params, {
          dataPath,
          qmdSearch: searchFn!,
          consolidationTracker,
          memoryIndex,
          eventDispatcher,
          consolidationLoopHandle,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = message.includes("not available") ? 503 : 500;
        return { error: message };
      }
    }, { body: t.Any() })
    // ─── Reset Consolidation ─────────────────────────────────────
    .delete("/api/v1/consolidation", async ({ set }) => {
      if (!consolidationTracker || !dataPath) {
        set.status = 503;
        return { error: "Consolidation service not available" };
      }

      try {
        if (consolidationLoopHandle) await consolidationLoopHandle.pause();

        const result = await resetConsolidation({
          dataPath,
          tracker: consolidationTracker,
          memoryIndex,
          qmdUpdate: qmdUpdateFn ?? (async () => {}),
        });

        return {
          status: "reset",
          deleted_insights: result.deletedInsights,
          restored_memories: result.restoredMemories,
          tracker_backfilled: result.trackerBackfilled,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[consolidation-reset] Reset failed:", message);
        set.status = 500;
        return { error: message, code: "RESET_FAILED" };
      } finally {
        if (consolidationLoopHandle) consolidationLoopHandle.resume();
      }
    });
}

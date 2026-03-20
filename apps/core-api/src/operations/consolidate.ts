import type { OperationDeps, ConsolidateInput, ConsolidateOutput } from "./types";
import { runConsolidationCycle, runConsolidationDryRun, buildConsolidationDeps } from "../consolidation-loop";

export async function consolidate(
  params: ConsolidateInput,
  deps: Pick<OperationDeps, "dataPath" | "qmdSearch" | "consolidationTracker" | "memoryIndex" | "eventDispatcher" | "consolidationLoopHandle">
): Promise<ConsolidateOutput> {
  const tracker = deps.consolidationTracker;
  if (!tracker || !deps.qmdSearch) {
    throw new Error("Consolidation service not available");
  }

  const consolidationDeps = buildConsolidationDeps({
    dataPath: deps.dataPath,
    qmdSearch: deps.qmdSearch,
    tracker,
    memoryIndex: deps.memoryIndex,
    eventDispatcher: deps.eventDispatcher!,
  });

  // Pause the background loop to prevent duplicate insights
  const loopHandle = deps.consolidationLoopHandle;
  if (loopHandle) await loopHandle.pause();

  try {
    if (params.dry_run) {
      const result = await runConsolidationDryRun(consolidationDeps);

      // Serialize to snake_case for MCP consistency
      if (result.status === "dry_run") {
        return {
          status: "dry_run",
          seed: result.seed,
          candidates: result.candidates,
          proposed_insight_type: result.proposedInsightType,
          estimated_confidence: result.estimatedConfidence,
          candidate_count: result.candidates?.length,
        };
      }
      if (result.status === "cluster_too_small") {
        return {
          status: "cluster_too_small" as const,
          seed: result.seed,
          candidate_count: result.candidateCount,
        };
      }
      return { status: "no_seed" };
    }

    const result = await runConsolidationCycle(consolidationDeps);

    // Serialize to snake_case
    const output: ConsolidateOutput = {
      status: result.status,
    };
    if (result.seed) output.seed = result.seed;
    if (result.insightId) output.insight_id = result.insightId;
    if (result.clusterSize) output.cluster_size = result.clusterSize;
    if (result.candidateCount !== undefined) output.candidate_count = result.candidateCount;

    return output;
  } finally {
    if (loopHandle) loopHandle.resume();
  }
}

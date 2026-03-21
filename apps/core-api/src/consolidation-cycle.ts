import { parseFrontmatter } from "./lib/frontmatter";
import {
  findCandidates,
  validateCluster,
  classifyCluster,
} from "./consolidation-candidate-finder";
import type { SeedMemory, CandidateResult, CandidateDebugInfo } from "./consolidation-candidate-finder";
import { synthesizeInsight, computeInsightConfidence } from "./consolidation-synthesizer";
import {
  writeInsight,
  checkDedup,
  supersede,
  updateSourceFrontmatter,
} from "./consolidation-writer";
import {
  loadSeedFromDisk,
  loadClusterMemberFiles,
  enrichCandidatesWithFiles,
  getExistingInsights,
} from "./consolidation-loaders";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { MemoryIndex } from "./memory-index";
import type { EventDispatcher } from "./event-dispatcher";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";

// ─── Types ───────────────────────────────────────────────────────────

type QmdSearchFn = (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;

export interface ConsolidationDeps {
  dataPath: string;
  qmdSearch: QmdSearchFn;
  tracker: ConsolidationTracker;
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
  intervalMs: number;
  minClusterSize: number;
  maxClusterSize: number;
  minSimilarityScore: number;
  cooldownDays: number;
  maxSynthesisAttempts: number;
  relevanceThreshold: number;
}

export interface ConsolidationCycleResult {
  status: "consolidated" | "no_seed" | "cluster_too_small" | "retired_reeval" | "synthesis_failed";
  insightId?: string;
  seed?: { id: string; title: string };
  clusterSize?: number;
  candidateCount?: number;
  debug?: CandidateDebugInfo;
}

export interface DryRunResult {
  status: "dry_run" | "no_seed" | "cluster_too_small";
  seed?: { id: string; title: string };
  candidates?: Array<{ id: string; title: string; score: number }>;
  proposedInsightType?: string;
  estimatedConfidence?: number;
  candidateCount?: number;
  debug?: CandidateDebugInfo;
}

// ─── Consolidation Cycle ─────────────────────────────────────────────

/**
 * Run one full consolidation cycle. Exported for API endpoint use.
 */
export async function runConsolidationCycle(deps: ConsolidationDeps): Promise<ConsolidationCycleResult> {
  const {
    dataPath,
    qmdSearch,
    tracker,
    memoryIndex,
    eventDispatcher,
    minClusterSize,
    maxClusterSize,
    minSimilarityScore,
    cooldownDays,
    maxSynthesisAttempts,
  } = deps;

  // 1. Select seed
  const seedResult = tracker.selectSeed(cooldownDays, maxSynthesisAttempts);
  if (!seedResult) {
    console.log("[consolidation] No eligible seed found in tracker");
    return { status: "no_seed" };
  }

  const { memoryId: seedId, isReeval } = seedResult;

  // 2. Load seed memory
  const seedPath = memoryIndex.get(seedId);
  if (!seedPath) {
    console.log(`[consolidation] Seed ${seedId} not found in memory index, marking failed`);
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return { status: "no_seed" };
  }

  const seed = await loadSeedFromDisk(seedPath);
  if (!seed) {
    console.log(`[consolidation] Failed to load seed file at ${seedPath}, marking failed`);
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return { status: "no_seed" };
  }

  console.log(`[consolidation] Selected seed: "${seed.title}" (${seedId}, isReeval=${isReeval})`);
  console.log(`[consolidation] Seed has ${seed.distilledItems.length} distilled item(s), type=${seed.type}, category=${seed.category}`);

  let candidates: CandidateResult[];
  let candidateDebug: CandidateDebugInfo | undefined;
  let existingInsightId: string | undefined;
  let reinforcementCount = 0;

  if (isReeval) {
    // 3a. Re-eval path: load existing insight's source_ids, resolve remaining sources
    const content = await Bun.file(seedPath).text();
    const insightFm = parseFrontmatter(content);
    const sourceIds: string[] = Array.isArray(insightFm.source_ids) ? (insightFm.source_ids as string[]) : [];
    existingInsightId = seedId;
    reinforcementCount = Number(insightFm.reinforcement_count ?? 0) + 1;

    // Resolve which sources still exist
    const remainingSources: SeedMemory[] = [];
    for (const srcId of sourceIds) {
      const srcPath = memoryIndex.get(srcId);
      if (srcPath) {
        const src = await loadSeedFromDisk(srcPath);
        if (src) remainingSources.push(src);
      }
    }

    if (remainingSources.length < minClusterSize) {
      // Retire the insight — not enough sources remaining
      tracker.markRetired(seedId);
      return { status: "retired_reeval", seed: { id: seedId, title: seed.title } };
    }

    // Search QMD for additional candidates using insight's title + distilled items
    const { candidates: rawCandidates, debug } = await findCandidates(
      { ...seed, id: seedId },
      qmdSearch,
      { maxClusterSize, minSimilarityScore },
    );
    candidateDebug = debug;
    candidates = await enrichCandidatesWithFiles(rawCandidates, memoryIndex, dataPath);
    console.log(`[consolidation] Enriched ${rawCandidates.length} → ${candidates.length} candidate(s) (${rawCandidates.length - candidates.length} missing from memoryIndex)`);

    // Merge remaining known sources (if not already in candidates)
    const candidateIds = new Set(candidates.map((c) => c.memoryId));
    for (const src of remainingSources) {
      if (!candidateIds.has(src.id)) {
        candidates.push({
          memoryId: src.id,
          filePath: src.filePath,
          score: 1.0, // existing source gets max score
          frontmatter: { type: src.type, category: src.category, date_saved: src.date_saved },
        });
      }
    }
  } else {
    // 3b. New seed path
    const { candidates: rawCandidates, debug } = await findCandidates(seed, qmdSearch, { maxClusterSize, minSimilarityScore });
    candidateDebug = debug;
    candidates = await enrichCandidatesWithFiles(rawCandidates, memoryIndex, dataPath);
    console.log(`[consolidation] Enriched ${rawCandidates.length} → ${candidates.length} candidate(s) (${rawCandidates.length - candidates.length} missing from memoryIndex)`);
  }

  // 4. Validate cluster size
  const validation = validateCluster(seed, candidates, { minClusterSize, maxClusterSize });
  if (!validation.valid) {
    console.log(`[consolidation] Cluster validation failed: ${validation.reason}`);
    if (isReeval) {
      tracker.markRetired(seedId);
      return { status: "retired_reeval", seed: { id: seedId, title: seed.title }, debug: candidateDebug };
    }
    // cluster_too_small is not a synthesis failure — the memory just lacks
    // neighbors yet. Cool it down so it re-queues after cooldownDays rather
    // than burning a synthesis attempt and eventually dead-lettering.
    tracker.markCooledDown(seedId);
    return {
      status: "cluster_too_small",
      seed: { id: seedId, title: seed.title },
      candidateCount: candidates.length,
      debug: candidateDebug,
    };
  }

  const cluster = validation.cluster;

  // 5. Classify insight type
  const clusterForClassification = [
    { category: seed.category, type: seed.type, date_saved: seed.date_saved },
    ...cluster.map((c) => ({
      category: c.frontmatter.category,
      type: c.frontmatter.type,
      date_saved: c.frontmatter.date_saved,
    })),
  ];
  const insightType = classifyCluster(clusterForClassification);

  // 6. Check dedup
  const allSourceIds = [seedId, ...cluster.map((c) => c.memoryId)];
  const existingInsights = await getExistingInsights(dataPath);
  const dupInsight = checkDedup(allSourceIds, existingInsights);
  let supersedes: string[] = [];

  if (dupInsight && !isReeval) {
    // Supersede the existing insight
    supersedes = [dupInsight.id];
  }

  // 7. Synthesize via LLM
  const clusterMembers = [];

  // Add seed as first member
  const seedMember = await loadClusterMemberFiles(seedPath, {
    id: seedId,
    title: seed.title,
    type: seed.type,
    category: seed.category,
    date_saved: seed.date_saved,
    tags: [],
  });
  if (!isReeval) {
    clusterMembers.push(seedMember);
  }

  for (const c of cluster) {
    const member = await loadClusterMemberFiles(c.filePath, c.frontmatter);
    clusterMembers.push(member);
  }

  let synthesis;
  try {
    synthesis = await synthesizeInsight(clusterMembers, insightType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[consolidation] Synthesis failed for seed "${seed.title}" (${seedId}): ${msg}`);
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return { status: "synthesis_failed", seed: { id: seedId, title: seed.title } };
  }

  // 8. Compute confidence
  const avgSimilarity = cluster.reduce((sum, c) => sum + c.score, 0) / cluster.length;
  const confidence = computeInsightConfidence({
    avgSimilarity,
    clusterSize: clusterMembers.length,
    reinforcementCount,
    sourceIntegrity: 1.0,
  });

  // 9. Write insight file (before source updates — design doc §7.1)
  const dominantCategory = seed.category || cluster[0]?.frontmatter.category || "qmd://uncategorized";
  const sourceIds = isReeval
    ? cluster.map((c) => c.memoryId)
    : [seedId, ...cluster.map((c) => c.memoryId)];

  const { insightId, filePath: insightFilePath } = await writeInsight(
    synthesis,
    cluster.map((c) => ({ memoryId: c.memoryId, frontmatter: c.frontmatter })),
    dataPath,
    {
      category: dominantCategory,
      sourceIds,
      confidence,
      insightType,
      supersedes: isReeval && existingInsightId ? [existingInsightId, ...supersedes] : supersedes,
      reinforcementCount,
    },
  );

  // 10. Supersede old insights
  if (dupInsight && dupInsight.filePath) {
    await supersede(dupInsight.filePath, insightId);
  }
  if (isReeval && existingInsightId) {
    // Retire old insight
    const oldPath = memoryIndex.get(existingInsightId);
    if (oldPath) {
      await supersede(oldPath, insightId);
    }
    tracker.markRetired(existingInsightId);
  }

  // 11. Update source frontmatter
  const sourceFilePaths = sourceIds
    .map((id) => memoryIndex.get(id))
    .filter((p): p is string => !!p);
  await updateSourceFrontmatter(sourceFilePaths, insightId);

  // 12. Update tracker
  if (!isReeval) {
    tracker.markConsolidated(seedId, insightId);
  }
  tracker.upsertMemory(insightId, "insight");
  tracker.markConsolidated(insightId);

  // Update memoryIndex with new insight
  memoryIndex.set(insightId, insightFilePath);

  // 13. Emit memory.indexed event for new insight
  const insightContent = await Bun.file(insightFilePath).text();
  const insightFm = parseFrontmatter(insightContent);
  await eventDispatcher.emit("memory.indexed", {
    id: insightId,
    filePath: insightFilePath,
    frontmatter: insightFm,
    timestamp: new Date().toISOString(),
  });

  return {
    status: "consolidated",
    insightId,
    seed: { id: seedId, title: seed.title },
    clusterSize: clusterMembers.length,
  };
}

// ─── Dry Run ─────────────────────────────────────────────────────────

/**
 * Run steps 1–7 (seed selection through classification) without LLM synthesis.
 */
export async function runConsolidationDryRun(deps: ConsolidationDeps): Promise<DryRunResult> {
  const {
    dataPath,
    qmdSearch,
    tracker,
    memoryIndex,
    minClusterSize,
    maxClusterSize,
    minSimilarityScore,
    cooldownDays,
    maxSynthesisAttempts,
  } = deps;

  // 1. Select seed
  const seedResult = tracker.selectSeed(cooldownDays, maxSynthesisAttempts);
  if (!seedResult) {
    return { status: "no_seed" };
  }

  const { memoryId: seedId } = seedResult;
  const seedPath = memoryIndex.get(seedId);
  if (!seedPath) {
    return { status: "no_seed" };
  }

  const seed = await loadSeedFromDisk(seedPath);
  if (!seed) {
    return { status: "no_seed" };
  }

  // 2. Find candidates
  const { candidates: rawCandidates, debug: candidateDebug } = await findCandidates(seed, qmdSearch, { maxClusterSize, minSimilarityScore });
  const candidates = await enrichCandidatesWithFiles(rawCandidates, memoryIndex, dataPath);

  // 3. Validate cluster
  const validation = validateCluster(seed, candidates, { minClusterSize, maxClusterSize });
  if (!validation.valid) {
    return {
      status: "cluster_too_small",
      seed: { id: seedId, title: seed.title },
      candidateCount: candidates.length,
      debug: candidateDebug,
    };
  }

  const cluster = validation.cluster;

  // 4. Classify insight type
  const clusterForClassification = [
    { category: seed.category, type: seed.type, date_saved: seed.date_saved },
    ...cluster.map((c) => ({
      category: c.frontmatter.category,
      type: c.frontmatter.type,
      date_saved: c.frontmatter.date_saved,
    })),
  ];
  const insightType = classifyCluster(clusterForClassification);

  // 5. Estimate confidence
  const avgSimilarity = cluster.reduce((sum, c) => sum + c.score, 0) / cluster.length;
  const confidence = computeInsightConfidence({
    avgSimilarity,
    clusterSize: 1 + cluster.length,
    reinforcementCount: 0,
    sourceIntegrity: 1.0,
  });

  return {
    status: "dry_run",
    seed: { id: seedId, title: seed.title },
    candidates: cluster.map((c) => ({
      id: c.memoryId,
      title: c.frontmatter.title ?? "Unknown",
      score: c.score,
    })),
    proposedInsightType: insightType,
    estimatedConfidence: confidence,
  };
}

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { MemoryIndex } from "./memory-index";
import type { EventDispatcher } from "./event-dispatcher";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import type { InsightType } from "@kore/shared-types";
import {
  findCandidates,
  validateCluster,
  classifyCluster,
  buildConsolidationQuery,
} from "./consolidation-candidate-finder";
import type { SeedMemory, CandidateResult } from "./consolidation-candidate-finder";
import type { ClusterMember } from "./consolidation-synthesizer";
import { synthesizeInsight, computeInsightConfidence } from "./consolidation-synthesizer";
import {
  writeInsight,
  checkDedup,
  supersede,
  updateSourceFrontmatter,
} from "./consolidation-writer";

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
  status: "consolidated" | "no_seed" | "cluster_too_small" | "retired_reeval";
  insightId?: string;
  seed?: { id: string; title: string };
  clusterSize?: number;
  candidateCount?: number;
}

export interface DryRunResult {
  status: "dry_run" | "no_seed" | "cluster_too_small";
  seed?: { id: string; title: string };
  candidates?: Array<{ id: string; title: string; score: number }>;
  proposedInsightType?: string;
  estimatedConfidence?: number;
  candidateCount?: number;
}

export interface ConsolidationHandle {
  stop: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file content string.
 */
function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else if (value === "null") {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load a memory file from disk and build a SeedMemory object.
 */
async function loadSeedMemory(filePath: string): Promise<SeedMemory | null> {
  try {
    const content = await Bun.file(filePath).text();
    const fm = parseFrontmatter(content);

    // Parse title from markdown heading (# Title)
    const titleMatch = content.match(/^# (.+)$/m);
    const title = fm.title ?? titleMatch?.[1] ?? "";

    // Parse distilled items from markdown body
    const bodyMatch = content.match(/## Distilled Memory Items\n([\s\S]*?)(?:\n##|\n$|$)/);
    const distilledItems: string[] = [];
    if (bodyMatch) {
      for (const line of bodyMatch[1].split("\n")) {
        const itemMatch = line.match(/^- \*\*(.+)\*\*$/);
        if (itemMatch) {
          distilledItems.push(itemMatch[1]);
        }
      }
    }

    return {
      id: fm.id ?? "",
      title,
      type: fm.type ?? "note",
      category: fm.category ?? "",
      date_saved: fm.date_saved ?? "",
      distilledItems,
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Load a cluster member from disk for LLM synthesis.
 */
async function loadClusterMember(filePath: string, fm: Record<string, any>): Promise<ClusterMember> {
  let rawSource = "";
  try {
    rawSource = await Bun.file(filePath).text();
  } catch {
    // file may not exist
  }

  // Parse distilled items from body
  const distilledItems: string[] = [];
  const bodyMatch = rawSource.match(/## Distilled Memory Items\n([\s\S]*?)(?:\n##|\n$|$)/);
  if (bodyMatch) {
    for (const line of bodyMatch[1].split("\n")) {
      const itemMatch = line.match(/^- \*\*(.+)\*\*$/);
      if (itemMatch) {
        distilledItems.push(itemMatch[1]);
      }
    }
  }

  // Parse title from heading if not in frontmatter
  const titleMatch = rawSource.match(/^# (.+)$/m);
  const title = fm.title ?? titleMatch?.[1] ?? "";

  return {
    id: fm.id ?? "",
    title,
    type: fm.type ?? "note",
    category: fm.category ?? "",
    date_saved: fm.date_saved ?? "",
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    distilledItems,
    rawSource,
  };
}

/**
 * Enrich candidate results with memoryId and frontmatter from disk.
 */
async function enrichCandidates(
  candidates: CandidateResult[],
  memoryIndex: MemoryIndex,
): Promise<CandidateResult[]> {
  const enriched: CandidateResult[] = [];
  for (const c of candidates) {
    const id = memoryIndex.getIdByPath(c.filePath);
    if (!id) continue;
    try {
      const content = await Bun.file(c.filePath).text();
      const fm = parseFrontmatter(content);
      enriched.push({ ...c, memoryId: id, frontmatter: fm });
    } catch {
      enriched.push({ ...c, memoryId: id });
    }
  }
  return enriched;
}

/**
 * Get all existing insight frontmatters from disk.
 */
async function getExistingInsights(dataPath: string): Promise<Array<{ id: string; source_ids: string[]; filePath: string; [key: string]: any }>> {
  const insightsDir = join(dataPath, "insights");
  let files: string[];
  try {
    files = await readdir(insightsDir);
  } catch {
    return [];
  }

  const insights: Array<{ id: string; source_ids: string[]; filePath: string }> = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(insightsDir, file);
    try {
      const content = await Bun.file(filePath).text();
      const fm = parseFrontmatter(content);
      if (fm.id && Array.isArray(fm.source_ids)) {
        insights.push({ ...fm, id: fm.id, source_ids: fm.source_ids, filePath });
      }
    } catch {
      continue;
    }
  }
  return insights;
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
    return { status: "no_seed" };
  }

  const { memoryId: seedId, isReeval } = seedResult;

  // 2. Load seed memory
  const seedPath = memoryIndex.get(seedId);
  if (!seedPath) {
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return { status: "no_seed" };
  }

  const seed = await loadSeedMemory(seedPath);
  if (!seed) {
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return { status: "no_seed" };
  }

  let candidates: CandidateResult[];
  let existingInsightId: string | undefined;
  let reinforcementCount = 0;

  if (isReeval) {
    // 3a. Re-eval path: load existing insight's source_ids, resolve remaining sources
    const content = await Bun.file(seedPath).text();
    const insightFm = parseFrontmatter(content);
    const sourceIds: string[] = Array.isArray(insightFm.source_ids) ? insightFm.source_ids : [];
    existingInsightId = seedId;
    reinforcementCount = (insightFm.reinforcement_count ?? 0) + 1;

    // Resolve which sources still exist
    const remainingSources: SeedMemory[] = [];
    for (const srcId of sourceIds) {
      const srcPath = memoryIndex.get(srcId);
      if (srcPath) {
        const src = await loadSeedMemory(srcPath);
        if (src) remainingSources.push(src);
      }
    }

    if (remainingSources.length < minClusterSize) {
      // Retire the insight — not enough sources remaining
      tracker.markRetired(seedId);
      return { status: "retired_reeval", seed: { id: seedId, title: seed.title } };
    }

    // Search QMD for additional candidates using insight's title + distilled items
    const rawCandidates = await findCandidates(
      { ...seed, id: seedId },
      qmdSearch,
      { maxClusterSize, minSimilarityScore },
    );
    candidates = await enrichCandidates(rawCandidates, memoryIndex);

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
    const rawCandidates = await findCandidates(seed, qmdSearch, { maxClusterSize, minSimilarityScore });
    candidates = await enrichCandidates(rawCandidates, memoryIndex);
  }

  // 4. Validate cluster size
  const validation = validateCluster(seed, candidates, { minClusterSize, maxClusterSize });
  if (!validation.valid) {
    if (isReeval) {
      tracker.markRetired(seedId);
      return { status: "retired_reeval", seed: { id: seedId, title: seed.title } };
    }
    tracker.markFailed(seedId, maxSynthesisAttempts);
    return {
      status: "cluster_too_small",
      seed: { id: seedId, title: seed.title },
      candidateCount: candidates.length,
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
  const clusterMembers: ClusterMember[] = [];

  // Add seed as first member
  const seedMember = await loadClusterMember(seedPath, {
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
    const member = await loadClusterMember(c.filePath, c.frontmatter);
    clusterMembers.push(member);
  }

  const synthesis = await synthesizeInsight(clusterMembers, insightType);

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

  const seed = await loadSeedMemory(seedPath);
  if (!seed) {
    return { status: "no_seed" };
  }

  // 2. Find candidates
  const rawCandidates = await findCandidates(seed, qmdSearch, { maxClusterSize, minSimilarityScore });
  const candidates = await enrichCandidates(rawCandidates, memoryIndex);

  // 3. Validate cluster
  const validation = validateCluster(seed, candidates, { minClusterSize, maxClusterSize });
  if (!validation.valid) {
    return {
      status: "cluster_too_small",
      seed: { id: seedId, title: seed.title },
      candidateCount: candidates.length,
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

// ─── Consolidation Loop ──────────────────────────────────────────────

/**
 * Start the consolidation loop as a background service.
 * Uses a boolean concurrency guard — skips a cycle if a previous one is still running.
 */
export function startConsolidationLoop(deps: ConsolidationDeps): ConsolidationHandle {
  let running = false;
  let stopped = false;
  let resolveInProgress: (() => void) | null = null;

  async function cycle() {
    if (stopped) return;
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
      }
    } catch (err) {
      console.error("[consolidation] Cycle error:", err);
      // Try to mark current seed as failed
      const seedResult = deps.tracker.selectSeed(deps.cooldownDays, deps.maxSynthesisAttempts);
      if (seedResult) {
        deps.tracker.markFailed(seedResult.memoryId, deps.maxSynthesisAttempts);
      }
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
  };
}

// ─── Default Deps Factory ────────────────────────────────────────────

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

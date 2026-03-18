import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";
import type { InsightType } from "@kore/shared-types";

// ─── Types ───────────────────────────────────────────────────────────

export interface CandidateResult {
  memoryId: string;
  filePath: string;
  score: number;
  frontmatter: Record<string, any>;
}

export type ClusterValidation =
  | { valid: true; cluster: CandidateResult[] }
  | { valid: false; reason: string };

export interface CandidateFinderOptions {
  minClusterSize?: number;  // default: 3
  maxClusterSize?: number;  // default: 8
  minSimilarityScore?: number;  // default: 0.45
}

export interface CandidateDebugInfo {
  query: string;
  rawResultCount: number;
  filteredOutSelf: number;
  filteredOutInsights: number;
  afterFilterCount: number;
  topScores: number[];
}

export interface SeedMemory {
  id: string;
  title: string;
  type: string;
  category: string;
  date_saved: string;
  distilledItems: string[];
  filePath: string;
}

type QmdSearchFn = (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;

// ─── Candidate Finder ────────────────────────────────────────────────

/**
 * Build a consolidation query from seed title + first 3 distilled items (design doc §4.4).
 */
export function buildConsolidationQuery(seed: SeedMemory): string {
  const items = seed.distilledItems.slice(0, 3).join(". ");
  return `${seed.title}. ${items}`;
}

/**
 * Find candidate memories for consolidation with a seed memory via QMD search.
 */
export async function findCandidates(
  seed: SeedMemory,
  qmdSearch: QmdSearchFn,
  options: CandidateFinderOptions = {}
): Promise<{ candidates: CandidateResult[]; debug: CandidateDebugInfo }> {
  const {
    maxClusterSize = 8,
    minSimilarityScore = 0.45,
  } = options;

  const query = buildConsolidationQuery(seed);

  console.log(
    `[consolidation] Search query for seed "${seed.title}": "${query.slice(0, 120)}${query.length > 120 ? "..." : ""}"`,
  );
  console.log(
    `[consolidation] Search params: minScore=${minSimilarityScore}, limit=${maxClusterSize + 5}, collection=memories`,
  );

  const results = await qmdSearch(query, {
    limit: maxClusterSize + 5,
    collection: "memories",
    intent: "Find memories related to the same topic, concept, or entity for knowledge consolidation",
    minScore: minSimilarityScore,
  });

  console.log(`[consolidation] QMD returned ${results.length} raw result(s)`);
  if (results.length > 0) {
    for (const r of results.slice(0, 5)) {
      const basename = r.file.split("/").pop() ?? r.file;
      console.log(`[consolidation]   - ${basename} (score: ${r.score.toFixed(3)}, title: "${r.title ?? "?"}"`);
    }
    if (results.length > 5) {
      console.log(`[consolidation]   ... and ${results.length - 5} more`);
    }
  }

  let filteredOutSelf = 0;
  let filteredOutInsights = 0;

  const candidates = results
    .filter((r) => {
      // Exclude the seed itself
      if (r.file === seed.filePath) {
        filteredOutSelf++;
        return false;
      }
      // Exclude insight-type memories (no meta-synthesis)
      if (r.file.includes("/insights/")) {
        filteredOutInsights++;
        return false;
      }
      return true;
    })
    .map((r) => ({
      memoryId: "", // filled in by caller from memoryIndex
      filePath: r.file,
      score: r.score,
      frontmatter: {},
    }));

  if (filteredOutSelf > 0 || filteredOutInsights > 0) {
    console.log(
      `[consolidation] Filtered out: ${filteredOutSelf} self, ${filteredOutInsights} insight(s) → ${candidates.length} candidate(s) remain`,
    );
  }

  const debug: CandidateDebugInfo = {
    query,
    rawResultCount: results.length,
    filteredOutSelf,
    filteredOutInsights,
    afterFilterCount: candidates.length,
    topScores: results.slice(0, 5).map((r) => r.score),
  };

  return { candidates, debug };
}

/**
 * Validate cluster size (seed + candidates must be 3–8).
 * Truncates to top-scoring if over maxClusterSize rather than rejecting.
 */
export function validateCluster(
  seed: SeedMemory,
  candidates: CandidateResult[],
  options: CandidateFinderOptions = {}
): ClusterValidation {
  const { minClusterSize = 3, maxClusterSize = 8 } = options;

  const totalSize = 1 + candidates.length; // seed + candidates

  if (totalSize < minClusterSize) {
    return {
      valid: false,
      reason: `Cluster size ${totalSize} is below minimum ${minClusterSize}`,
    };
  }

  // Truncate to top-scoring candidates if over max
  let cluster = candidates;
  if (totalSize > maxClusterSize) {
    cluster = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, maxClusterSize - 1); // -1 for seed
  }

  return { valid: true, cluster };
}

/**
 * Deterministic insight type classification (design doc §4.3).
 *
 * Rules:
 * - cross-category OR cross-type → "connection"
 * - temporal span > 30 days → "evolution"
 * - else → "cluster_summary"
 *
 * "contradiction" is detected by LLM during synthesis, not here.
 */
export function classifyCluster(
  cluster: Array<{ category?: string; type?: string; date_saved?: string }>
): InsightType {
  const categories = new Set(
    cluster.map((m) => m.category).filter(Boolean)
  );
  const types = new Set(
    cluster.map((m) => m.type).filter(Boolean)
  );

  // Cross-category or cross-type → connection
  if (categories.size > 1 || types.size > 1) {
    return "connection";
  }

  // Temporal span > 30 days → evolution
  const dates = cluster
    .map((m) => m.date_saved)
    .filter(Boolean)
    .map((d) => new Date(d!).getTime())
    .filter((t) => !isNaN(t));

  if (dates.length >= 2) {
    const spanMs = Math.max(...dates) - Math.min(...dates);
    const spanDays = spanMs / (1000 * 60 * 60 * 24);
    if (spanDays > 30) {
      return "evolution";
    }
  }

  return "cluster_summary";
}

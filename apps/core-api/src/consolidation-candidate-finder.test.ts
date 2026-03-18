import { describe, test, expect } from "bun:test";
import {
  buildConsolidationQuery,
  findCandidates,
  validateCluster,
  classifyCluster,
} from "./consolidation-candidate-finder";
import type { SeedMemory, CandidateResult } from "./consolidation-candidate-finder";
import type { HybridQueryResult } from "@kore/qmd-client";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeSeed(overrides: Partial<SeedMemory> = {}): SeedMemory {
  return {
    id: "seed-001",
    title: "React State Management",
    type: "note",
    category: "qmd://tech/programming/react",
    date_saved: "2026-01-15T00:00:00Z",
    distilledItems: [
      "useState is the simplest React hook for local state.",
      "useReducer is better for complex state logic.",
      "Context API avoids prop drilling.",
      "Redux is overkill for small apps.",
    ],
    filePath: "/data/notes/react-state.md",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateResult> = {}): CandidateResult {
  return {
    memoryId: "cand-001",
    filePath: "/data/notes/cand.md",
    score: 0.72,
    frontmatter: {},
    ...overrides,
  };
}

// ─── Query Construction ──────────────────────────────────────────────

describe("buildConsolidationQuery", () => {
  test("constructs query from title + first 3 distilled items", () => {
    const seed = makeSeed();
    const query = buildConsolidationQuery(seed);
    expect(query).toBe(
      "React State Management. useState is the simplest React hook for local state.. useReducer is better for complex state logic.. Context API avoids prop drilling."
    );
  });

  test("handles seed with fewer than 3 distilled items", () => {
    const seed = makeSeed({ distilledItems: ["Single fact."] });
    const query = buildConsolidationQuery(seed);
    expect(query).toBe("React State Management. Single fact.");
  });

  test("handles seed with no distilled items", () => {
    const seed = makeSeed({ distilledItems: [] });
    const query = buildConsolidationQuery(seed);
    expect(query).toBe("React State Management. ");
  });
});

// ─── findCandidates ──────────────────────────────────────────────────

describe("findCandidates", () => {
  test("excludes seed from results by file path", async () => {
    const seed = makeSeed();
    const mockSearch = async () => [
      { file: "/data/notes/react-state.md", title: "Same file", score: 1.0, bestChunk: "" },
      { file: "/data/notes/other.md", title: "Other", score: 0.8, bestChunk: "" },
    ] as HybridQueryResult[];

    const { candidates: results } = await findCandidates(seed, mockSearch);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("/data/notes/other.md");
  });

  test("excludes insight-type memories", async () => {
    const seed = makeSeed();
    const mockSearch = async () => [
      { file: "/data/insights/ins-abc.md", title: "Insight", score: 0.9, bestChunk: "" },
      { file: "/data/notes/other.md", title: "Other", score: 0.7, bestChunk: "" },
    ] as HybridQueryResult[];

    const { candidates: results } = await findCandidates(seed, mockSearch);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("/data/notes/other.md");
  });

  test("passes correct search options", async () => {
    const seed = makeSeed();
    let capturedOptions: any;
    const mockSearch = async (_q: string, opts?: any) => {
      capturedOptions = opts;
      return [];
    };

    await findCandidates(seed, mockSearch, { maxClusterSize: 5, minSimilarityScore: 0.6 });

    expect(capturedOptions.limit).toBe(10); // maxClusterSize + 5
    expect(capturedOptions.collection).toBe("memories");
    expect(capturedOptions.intent).toContain("knowledge consolidation");
    expect(capturedOptions.minScore).toBe(0.6);
  });
});

// ─── validateCluster ─────────────────────────────────────────────────

describe("validateCluster", () => {
  test("returns invalid when cluster too small (seed + 1 < 3)", () => {
    const seed = makeSeed();
    const candidates = [makeCandidate()];
    const result = validateCluster(seed, candidates);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("below minimum");
    }
  });

  test("returns valid for exact minimum size (seed + 2 = 3)", () => {
    const seed = makeSeed();
    const candidates = [makeCandidate(), makeCandidate({ memoryId: "cand-002" })];
    const result = validateCluster(seed, candidates);
    expect(result.valid).toBe(true);
  });

  test("returns valid for maximum size (seed + 7 = 8)", () => {
    const seed = makeSeed();
    const candidates = Array.from({ length: 7 }, (_, i) =>
      makeCandidate({ memoryId: `cand-${i}`, score: 0.9 - i * 0.05 })
    );
    const result = validateCluster(seed, candidates);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cluster).toHaveLength(7);
    }
  });

  test("truncates to top-scoring when over maxClusterSize", () => {
    const seed = makeSeed();
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ memoryId: `cand-${i}`, score: 0.5 + i * 0.05 })
    );
    const result = validateCluster(seed, candidates, { maxClusterSize: 5 });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cluster).toHaveLength(4); // maxClusterSize(5) - 1(seed) = 4
      // Should be top-scoring
      expect(result.cluster[0].score).toBeGreaterThanOrEqual(result.cluster[1].score);
    }
  });

  test("returns invalid when no candidates at all", () => {
    const seed = makeSeed();
    const result = validateCluster(seed, []);
    expect(result.valid).toBe(false);
  });
});

// ─── classifyCluster ─────────────────────────────────────────────────

describe("classifyCluster", () => {
  test("returns 'connection' when categories differ", () => {
    const cluster = [
      { category: "qmd://tech/react", type: "note", date_saved: "2026-01-01T00:00:00Z" },
      { category: "qmd://personal/goals", type: "note", date_saved: "2026-01-02T00:00:00Z" },
      { category: "qmd://tech/react", type: "note", date_saved: "2026-01-03T00:00:00Z" },
    ];
    expect(classifyCluster(cluster)).toBe("connection");
  });

  test("returns 'connection' when types differ", () => {
    const cluster = [
      { category: "qmd://tech", type: "note", date_saved: "2026-01-01T00:00:00Z" },
      { category: "qmd://tech", type: "person", date_saved: "2026-01-02T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-01-03T00:00:00Z" },
    ];
    expect(classifyCluster(cluster)).toBe("connection");
  });

  test("returns 'evolution' when span > 30 days with same category", () => {
    const cluster = [
      { category: "qmd://tech", type: "note", date_saved: "2025-12-01T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-02-15T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-01-10T00:00:00Z" },
    ];
    expect(classifyCluster(cluster)).toBe("evolution");
  });

  test("returns 'cluster_summary' for same category, same type, span <= 30 days", () => {
    const cluster = [
      { category: "qmd://tech", type: "note", date_saved: "2026-01-01T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-01-15T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-01-20T00:00:00Z" },
    ];
    expect(classifyCluster(cluster)).toBe("cluster_summary");
  });

  test("returns 'cluster_summary' when no dates available", () => {
    const cluster = [
      { category: "qmd://tech", type: "note" },
      { category: "qmd://tech", type: "note" },
      { category: "qmd://tech", type: "note" },
    ];
    expect(classifyCluster(cluster)).toBe("cluster_summary");
  });

  test("connection takes priority over evolution (cross-category + span > 30)", () => {
    const cluster = [
      { category: "qmd://tech", type: "note", date_saved: "2025-01-01T00:00:00Z" },
      { category: "qmd://personal", type: "note", date_saved: "2026-03-01T00:00:00Z" },
      { category: "qmd://tech", type: "note", date_saved: "2026-02-01T00:00:00Z" },
    ];
    expect(classifyCluster(cluster)).toBe("connection");
  });
});

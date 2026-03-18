import { describe, test, expect } from "bun:test";
import {
  buildSynthesisPrompt,
  computeInsightConfidence,
  fallbackParse,
} from "./consolidation-synthesizer";
import { InsightOutputSchema } from "@kore/shared-types";
import type { ClusterMember } from "./consolidation-synthesizer";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeMember(overrides: Partial<ClusterMember> = {}): ClusterMember {
  return {
    id: "mem-001",
    title: "React Hooks",
    type: "note",
    category: "qmd://tech/programming/react",
    date_saved: "2026-01-15T00:00:00Z",
    tags: ["react", "hooks"],
    distilledItems: ["useState manages local state.", "useEffect handles side effects."],
    rawSource: "React hooks are functions that let you use state and lifecycle features in function components.",
    ...overrides,
  };
}

// ─── Prompt Construction ─────────────────────────────────────────────

describe("buildSynthesisPrompt", () => {
  test("includes insight type header", () => {
    const prompt = buildSynthesisPrompt([makeMember()], "cluster_summary");
    expect(prompt).toContain("Insight type requested: cluster_summary");
  });

  test("includes memory header with ID and date", () => {
    const prompt = buildSynthesisPrompt([makeMember()], "cluster_summary");
    expect(prompt).toContain("### Memory 1 (ID: mem-001, saved: 2026-01-15T00:00:00Z)");
  });

  test("includes title, type, category, and tags", () => {
    const prompt = buildSynthesisPrompt([makeMember()], "cluster_summary");
    expect(prompt).toContain("**Title:** React Hooks");
    expect(prompt).toContain("**Type:** note");
    expect(prompt).toContain("**Category:** qmd://tech/programming/react");
    expect(prompt).toContain("**Tags:** react, hooks");
  });

  test("includes distilled items as facts", () => {
    const prompt = buildSynthesisPrompt([makeMember()], "cluster_summary");
    expect(prompt).toContain("- **Facts:**");
    expect(prompt).toContain("  - useState manages local state.");
    expect(prompt).toContain("  - useEffect handles side effects.");
  });

  test("includes source excerpt truncated to 300 chars", () => {
    const longSource = "x".repeat(500);
    const prompt = buildSynthesisPrompt(
      [makeMember({ rawSource: longSource })],
      "cluster_summary"
    );
    expect(prompt).toContain(`"${"x".repeat(300)}..."`);
  });

  test("does not add ellipsis for short source", () => {
    const prompt = buildSynthesisPrompt([makeMember()], "cluster_summary");
    expect(prompt).not.toContain('..."');
  });

  test("numbers multiple memories sequentially", () => {
    const members = [
      makeMember({ id: "a" }),
      makeMember({ id: "b" }),
      makeMember({ id: "c" }),
    ];
    const prompt = buildSynthesisPrompt(members, "evolution");
    expect(prompt).toContain("### Memory 1 (ID: a");
    expect(prompt).toContain("### Memory 2 (ID: b");
    expect(prompt).toContain("### Memory 3 (ID: c");
  });
});

// ─── InsightOutputSchema Validation ──────────────────────────────────

describe("InsightOutputSchema", () => {
  const validOutput = {
    title: "React State Management Patterns",
    insight_type: "cluster_summary" as const,
    synthesis: "React offers multiple approaches to state management. useState handles simple local state while useReducer manages complex state logic.",
    connections: [
      { source_id: "mem-001", target_id: "mem-002", relationship: "both discuss state hooks" },
    ],
    distilled_items: ["useState is for simple local state.", "useReducer handles complex state."],
    tags: ["react", "state-management"],
  };

  test("accepts valid output", () => {
    const result = InsightOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  test("rejects missing title", () => {
    const { title, ...rest } = validOutput;
    const result = InsightOutputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("rejects empty distilled_items", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, distilled_items: [] });
    expect(result.success).toBe(false);
  });

  test("rejects more than 7 distilled_items", () => {
    const result = InsightOutputSchema.safeParse({
      ...validOutput,
      distilled_items: Array.from({ length: 8 }, (_, i) => `Item ${i}`),
    });
    expect(result.success).toBe(false);
  });

  test("rejects more than 5 tags", () => {
    const result = InsightOutputSchema.safeParse({
      ...validOutput,
      tags: ["a", "b", "c", "d", "e", "f"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid insight_type", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, insight_type: "invalid" });
    expect(result.success).toBe(false);
  });

  test("accepts contradiction as insight_type", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, insight_type: "contradiction" });
    expect(result.success).toBe(true);
  });

  test("accepts empty connections array", () => {
    const result = InsightOutputSchema.safeParse({ ...validOutput, connections: [] });
    expect(result.success).toBe(true);
  });
});

// ─── fallbackParse ───────────────────────────────────────────────────

describe("fallbackParse", () => {
  const validJson = JSON.stringify({
    title: "Test Insight",
    insight_type: "cluster_summary",
    synthesis: "A synthesis paragraph.",
    connections: [],
    distilled_items: ["Fact one."],
    tags: ["test"],
  });

  test("parses valid JSON", () => {
    const result = fallbackParse(validJson);
    expect(result.title).toBe("Test Insight");
  });

  test("strips markdown code fences", () => {
    const result = fallbackParse("```json\n" + validJson + "\n```");
    expect(result.title).toBe("Test Insight");
  });

  test("normalizes tags to lowercase kebab-case", () => {
    const json = JSON.stringify({
      title: "Test",
      insight_type: "cluster_summary",
      synthesis: "A synthesis.",
      connections: [],
      distilled_items: ["Fact."],
      tags: ["UPPER_CASE", "with spaces"],
    });
    const result = fallbackParse(json);
    expect(result.tags).toEqual(["upper-case", "with-spaces"]);
  });

  test("truncates distilled_items to 7", () => {
    const json = JSON.stringify({
      title: "Test",
      insight_type: "cluster_summary",
      synthesis: "A synthesis.",
      connections: [],
      distilled_items: Array.from({ length: 10 }, (_, i) => `Item ${i}`),
      tags: ["test"],
    });
    const result = fallbackParse(json);
    expect(result.distilled_items).toHaveLength(7);
  });

  test("throws on non-JSON input", () => {
    expect(() => fallbackParse("not json at all")).toThrow("no JSON object found");
  });
});

// ─── Confidence Scoring ──────────────────────────────────────────────

describe("computeInsightConfidence", () => {
  test("minimum cluster size (3) with moderate similarity", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.6,
      clusterSize: 3,
      reinforcementCount: 0,
      sourceIntegrity: 1.0,
    });
    // sizeFactor = min((3-2)/3, 1.0) = 0.333
    // base = 0.6 * 0.5 + 0.333 * 0.5 = 0.3 + 0.167 = 0.467
    // adjusted = 0.467 * 1.0 * 1.0 = 0.467 → 0.47
    expect(conf).toBeCloseTo(0.47, 2);
  });

  test("maximum cluster size (8) with high similarity", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.9,
      clusterSize: 8,
      reinforcementCount: 0,
      sourceIntegrity: 1.0,
    });
    // sizeFactor = min((8-2)/3, 1.0) = min(2.0, 1.0) = 1.0
    // base = 0.9 * 0.5 + 1.0 * 0.5 = 0.45 + 0.5 = 0.95
    expect(conf).toBeCloseTo(0.95, 2);
  });

  test("reinforcement boost capped at 1.15", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.8,
      clusterSize: 5,
      reinforcementCount: 10, // way over cap
      sourceIntegrity: 1.0,
    });
    // sizeFactor = min((5-2)/3, 1.0) = 1.0
    // base = 0.8 * 0.5 + 1.0 * 0.5 = 0.9
    // reinforcementFactor = min(1.0 + 10*0.05, 1.15) = 1.15
    // adjusted = 0.9 * 1.15 * 1.0 = 1.035 → capped at 1.0
    expect(conf).toBe(1.0);
  });

  test("partial source integrity reduces confidence", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.8,
      clusterSize: 5,
      reinforcementCount: 0,
      sourceIntegrity: 0.5,
    });
    // sizeFactor = 1.0
    // base = 0.8 * 0.5 + 1.0 * 0.5 = 0.9
    // adjusted = 0.9 * 1.0 * 0.5 = 0.45
    expect(conf).toBeCloseTo(0.45, 2);
  });

  test("zero source integrity yields 0.0", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.9,
      clusterSize: 8,
      reinforcementCount: 3,
      sourceIntegrity: 0.0,
    });
    expect(conf).toBe(0);
  });

  test("moderate reinforcement (3) adds 15% boost", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 0.7,
      clusterSize: 4,
      reinforcementCount: 3,
      sourceIntegrity: 1.0,
    });
    // sizeFactor = min((4-2)/3, 1.0) = 0.667
    // base = 0.7 * 0.5 + 0.667 * 0.5 = 0.35 + 0.333 = 0.683
    // reinforcementFactor = min(1.0 + 3*0.05, 1.15) = 1.15
    // adjusted = 0.683 * 1.15 * 1.0 = 0.786 → 0.79
    expect(conf).toBeCloseTo(0.79, 2);
  });

  test("result never exceeds 1.0", () => {
    const conf = computeInsightConfidence({
      avgSimilarity: 1.0,
      clusterSize: 100,
      reinforcementCount: 100,
      sourceIntegrity: 1.0,
    });
    expect(conf).toBeLessThanOrEqual(1.0);
  });
});

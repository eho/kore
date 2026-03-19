import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { InsightOutputSchema } from "@kore/shared-types";
import type { InsightOutput, InsightType } from "@kore/shared-types";

// ─── Types ───────────────────────────────────────────────────────────

export interface ClusterMember {
  id: string;
  title: string;
  type: string;
  category: string;
  date_saved: string;
  tags: string[];
  distilledItems: string[];
  rawSource: string;
}

export interface SynthesisResult extends InsightOutput {
  _extractionPath: "structured" | "fallback";
}

// ─── Model Resolution ────────────────────────────────────────────────

/**
 * Resolve the language model for synthesis.
 * Uses KORE_SYNTHESIS_MODEL override if set, otherwise falls back to
 * LLM_PROVIDER/LLM_MODEL (same as llm-extractor).
 */
function resolveModel() {
  const provider = process.env.LLM_PROVIDER || "ollama";
  const synthesisModel = process.env.KORE_SYNTHESIS_MODEL;

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini requires GEMINI_API_KEY to be set");
    const modelName = synthesisModel || process.env.LLM_MODEL || "gemini-2.5-flash-lite";
    return createGoogleGenerativeAI({ apiKey })(modelName);
  }

  // Default: ollama
  let baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  if (!baseURL.endsWith("/v1")) baseURL = baseURL.replace(/\/$/, "") + "/v1";
  const modelName = synthesisModel || process.env.LLM_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:7b";
  return createOpenAI({ baseURL, apiKey: "ollama" })(modelName);
}

// ─── System Prompts (design doc §5.2) ────────────────────────────────

const CONTRADICTION_RULE = `
Before synthesizing, examine all source facts for contradictions. If significant contradictions exist between source memories (e.g., conflicting facts, opposite recommendations, or incompatible claims), set insight_type to "contradiction" in your output regardless of the requested type.`;

const JSON_SCHEMA = `
You MUST respond with a JSON object with exactly these fields:
{
  "title": "string — a concise title for this insight",
  "insight_type": "cluster_summary" | "evolution" | "connection" | "contradiction",
  "synthesis": "string — 3-5 sentence synthesis paragraph",
  "distilled_items": ["string — atomic fact 1", "...up to 7 items"],
  "tags": ["string — 1-5 lowercase kebab-case tags"],
  "connections": [{"source_id": "memory-id-1", "target_id": "memory-id-2", "relationship": "description"}]
}`;

const SYSTEM_PROMPTS: Record<string, string> = {
  cluster_summary: `You are a knowledge synthesis engine for a personal memory system.

Given a cluster of related memories on the same topic, synthesize them into a single reference document. Identify the most important facts, patterns, and takeaways across all sources. Produce a concise synthesis paragraph (3-5 sentences), extract atomic distilled facts, and identify relationships between source memories.
${CONTRADICTION_RULE}
${JSON_SCHEMA}`,

  evolution: `You are a knowledge synthesis engine for a personal memory system.

Given a set of memories on the same topic saved at different times, identify how the user's understanding, position, or practices have changed over time. Highlight what shifted, what was added, and what was abandoned. Produce a synthesis paragraph (3-5 sentences) capturing the evolution narrative, extract atomic distilled facts, and identify temporal relationships between source memories.
${CONTRADICTION_RULE}
${JSON_SCHEMA}`,

  connection: `You are a knowledge synthesis engine for a personal memory system.

Given memories from different categories or types that are semantically related, identify and articulate the cross-domain connection. Explain why these seemingly different memories are related and what insight emerges from seeing them together. Produce a synthesis paragraph (3-5 sentences), extract atomic distilled facts, and map the cross-domain relationships between source memories.
${CONTRADICTION_RULE}
${JSON_SCHEMA}`,
};

// ─── Prompt Construction (design doc §5.3) ────────────────────────────

/**
 * Build the user message for LLM synthesis from cluster members.
 */
export function buildSynthesisPrompt(
  cluster: ClusterMember[],
  insightType: InsightType
): string {
  const sections = [`Insight type requested: ${insightType}`, ""];

  for (let i = 0; i < cluster.length; i++) {
    const m = cluster[i];
    sections.push(`### Memory ${i + 1} (ID: ${m.id}, saved: ${m.date_saved})`);
    sections.push(`- **Title:** ${m.title}`);
    sections.push(`- **Type:** ${m.type}`);
    sections.push(`- **Category:** ${m.category}`);
    sections.push(`- **Tags:** ${m.tags.join(", ")}`);
    sections.push("- **Facts:**");
    for (const item of m.distilledItems) {
      sections.push(`  - ${item}`);
    }
    const excerpt = m.rawSource.slice(0, 300);
    sections.push(`- **Source excerpt:** "${excerpt}${m.rawSource.length > 300 ? "..." : ""}"`);
    sections.push("");
  }

  return sections.join("\n");
}

// ─── Fallback Parse ──────────────────────────────────────────────────

/**
 * Parse InsightOutput from raw text response when structured output fails.
 */
export function fallbackParse(text: string): InsightOutput {
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Fallback parse failed: no JSON object found in response");
  }

  const raw = JSON.parse(jsonMatch[0]);

  // Map common LLM field name variations to expected names
  const aliases: string[] = [];
  if (!raw.title && raw.insight_title) { raw.title = raw.insight_title; aliases.push("insight_title→title"); }
  if (!raw.distilled_items && raw.distilled_facts) { raw.distilled_items = raw.distilled_facts; aliases.push("distilled_facts→distilled_items"); }
  if (!raw.distilled_items && raw.facts) { raw.distilled_items = raw.facts; aliases.push("facts→distilled_items"); }
  if (!raw.distilled_items && raw.key_facts) { raw.distilled_items = raw.key_facts; aliases.push("key_facts→distilled_items"); }
  if (!raw.tags && raw.keywords) { raw.tags = raw.keywords; aliases.push("keywords→tags"); }
  if (!raw.connections && raw.cross_domain_relationships) { raw.connections = raw.cross_domain_relationships; aliases.push("cross_domain_relationships→connections"); }
  if (!raw.connections && raw.relationships) { raw.connections = raw.relationships; aliases.push("relationships→connections"); }

  // Generate title from synthesis if LLM omitted it
  const generated: string[] = [];
  if (!raw.title && raw.synthesis) {
    raw.title = raw.synthesis.split(/[.!?]/)[0].trim().slice(0, 100);
    generated.push("title (from synthesis)");
  }

  // Generate tags from insight_type if LLM omitted them
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
    raw.tags = [raw.insight_type || "insight"];
    generated.push("tags (from insight_type)");
  }

  if (aliases.length > 0 || generated.length > 0) {
    const parts = [];
    if (aliases.length) parts.push(`aliased: ${aliases.join(", ")}`);
    if (generated.length) parts.push(`generated: ${generated.join(", ")}`);
    console.warn(`[consolidation] Fallback parse: LLM used non-standard fields — ${parts.join("; ")}`);
  }

  // Normalize tags: lowercase kebab-case
  if (Array.isArray(raw.tags)) {
    raw.tags = raw.tags
      .map((t: unknown) =>
        String(t)
          .toLowerCase()
          .replace(/[\s_]+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
      )
      .filter((t: string) => t.length > 0)
      .slice(0, 5);
  }

  // Truncate distilled_items
  if (Array.isArray(raw.distilled_items)) {
    raw.distilled_items = raw.distilled_items.slice(0, 7);
  }

  // Ensure connections is an array (LLM may omit or return null)
  if (!Array.isArray(raw.connections)) {
    raw.connections = [];
  }

  // Normalize connection objects to ensure required fields
  raw.connections = raw.connections
    .filter((c: unknown) => c && typeof c === "object")
    .map((c: Record<string, unknown>) => ({
      source_id: String(c.source_id ?? ""),
      target_id: String(c.target_id ?? ""),
      relationship: String(c.relationship ?? ""),
    }));

  const result = InsightOutputSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map(
      (i) => `${i.path.join(".")}: expected ${(i as any).expected ?? i.code}, got ${JSON.stringify((i as any).received ?? "?")}`
    );
    console.warn(`[consolidation] Fallback parse validation failed:\n  ${fields.join("\n  ")}`);
    console.warn(`[consolidation] Raw keys: ${Object.keys(raw).join(", ")}`);
    throw result.error;
  }
  return result.data;
}

// ─── Synthesis ────────────────────────────────────────────────────────

/**
 * Synthesize an insight from a cluster of memories using LLM.
 * Uses Vercel AI SDK structured output with fallback to text + JSON parsing.
 */
export async function synthesizeInsight(
  cluster: ClusterMember[],
  insightType: InsightType,
): Promise<SynthesisResult> {
  const model = resolveModel();
  const systemPrompt = SYSTEM_PROMPTS[insightType] || SYSTEM_PROMPTS.cluster_summary;
  const userPrompt = buildSynthesisPrompt(cluster, insightType);

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: InsightOutputSchema }),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
    });

    if (!output) {
      throw new Error("No structured output generated by model");
    }

    return { ...output, _extractionPath: "structured" as const };
  } catch (primaryError) {
    const pmsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.warn(`[consolidation] Structured output failed, falling back to text parse: ${pmsg}`);
    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt + `\n\nRespond with ONLY valid JSON. Use exactly these field names: title, insight_type, synthesis, distilled_items, tags, connections.`,
        temperature: 0,
      });

      const parsed = fallbackParse(text);
      return { ...parsed, _extractionPath: "fallback" as const };
    } catch (fallbackError) {
      const fbMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.warn(`[consolidation] Synthesis fallback also failed: ${fbMsg}`);
      throw primaryError;
    }
  }
}

// ─── Confidence Scoring (design doc §10.5.2) ─────────────────────────

/**
 * Compute insight confidence using the revised formula from design doc §10.5.2.
 *
 * This supersedes the simpler §6 formula (avgSimilarity * 0.7 + sizeFactor * 0.3).
 */
export function computeInsightConfidence(params: {
  avgSimilarity: number;
  clusterSize: number;
  reinforcementCount: number;
  sourceIntegrity: number; // ratio of source_ids still on disk (0.0–1.0)
}): number {
  const { avgSimilarity, clusterSize, reinforcementCount, sourceIntegrity } = params;

  const sizeFactor = Math.min((clusterSize - 2) / 3, 1.0);
  const reinforcementFactor = Math.min(1.0 + reinforcementCount * 0.05, 1.15);
  const base = avgSimilarity * 0.5 + sizeFactor * 0.5;
  const adjusted = base * reinforcementFactor * sourceIntegrity;
  return Number(Math.min(adjusted, 1.0).toFixed(2));
}

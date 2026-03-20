import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationDeps, InsightsInput, InsightsOutput, InsightResultItem } from "./types";
import { parseFrontmatter, parseTagsArray, extractTitleFromMarkdown, extractDistilledItems } from "./inspect";

/**
 * Extract the synthesis paragraph from the `## Synthesis` section.
 */
function extractSynthesis(content: string): string {
  const headingIndex = content.indexOf("## Synthesis");
  if (headingIndex === -1) return "";

  const afterHeading = content.slice(headingIndex + "## Synthesis".length);
  const lines = afterHeading.split("\n");
  const paragraphs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) break; // next heading
    if (trimmed) paragraphs.push(trimmed);
  }

  return paragraphs.join(" ");
}

function parseInsightFile(content: string): InsightResultItem | null {
  const fm = parseFrontmatter(content);
  if (!fm.id || fm.type !== "insight") return null;

  return {
    id: fm.id,
    title: extractTitleFromMarkdown(content),
    insight_type: fm.insight_type || "",
    confidence: fm.confidence !== undefined ? parseFloat(fm.confidence) : 0,
    status: fm.status || "active",
    source_ids: parseTagsArray(fm.source_ids || ""),
    source_count: parseTagsArray(fm.source_ids || "").length,
    synthesis: extractSynthesis(content),
    distilled_items: extractDistilledItems(content),
    tags: parseTagsArray(fm.tags || ""),
    date_saved: fm.date_saved || "",
    ...(fm.last_synthesized_at ? { last_synthesized_at: fm.last_synthesized_at } : {}),
    reinforcement_count: fm.reinforcement_count !== undefined ? parseInt(fm.reinforcement_count) : 0,
    ...(fm.supersedes ? { supersedes: parseTagsArray(fm.supersedes) } : {}),
  };
}

export async function insights(
  params: InsightsInput,
  deps: Pick<OperationDeps, "dataPath" | "qmdSearch" | "memoryIndex">
): Promise<InsightsOutput> {
  const limit = Math.min(params.limit ?? 5, 20);
  const statusFilter = params.status ?? "active";

  // Query path: search QMD filtered to insights
  if (params.query) {
    const qmdResults = await deps.qmdSearch(params.query, {
      intent: "personal knowledge retrieval",
      limit: 50,
    });

    const results: InsightResultItem[] = [];
    for (const r of qmdResults) {
      if (!r.file.includes("/insights/")) continue;

      try {
        const content = await readFile(r.file, "utf-8");
        const item = parseInsightFile(content);
        if (!item) continue;
        if (item.status !== statusFilter) continue;
        if (params.insight_type && item.insight_type !== params.insight_type) continue;
        results.push(item);
        if (results.length >= limit) break;
      } catch {
        continue;
      }
    }

    return { results, total: results.length };
  }

  // No-query path: scan insights directory directly
  const insightsDir = join(deps.dataPath, "insights");
  let files: string[];
  try {
    files = await readdir(insightsDir);
  } catch {
    return { results: [], total: 0 };
  }

  const allInsights: InsightResultItem[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(join(insightsDir, file), "utf-8");
      const item = parseInsightFile(content);
      if (!item) continue;
      if (item.status !== statusFilter) continue;
      if (params.insight_type && item.insight_type !== params.insight_type) continue;
      allInsights.push(item);
    } catch {
      continue;
    }
  }

  // Sort by last_synthesized_at descending, then date_saved descending
  allInsights.sort((a, b) => {
    const aDate = a.last_synthesized_at ?? a.date_saved;
    const bDate = b.last_synthesized_at ?? b.date_saved;
    return bDate.localeCompare(aDate);
  });

  const results = allInsights.slice(0, limit);
  return { results, total: results.length };
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { slugify } from "./slugify";
import type { InsightFrontmatter, InsightOutput, InsightType, InsightStatus } from "@kore/shared-types";
import { parseFrontmatterWithBody as parseFrontmatterYaml, serializeFrontmatter } from "./lib/frontmatter";

// ─── Types ───────────────────────────────────────────────────────────

export interface WriteInsightMetadata {
  category: string;
  sourceIds: string[];
  confidence: number;
  insightType: InsightType;
  supersedes?: string[];
  reinforcementCount?: number;
  status?: InsightStatus;
}

export interface WriteInsightResult {
  insightId: string;
  filePath: string;
}

export interface ConnectionEntry {
  source_id: string;
  target_id: string;
  relationship: string;
}

// ─── Insight File Writer ─────────────────────────────────────────────

/**
 * Generate an insight ID: ins-<8-char UUID prefix>.
 */
function generateInsightId(): string {
  return `ins-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Build the filename for an insight file, truncated to 60 chars total.
 * Format: ins-<uuid-short>-<slug-title>.md
 */
function buildInsightFilename(insightId: string, title: string): string {
  const prefix = `${insightId}-`;
  const maxSlugLen = 60 - prefix.length - 3; // -3 for ".md"
  const slug = slugify(title).slice(0, maxSlugLen);
  return `${prefix}${slug}.md`;
}

/**
 * Render YAML frontmatter for an insight file.
 * Uses string concatenation (same pattern as markdown.ts).
 */
function renderInsightFrontmatter(fm: InsightFrontmatter): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `category: ${fm.category}`,
    `date_saved: ${fm.date_saved}`,
    `source: ${fm.source}`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(", ")}]`,
    `insight_type: ${fm.insight_type}`,
    `source_ids: [${fm.source_ids.map((s) => `"${s}"`).join(", ")}]`,
    `supersedes: [${fm.supersedes.map((s) => `"${s}"`).join(", ")}]`,
    `superseded_by: [${fm.superseded_by.map((s) => `"${s}"`).join(", ")}]`,
    `confidence: ${fm.confidence}`,
    `status: ${fm.status}`,
    `reinforcement_count: ${fm.reinforcement_count}`,
    `re_eval_reason: ${fm.re_eval_reason === null ? "null" : fm.re_eval_reason}`,
    `last_synthesized_at: ${fm.last_synthesized_at}`,
    "---",
  ];
  return lines.join("\n");
}

/**
 * Render a full insight markdown file.
 */
function renderInsightMarkdown(
  frontmatter: InsightFrontmatter,
  synthesis: InsightOutput,
  cluster: Array<{ memoryId: string; frontmatter: Record<string, any> }>,
): string {
  const sections: string[] = [
    renderInsightFrontmatter(frontmatter),
    "",
    `# ${synthesis.title}`,
    "",
    "## Synthesis",
    synthesis.synthesis,
    "",
    "## Key Connections",
  ];

  if (synthesis.connections.length === 0) {
    sections.push("No direct connections identified.");
  } else {
    for (const conn of synthesis.connections) {
      const sourceTitle = cluster.find((c) => c.memoryId === conn.source_id)?.frontmatter?.title ?? "Unknown";
      const targetTitle = cluster.find((c) => c.memoryId === conn.target_id)?.frontmatter?.title ?? "Unknown";
      sections.push(
        `- **${conn.source_id}** ("${sourceTitle}") → **${conn.target_id}** ("${targetTitle}"): ${conn.relationship}`
      );
    }
  }

  sections.push("");
  sections.push("## Distilled Memory Items");
  for (const item of synthesis.distilled_items) {
    sections.push(`- **${item}**`);
  }

  sections.push("");
  sections.push("## Source Material");
  sections.push(
    `Synthesized from ${frontmatter.source_ids.length} memories: ${frontmatter.source_ids.join(", ")}`
  );
  sections.push("");

  return sections.join("\n");
}

/**
 * Write an insight file to disk and return its ID and path.
 *
 * Write ordering guarantee (design doc §7.1): this function only writes
 * the insight file. Source frontmatter updates must happen AFTER this returns.
 */
export async function writeInsight(
  synthesis: InsightOutput,
  cluster: Array<{ memoryId: string; frontmatter: Record<string, any> }>,
  dataPath: string,
  metadata: WriteInsightMetadata,
): Promise<WriteInsightResult> {
  const insightId = generateInsightId();
  const now = new Date().toISOString();

  const frontmatter: InsightFrontmatter = {
    id: insightId,
    type: "insight",
    category: metadata.category,
    date_saved: now,
    source: "kore_synthesis",
    tags: synthesis.tags,
    insight_type: metadata.insightType,
    source_ids: metadata.sourceIds,
    supersedes: metadata.supersedes ?? [],
    superseded_by: [],
    confidence: metadata.confidence,
    status: metadata.status ?? "active",
    reinforcement_count: metadata.reinforcementCount ?? 0,
    re_eval_reason: null,
    last_synthesized_at: now,
  };

  const insightsDir = join(dataPath, "insights");
  await mkdir(insightsDir, { recursive: true });

  const filename = buildInsightFilename(insightId, synthesis.title);
  const filePath = join(insightsDir, filename);
  const content = renderInsightMarkdown(frontmatter, synthesis, cluster);

  await Bun.write(filePath, content);

  return { insightId, filePath };
}

// ─── Dedup Detection ─────────────────────────────────────────────────

/**
 * Check if a new insight would be a duplicate of an existing one.
 * Returns the existing insight if source_ids overlap ≥ 50%, else null.
 */
export function checkDedup(
  sourceIds: string[],
  existingInsights: Array<{ source_ids: string[]; [key: string]: any }>,
): { source_ids: string[]; [key: string]: any } | null {
  const sourceSet = new Set(sourceIds);

  for (const existing of existingInsights) {
    const overlap = existing.source_ids.filter((id) => sourceSet.has(id)).length;
    const ratio = overlap / existing.source_ids.length;
    if (ratio >= 0.5) {
      return existing;
    }
  }

  return null;
}

// ─── Supersession ────────────────────────────────────────────────────

/**
 * Mark an old insight as superseded by a new one.
 * Sets superseded_by and status: "retired" on the old insight file.
 */
export async function supersede(
  oldInsightFilePath: string,
  newInsightId: string,
): Promise<void> {
  const content = await Bun.file(oldInsightFilePath).text();
  const { frontmatter, body } = parseFrontmatterYaml(content);

  // Append new insight ID to superseded_by
  const supersededBy = Array.isArray(frontmatter.superseded_by)
    ? frontmatter.superseded_by
    : [];
  if (!supersededBy.includes(newInsightId)) {
    supersededBy.push(newInsightId);
  }
  frontmatter.superseded_by = supersededBy;
  frontmatter.status = "retired";

  const updated = serializeFrontmatter(frontmatter) + body;
  await Bun.write(oldInsightFilePath, updated);
}

// ─── Source Frontmatter Updater ──────────────────────────────────────

/**
 * Update source memory files with consolidation back-references.
 * Adds consolidated_at timestamp and appends insightId to insight_refs[].
 *
 * Preserves all existing frontmatter fields and body content.
 * Idempotent: skips sources that already reference the insight ID.
 */
export async function updateSourceFrontmatter(
  sourceFilePaths: string[],
  insightId: string,
): Promise<void> {
  const now = new Date().toISOString();

  for (const filePath of sourceFilePaths) {
    const content = await Bun.file(filePath).text();
    const { frontmatter, body } = parseFrontmatterYaml(content);

    // Parse existing insight_refs
    const refs: string[] = Array.isArray(frontmatter.insight_refs)
      ? frontmatter.insight_refs
      : [];

    // Skip if already referenced (idempotent)
    if (refs.includes(insightId)) continue;

    // Add the new ref via Set for dedup safety
    const refSet = new Set(refs);
    refSet.add(insightId);
    frontmatter.insight_refs = [...refSet];
    frontmatter.consolidated_at = now;

    const updated = serializeFrontmatter(frontmatter) + body;
    await Bun.write(filePath, updated);
  }
}

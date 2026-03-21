import { join } from "node:path";
import type { OperationDeps, InspectOutput } from "./types";
import {
  parseFrontmatter,
  parseTagsArray,
  extractTitleFromMarkdown,
  extractDistilledItems,
  parseMemoryFileFull,
} from "../lib/frontmatter";
import type { MemoryFileFull } from "../lib/frontmatter";

// Re-export for downstream consumers
export {
  parseFrontmatter,
  parseTagsArray,
  extractTitleFromMarkdown,
  extractDistilledItems,
  parseMemoryFileFull,
};
export type { MemoryFileFull };

const CONTENT_TRUNCATION_LIMIT = 20_000;

/**
 * Resolve a QMD virtual path (e.g. "qmd://memories/notes/foo.md") to an
 * absolute filesystem path, or return the input unchanged if already absolute.
 */
export function resolveQmdPath(virtualPath: string, dataPath: string): string {
  const prefix = "qmd://memories/";
  if (virtualPath.startsWith(prefix)) {
    return join(dataPath, virtualPath.slice(prefix.length));
  }
  return virtualPath;
}

// ─── Inspect Operation ───────────────────────────────────────────

export async function inspect(
  id: string,
  deps: Pick<OperationDeps, "memoryIndex">
): Promise<InspectOutput | null> {
  const filePath = deps.memoryIndex.get(id);
  if (!filePath) return null;

  const memory = await parseMemoryFileFull(id, filePath);
  if (!memory) return null;

  const distilled_items = extractDistilledItems(memory.content);
  const truncatedContent = memory.content.length > CONTENT_TRUNCATION_LIMIT
    ? memory.content.slice(0, CONTENT_TRUNCATION_LIMIT)
    : memory.content;

  const result: InspectOutput = {
    id: memory.id,
    title: memory.title,
    type: memory.type,
    category: memory.category,
    tags: memory.tags,
    date_saved: memory.date_saved,
    source: memory.source,
    distilled_items,
    content: truncatedContent,
  };

  // Optional fields
  if (memory.intent) result.intent = memory.intent;
  if (memory.confidence !== undefined) result.confidence = memory.confidence;
  if (memory.date_created) result.date_created = memory.date_created;
  if (memory.date_modified) result.date_modified = memory.date_modified;
  if (memory.url) result.url = memory.url;
  if (memory.consolidated_at) result.consolidated_at = memory.consolidated_at;
  if (memory.insight_refs) result.insight_refs = memory.insight_refs;

  // Insight-specific fields
  if (memory.type === "insight") {
    if (memory.insight_type) result.insight_type = memory.insight_type;
    if (memory.source_ids) result.source_ids = memory.source_ids;
    if (memory.supersedes) result.supersedes = memory.supersedes;
    if (memory.superseded_by) result.superseded_by = memory.superseded_by;
    if (memory.status) result.status = memory.status;
    if (memory.reinforcement_count !== undefined) result.reinforcement_count = memory.reinforcement_count;
  }

  return result;
}

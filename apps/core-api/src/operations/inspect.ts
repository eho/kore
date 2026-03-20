import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationDeps, InspectOutput } from "./types";

const CONTENT_TRUNCATION_LIMIT = 20_000;

// ─── Helpers ──────────────────────────────────────────────────────

export function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

export function parseTagsArray(raw: string): string[] {
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch {
    return raw ? [raw] : [];
  }
}

export function extractTitleFromMarkdown(content: string): string {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : "";
}

/**
 * Extract distilled items from the `## Distilled Memory Items` Markdown section.
 * Collects `- ` bullet lines until the next heading or EOF.
 */
export function extractDistilledItems(fileContent: string): string[] {
  const headingIndex = fileContent.indexOf("## Distilled Memory Items");
  if (headingIndex === -1) return [];

  const afterHeading = fileContent.slice(headingIndex + "## Distilled Memory Items".length);
  const lines = afterHeading.split("\n");
  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) break; // next heading
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

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

// ─── parseMemoryFileFull ──────────────────────────────────────────

export interface MemoryFileFull {
  id: string;
  type: string;
  title: string;
  category: string;
  date_saved: string;
  date_created?: string;
  date_modified?: string;
  source: string;
  tags: string[];
  url?: string;
  intent?: string;
  confidence?: number;
  content: string;
  // Consolidation metadata
  consolidated_at?: string;
  insight_refs?: string[];
  // Insight-specific fields
  insight_type?: string;
  status?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  reinforcement_count?: number;
  last_synthesized_at?: string;
  // Derived
  source_ids_count?: number;
}

export async function parseMemoryFileFull(id: string, filePath: string): Promise<MemoryFileFull | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    const full: MemoryFileFull = {
      id: fm.id,
      type: fm.type || "",
      category: fm.category || "",
      date_saved: fm.date_saved || "",
      ...(fm.date_created ? { date_created: fm.date_created } : {}),
      ...(fm.date_modified ? { date_modified: fm.date_modified } : {}),
      source: fm.source || "",
      tags: parseTagsArray(fm.tags || ""),
      url: fm.url || undefined,
      ...(fm.intent ? { intent: fm.intent } : {}),
      ...(fm.confidence !== undefined ? { confidence: parseFloat(fm.confidence) } : {}),
      ...(fm.consolidated_at ? { consolidated_at: fm.consolidated_at } : {}),
      title: extractTitleFromMarkdown(content),
      content,
    };
    // Parse insight_refs
    if (fm.insight_refs) {
      full.insight_refs = parseTagsArray(fm.insight_refs);
    }
    // Add insight-specific fields
    if (fm.type === "insight") {
      if (fm.insight_type) full.insight_type = fm.insight_type;
      if (fm.status) full.status = fm.status;
      full.source_ids = parseTagsArray(fm.source_ids || "");
      full.source_ids_count = full.source_ids.length;
      full.supersedes = parseTagsArray(fm.supersedes || "");
      full.superseded_by = parseTagsArray(fm.superseded_by || "");
      if (fm.reinforcement_count !== undefined) full.reinforcement_count = parseInt(fm.reinforcement_count);
      if (fm.last_synthesized_at) full.last_synthesized_at = fm.last_synthesized_at;
    }
    return full;
  } catch {
    return null;
  }
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

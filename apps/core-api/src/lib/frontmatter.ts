import { readFile } from "node:fs/promises";

// ─── Frontmatter Types ───────────────────────────────────────────────

/**
 * Parsed frontmatter fields. Values are `unknown` — callers should use
 * String(), Number(), Array.isArray(), etc. to narrow before use.
 */
export type FrontmatterFields = Record<string, unknown>;

// ─── Frontmatter Parsing ─────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file content string.
 * Handles arrays in bracket notation, null values, and numeric coercion.
 */
export function parseFrontmatter(content: string): FrontmatterFields {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, unknown> = {};
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
 * Parse frontmatter and return both the parsed fields and the body content.
 */
export function parseFrontmatterWithBody(content: string): {
  frontmatter: FrontmatterFields;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = parseFrontmatter(content);
  const endIdx = content.indexOf("---", 4);
  const body = endIdx !== -1 ? content.slice(endIdx + 3) : "";

  return { frontmatter, body };
}

/**
 * Serialize frontmatter back to YAML string (with surrounding --- delimiters).
 */
export function serializeFrontmatter(fm: FrontmatterFields): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ─── Tag & Title Helpers ─────────────────────────────────────────────

/**
 * Parse a tags field into an array of strings.
 * Accepts either a raw string (e.g. '["a","b"]') or an already-parsed array.
 */
export function parseTagsArray(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
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

// ─── Memory File Parsers ─────────────────────────────────────────────

export interface MemorySummary {
  id: string;
  type: string;
  title: string;
  source: string;
  date_saved: string;
  date_created?: string;
  date_modified?: string;
  tags: string[];
  intent?: string;
  confidence?: number;
  insight_type?: string;
  status?: string;
  source_ids_count?: number;
}

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
  consolidated_at?: string;
  insight_refs?: string[];
  insight_type?: string;
  status?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  reinforcement_count?: number;
  last_synthesized_at?: string;
  source_ids_count?: number;
}

export async function parseMemoryFile(id: string, filePath: string): Promise<MemorySummary | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    const summary: MemorySummary = {
      id: String(fm.id),
      type: String(fm.type || ""),
      title: extractTitleFromMarkdown(content),
      source: String(fm.source || ""),
      date_saved: String(fm.date_saved || ""),
      ...(fm.date_created ? { date_created: String(fm.date_created) } : {}),
      ...(fm.date_modified ? { date_modified: String(fm.date_modified) } : {}),
      tags: parseTagsArray((fm.tags as string | string[]) || ""),
      ...(fm.intent ? { intent: String(fm.intent) } : {}),
      ...(fm.confidence !== undefined ? { confidence: Number(fm.confidence) } : {}),
    };
    if (fm.type === "insight") {
      if (fm.insight_type) summary.insight_type = String(fm.insight_type);
      if (fm.status) summary.status = String(fm.status);
      const sourceIds = parseTagsArray((fm.source_ids as string | string[]) || "");
      summary.source_ids_count = sourceIds.length;
    }
    return summary;
  } catch {
    return null;
  }
}

export async function parseMemoryFileFull(id: string, filePath: string): Promise<MemoryFileFull | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    const full: MemoryFileFull = {
      id: String(fm.id),
      type: String(fm.type || ""),
      category: String(fm.category || ""),
      date_saved: String(fm.date_saved || ""),
      ...(fm.date_created ? { date_created: String(fm.date_created) } : {}),
      ...(fm.date_modified ? { date_modified: String(fm.date_modified) } : {}),
      source: String(fm.source || ""),
      tags: parseTagsArray((fm.tags as string | string[]) || ""),
      url: fm.url ? String(fm.url) : undefined,
      ...(fm.intent ? { intent: String(fm.intent) } : {}),
      ...(fm.confidence !== undefined ? { confidence: Number(fm.confidence) } : {}),
      ...(fm.consolidated_at ? { consolidated_at: String(fm.consolidated_at) } : {}),
      title: extractTitleFromMarkdown(content),
      content,
    };
    if (fm.insight_refs) {
      full.insight_refs = parseTagsArray(fm.insight_refs as string | string[]);
    }
    if (fm.type === "insight") {
      if (fm.insight_type) full.insight_type = String(fm.insight_type);
      if (fm.status) full.status = String(fm.status);
      full.source_ids = parseTagsArray((fm.source_ids as string | string[]) || "");
      full.source_ids_count = full.source_ids.length;
      full.supersedes = parseTagsArray((fm.supersedes as string | string[]) || "");
      full.superseded_by = parseTagsArray((fm.superseded_by as string | string[]) || "");
      if (fm.reinforcement_count !== undefined) full.reinforcement_count = Number(fm.reinforcement_count);
      if (fm.last_synthesized_at) full.last_synthesized_at = String(fm.last_synthesized_at);
    }
    return full;
  } catch {
    return null;
  }
}

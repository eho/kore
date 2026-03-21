import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./lib/frontmatter";
import { resolveQmdPath } from "./operations";
import type { MemoryIndex } from "./memory-index";
import type { SeedMemory, CandidateResult } from "./consolidation-candidate-finder";
import type { ClusterMember } from "./consolidation-synthesizer";

// ─── Seed & Cluster Loaders ──────────────────────────────────────────

/**
 * Load a memory file from disk and build a SeedMemory object.
 */
export async function loadSeedFromDisk(filePath: string): Promise<SeedMemory | null> {
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
export async function loadClusterMemberFiles(filePath: string, fm: Record<string, any>): Promise<ClusterMember> {
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
 * Resolves QMD virtual paths to absolute filesystem paths before index lookup.
 */
export async function enrichCandidatesWithFiles(
  candidates: CandidateResult[],
  memoryIndex: MemoryIndex,
  dataPath: string,
): Promise<CandidateResult[]> {
  const enriched: CandidateResult[] = [];
  for (const c of candidates) {
    const absolutePath = resolveQmdPath(c.filePath, dataPath);
    const id = memoryIndex.getIdByPath(absolutePath);

    if (!id) {
      console.log(`[consolidation] Candidate dropped: no memoryIndex match for path "${absolutePath}" (QMD: "${c.filePath}")`);
      continue;
    }
    try {
      const content = await Bun.file(absolutePath).text();
      const fm = parseFrontmatter(content);
      enriched.push({ ...c, filePath: absolutePath, memoryId: id, frontmatter: fm });
    } catch {
      enriched.push({ ...c, filePath: absolutePath, memoryId: id });
    }
  }
  return enriched;
}

/**
 * Get all existing insight frontmatters from disk.
 */
export async function getExistingInsights(dataPath: string): Promise<Array<{ id: string; source_ids: string[]; filePath: string; [key: string]: any }>> {
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

import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryIndex } from "./memory-index";
import type { ConsolidationTracker } from "./consolidation-tracker";

export interface ResetConsolidationDeps {
  dataPath: string;
  tracker: ConsolidationTracker;
  memoryIndex: MemoryIndex;
  qmdUpdate: () => Promise<unknown>;
}

export interface ResetConsolidationResult {
  deletedInsights: number;
  restoredMemories: number;
  trackerBackfilled: number;
}

/**
 * Remove `consolidated_at` and `insight_refs` fields from a memory file's frontmatter.
 * Returns true if the file was modified, false if no changes were needed.
 */
async function removeConsolidationFields(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    console.warn(`[consolidation-reset] Could not read file: ${filePath}`);
    return false;
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  const fmBlock = fmMatch[1];

  // Check if there are fields to remove
  const hasConsolidatedAt = /^consolidated_at:.*$/m.test(fmBlock);
  const hasInsightRefs = /^insight_refs:.*$/m.test(fmBlock);

  if (!hasConsolidatedAt && !hasInsightRefs) return false;

  let updatedFm = fmBlock;
  if (hasConsolidatedAt) {
    updatedFm = updatedFm.replace(/^consolidated_at:.*\n?/m, "");
  }
  if (hasInsightRefs) {
    updatedFm = updatedFm.replace(/^insight_refs:.*\n?/m, "");
  }

  // Remove trailing newline from frontmatter block if stripping left one
  updatedFm = updatedFm.replace(/\n$/, "");

  const updatedContent = content.replace(fmMatch[0], `---\n${updatedFm}\n---`);
  try {
    await writeFile(filePath, updatedContent, "utf-8");
  } catch (err) {
    console.warn(`[consolidation-reset] Could not write file: ${filePath}`, err);
    return false;
  }
  return true;
}

/**
 * Reset all consolidation artifacts while preserving ingested memories.
 *
 * 1. Strip `consolidated_at` and `insight_refs` from ALL non-insight memories
 * 2. Delete all insight files and recreate the empty directory
 * 3. Remove insight entries from memoryIndex
 * 4. Truncate the tracker and backfill all remaining memories as pending
 * 5. Call qmdUpdate() to sync the search index
 */
export async function resetConsolidation(
  deps: ResetConsolidationDeps,
): Promise<ResetConsolidationResult> {
  const { dataPath, tracker, memoryIndex, qmdUpdate } = deps;

  // 1. Strip consolidation fields from all non-insight memories
  let restoredMemories = 0;
  for (const [_id, filePath] of memoryIndex.entries()) {
    if (filePath.includes("/insights/")) continue;
    const modified = await removeConsolidationFields(filePath);
    if (modified) restoredMemories++;
  }

  // 2. Delete all insight files and recreate the directory
  const insightsDir = join(dataPath, "insights");
  let deletedInsights = 0;

  try {
    const files = await readdir(insightsDir);
    deletedInsights = files.filter((f) => f.endsWith(".md")).length;
  } catch {
    // directory may not exist
  }

  try {
    await rm(insightsDir, { recursive: true, force: true });
  } catch (err) {
    console.warn("[consolidation-reset] Could not delete insights directory:", err);
  }
  await mkdir(insightsDir, { recursive: true });

  // 3. Remove insight entries from memoryIndex
  const insightIds: string[] = [];
  for (const [id, filePath] of memoryIndex.entries()) {
    if (filePath.includes("/insights/") || id.startsWith("ins-")) {
      insightIds.push(id);
    }
  }
  for (const id of insightIds) {
    memoryIndex.delete(id);
  }

  // 4. Truncate tracker and backfill all remaining memories as pending
  tracker.truncateAll();

  let trackerBackfilled = 0;
  for (const [id, filePath] of memoryIndex.entries()) {
    const type = filePath.includes("/people/")
      ? "person"
      : filePath.includes("/places/")
        ? "place"
        : filePath.includes("/media/")
          ? "media"
          : "note";
    tracker.upsertMemory(id, type);
    trackerBackfilled++;
  }

  // 5. Call qmdUpdate() to remove stale insight vectors and update metadata
  try {
    await qmdUpdate();
  } catch (err) {
    console.warn("[consolidation-reset] qmdUpdate failed (non-fatal):", err);
  }

  return { deletedInsights, restoredMemories, trackerBackfilled };
}

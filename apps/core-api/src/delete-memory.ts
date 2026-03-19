import { unlink, readFile, writeFile } from "node:fs/promises";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import type { ConsolidationTracker } from "./consolidation-tracker";

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Parse arrays: ["a", "b"]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface DeleteMemoryDeps {
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
  consolidationTracker?: ConsolidationTracker;
}

export interface DeleteMemoryResult {
  deleted: boolean;
  restoredSources: number;
}

/**
 * Remove an insight ID from insight_refs in a source memory's frontmatter.
 * Single-pass I/O: when insight_refs becomes empty, also strips consolidated_at.
 * Returns { refsEmpty } indicating whether all insight refs have been removed.
 */
export async function removeInsightRefFromSource(
  sourceFilePath: string,
  insightId: string,
): Promise<{ refsEmpty: boolean }> {
  let content: string;
  try {
    content = await readFile(sourceFilePath, "utf-8");
  } catch {
    return { refsEmpty: false }; // source file may not exist
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { refsEmpty: false };

  const fmBlock = fmMatch[1];
  // Check if insight_refs contains this insight ID
  const refsMatch = fmBlock.match(/^insight_refs:\s*\[(.*)?\]$/m);
  if (!refsMatch) return { refsEmpty: false };

  const inner = refsMatch[1]?.trim() ?? "";
  if (!inner) return { refsEmpty: true }; // already empty

  const refs = inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((ref) => ref !== insightId);

  const refsEmpty = refs.length === 0;

  const newRefsLine = refs.length > 0
    ? `insight_refs: [${refs.map((r) => `"${r}"`).join(", ")}]`
    : `insight_refs: []`;

  let updatedFm = fmBlock.replace(/^insight_refs:\s*\[.*\]$/m, newRefsLine);

  // Single-pass: also strip consolidated_at when refs become empty
  if (refsEmpty) {
    updatedFm = updatedFm.replace(/^consolidated_at:.*\n?/m, "");
  }

  const updatedContent = content.replace(fmMatch[0], `---\n${updatedFm}\n---`);

  await writeFile(sourceFilePath, updatedContent, "utf-8");
  return { refsEmpty };
}

/**
 * Delete a memory by ID: removes the file from disk, updates the index,
 * and emits a memory.deleted event.
 *
 * For insight deletions: also removes the insight ID from insight_refs
 * in all source memory frontmatter files. When a source's refs become empty,
 * resets it to pending in the consolidation tracker.
 */
export async function deleteMemoryById(
  id: string,
  deps: DeleteMemoryDeps
): Promise<DeleteMemoryResult> {
  const filePath = deps.memoryIndex.get(id);
  if (!filePath) return { deleted: false, restoredSources: 0 };

  // Read frontmatter before deleting for the event payload
  let frontmatter: Record<string, any> = {};
  try {
    const content = await readFile(filePath, "utf-8");
    frontmatter = parseFrontmatter(content);
  } catch {
    // file may already be gone
  }

  // If this is an insight, clean up insight_refs from source memories
  let restoredSources = 0;
  if (frontmatter.type === "insight" && Array.isArray(frontmatter.source_ids)) {
    for (const sourceId of frontmatter.source_ids) {
      const sourcePath = deps.memoryIndex.get(sourceId);
      if (sourcePath) {
        const { refsEmpty } = await removeInsightRefFromSource(sourcePath, id);
        if (refsEmpty && deps.consolidationTracker) {
          deps.consolidationTracker.resetToPending(sourceId);
          restoredSources++;
        }
      }
    }
  }

  try {
    await unlink(filePath);
  } catch {
    return { deleted: false, restoredSources: 0 };
  }

  deps.memoryIndex.delete(id);

  await deps.eventDispatcher.emit("memory.deleted", {
    id,
    filePath,
    frontmatter,
    timestamp: new Date().toISOString(),
  });

  return { deleted: true, restoredSources };
}

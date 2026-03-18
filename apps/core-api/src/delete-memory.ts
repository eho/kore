import { unlink, readFile, writeFile } from "node:fs/promises";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";

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
}

/**
 * Remove an insight ID from insight_refs in a source memory's frontmatter.
 * Preserves all other content.
 */
async function removeInsightRefFromSource(
  sourceFilePath: string,
  insightId: string,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(sourceFilePath, "utf-8");
  } catch {
    return; // source file may not exist
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[1];
  // Check if insight_refs contains this insight ID
  const refsMatch = fmBlock.match(/^insight_refs:\s*\[(.*)?\]$/m);
  if (!refsMatch) return;

  const inner = refsMatch[1]?.trim() ?? "";
  if (!inner) return;

  const refs = inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((ref) => ref !== insightId);

  const newRefsLine = refs.length > 0
    ? `insight_refs: [${refs.map((r) => `"${r}"`).join(", ")}]`
    : `insight_refs: []`;

  const updatedFm = fmBlock.replace(/^insight_refs:\s*\[.*\]$/m, newRefsLine);
  const updatedContent = content.replace(fmMatch[0], `---\n${updatedFm}\n---`);

  await writeFile(sourceFilePath, updatedContent, "utf-8");
}

/**
 * Delete a memory by ID: removes the file from disk, updates the index,
 * and emits a memory.deleted event. Returns true if deleted, false if not found.
 *
 * For insight deletions: also removes the insight ID from insight_refs
 * in all source memory frontmatter files.
 */
export async function deleteMemoryById(
  id: string,
  deps: DeleteMemoryDeps
): Promise<boolean> {
  const filePath = deps.memoryIndex.get(id);
  if (!filePath) return false;

  // Read frontmatter before deleting for the event payload
  let frontmatter: Record<string, any> = {};
  try {
    const content = await readFile(filePath, "utf-8");
    frontmatter = parseFrontmatter(content);
  } catch {
    // file may already be gone
  }

  // If this is an insight, clean up insight_refs from source memories
  if (frontmatter.type === "insight" && Array.isArray(frontmatter.source_ids)) {
    for (const sourceId of frontmatter.source_ids) {
      const sourcePath = deps.memoryIndex.get(sourceId);
      if (sourcePath) {
        await removeInsightRefFromSource(sourcePath, id);
      }
    }
  }

  try {
    await unlink(filePath);
  } catch {
    return false;
  }

  deps.memoryIndex.delete(id);

  await deps.eventDispatcher.emit("memory.deleted", {
    id,
    filePath,
    frontmatter,
    timestamp: new Date().toISOString(),
  });

  return true;
}

import { unlink, readFile } from "node:fs/promises";
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
    result[key] = value;
  }
  return result;
}

export interface DeleteMemoryDeps {
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
}

/**
 * Delete a memory by ID: removes the file from disk, updates the index,
 * and emits a memory.deleted event. Returns true if deleted, false if not found.
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

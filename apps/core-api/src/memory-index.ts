import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const TYPE_DIRS = ["places", "media", "notes", "people", "insights"];

/**
 * In-memory Map<id, filePath> index built by scanning all .md files
 * in $KORE_DATA_PATH on startup, parsing `id` from YAML frontmatter.
 */
export class MemoryIndex {
  private index = new Map<string, string>();

  /** Scan all .md files and populate the index. */
  async build(dataPath: string): Promise<void> {
    this.index.clear();
    for (const dir of TYPE_DIRS) {
      const dirPath = join(dataPath, dir);
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch {
        continue; // directory may not exist yet
      }
      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(dirPath, file);
        const id = await this.parseIdFromFile(filePath);
        if (id) {
          this.index.set(id, filePath);
        }
      }
    }
  }

  /** Get file path by exact id or unique prefix. Returns undefined if not found or ambiguous. */
  get(id: string): string | undefined {
    const exact = this.index.get(id);
    if (exact) return exact;
    // Prefix match (e.g. first 8 chars from `kore list`)
    let match: string | undefined;
    for (const key of this.index.keys()) {
      if (key.startsWith(id)) {
        if (match !== undefined) return undefined; // ambiguous
        match = this.index.get(key);
      }
    }
    return match;
  }

  /** Add or update an entry in the index. */
  set(id: string, filePath: string): void {
    this.index.set(id, filePath);
  }

  /** Remove an entry from the index. */
  delete(id: string): void {
    this.index.delete(id);
  }

  /** Return the number of indexed memories. */
  get size(): number {
    return this.index.size;
  }

  /** Look up an id by its file path. Returns undefined if not found. */
  getIdByPath(filePath: string): string | undefined {
    for (const [id, fp] of this.index) {
      if (fp === filePath) return id;
    }
    return undefined;
  }

  /** Iterate over all [id, filePath] pairs. */
  entries(): IterableIterator<[string, string]> {
    return this.index.entries();
  }

  private async parseIdFromFile(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      // Parse id from YAML frontmatter between --- delimiters
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const idMatch = match[1].match(/^id:\s*(.+)$/m);
      return idMatch ? idMatch[1].trim() : null;
    } catch {
      return null;
    }
  }
}

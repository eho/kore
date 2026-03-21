import { Elysia, t } from "elysia";
import { randomUUID } from "crypto";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BaseFrontmatterSchema } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";
import { z } from "zod";
import { renderMarkdown } from "../markdown";
import { deleteMemoryById } from "../delete-memory";
import { resolveFilePath, TYPE_DIRS, ensureDataDirectories } from "../lib/file-utils";
import { resolveQmdDbPath } from "../config";
import * as qmdClient from "@kore/qmd-client";
import type { MemoryIndex } from "../memory-index";
import type { EventDispatcher } from "../event-dispatcher";
import type { ConsolidationTracker } from "../consolidation-tracker";
import type { QueueRepository } from "../queue";
import type { PluginRegistryRepository } from "../plugin-registry";

const StructuredIngestPayload = z.object({
  content: z.object({
    title: z.string(),
    markdown_body: z.string(),
    frontmatter: BaseFrontmatterSchema.omit({ id: true }),
  }),
});

interface MemoryDeps {
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
  queue: QueueRepository;
  dataPath: string;
  consolidationTracker?: ConsolidationTracker;
  pluginRegistry?: PluginRegistryRepository;
}

export function createMemoryRoutes(deps: MemoryDeps) {
  const { memoryIndex, eventDispatcher, queue, dataPath, consolidationTracker, pluginRegistry } = deps;

  return new Elysia()
    // ─── Delete All Memories (Reset) ────────────────────────────────
    // NOTE: must be registered before DELETE /api/v1/memory/:id to avoid
    // memoirist radix-trie shadowing (shared "memory" prefix).
    .delete("/api/v1/memories", async ({ set }) => {
      // Count memories before deletion
      let deletedMemories = 0;
      for (const _ of memoryIndex.entries()) {
        deletedMemories++;
      }

      // Delete and recreate data directories
      for (const dir of Object.values(TYPE_DIRS)) {
        const dirPath = join(dataPath, dir);
        try {
          await rm(dirPath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Warning: failed to delete directory ${dirPath}:`, err);
        }
      }
      await ensureDataDirectories(dataPath);

      // Rebuild in-memory index (now empty)
      await memoryIndex.build(dataPath);

      // Truncate consolidation tracker if available
      if (consolidationTracker) {
        consolidationTracker.truncateAll();
      }

      // Clear task queue and plugin registry
      const deletedTasks = queue.clearAll();
      if (pluginRegistry) {
        pluginRegistry.clearAll();
      }

      // Reset QMD index (with timeout to avoid hanging if background ops are in-flight)
      const qmdDbPath = resolveQmdDbPath();
      try {
        await Promise.race([
          qmdClient.closeStore(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("closeStore timeout")), 5_000)
          ),
        ]);
      } catch (err) {
        console.warn("Warning: QMD closeStore timed out or failed, force-resetting:", err instanceof Error ? err.message : err);
        qmdClient.resetStore();
      }
      try {
        await rm(qmdDbPath, { force: true });
        await rm(`${qmdDbPath}-wal`, { force: true });
        await rm(`${qmdDbPath}-shm`, { force: true });
        await qmdClient.initStore(qmdDbPath);
      } catch (err) {
        console.warn("Warning: QMD store re-init encountered an error:", err);
      }

      return {
        status: "reset",
        deleted_memories: deletedMemories,
        deleted_tasks: deletedTasks,
      };
    })
    // ─── Delete Memory ────────────────────────────────────────────
    .delete("/api/v1/memory/:id", async ({ params, set }) => {
      const result = await deleteMemoryById(params.id, {
        memoryIndex,
        eventDispatcher,
        consolidationTracker,
      });
      if (!result.deleted) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }
      return { status: "deleted", id: params.id, restored_sources: result.restoredSources };
    })
    // ─── Update Memory ────────────────────────────────────────────
    .put("/api/v1/memory/:id", async ({ params, body, set }) => {
      const existingPath = memoryIndex.get(params.id);
      if (!existingPath) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }

      const result = StructuredIngestPayload.safeParse(body);
      if (!result.success) {
        set.status = 400;
        return {
          error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          code: "VALIDATION_ERROR",
        };
      }

      const { title, markdown_body, frontmatter } = result.data.content;
      const fullFrontmatter: BaseFrontmatter = { id: params.id, ...frontmatter };

      // Resolve new file path based on updated type/title
      const newFilePath = await resolveFilePath(dataPath, frontmatter.type, title);

      const md = renderMarkdown({
        frontmatter: fullFrontmatter,
        title,
        distilledItems: undefined,
        rawSource: markdown_body,
      });

      // Delete old file if path changed
      if (existingPath !== newFilePath) {
        try {
          await unlink(existingPath);
        } catch {
          // old file may not exist
        }
      }

      await Bun.write(newFilePath, md);

      // Update index with new path
      memoryIndex.set(params.id, newFilePath);

      await eventDispatcher.emit("memory.updated", {
        id: params.id,
        filePath: newFilePath,
        frontmatter: fullFrontmatter,
        timestamp: new Date().toISOString(),
      });

      return { status: "updated", id: params.id, file_path: newFilePath };
    }, { body: t.Any() });
}

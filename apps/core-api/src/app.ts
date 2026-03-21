import { Elysia, t } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { cors } from "@elysiajs/cors";
import { z } from "zod";
import { randomUUID } from "crypto";
import { BaseFrontmatterSchema } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";
import { QueueRepository } from "./queue";
import { slugify } from "./slugify";
import { renderMarkdown } from "./markdown";
import { mkdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataPath, resolveQmdDbPath } from "./config";
import * as qmdClient from "@kore/qmd-client";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { deleteMemoryById } from "./delete-memory";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { ConsolidationHandle } from "./consolidation-loop";
import { resetConsolidation } from "./consolidation-reset";
import type { PluginRegistryRepository } from "./plugin-registry";
import { health as healthOp, recall, remember, inspect as inspectOp, insights as insightsOp, consolidate as consolidateOp } from "./operations";
import type { RecallInput, InsightsInput, ConsolidateInput } from "./operations";

// ─── Zod Schemas for request validation ─────────────────────────────

const StructuredIngestPayload = z.object({
  content: z.object({
    title: z.string(),
    markdown_body: z.string(),
    frontmatter: BaseFrontmatterSchema.omit({ id: true }),
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────

const TYPE_DIRS: Record<string, string> = {
  place: "places",
  media: "media",
  note: "notes",
  person: "people",
  insight: "insights",
};

export async function ensureDataDirectories(dataPath: string): Promise<void> {
  for (const dir of Object.values(TYPE_DIRS)) {
    await mkdir(join(dataPath, dir), { recursive: true });
  }
}

async function resolveFilePath(
  dataPath: string,
  type: string,
  title: string
): Promise<string> {
  const dir = join(dataPath, TYPE_DIRS[type] || "notes");
  const slug = slugify(title);
  let filePath = join(dir, `${slug}.md`);

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const hash = randomUUID().replace(/-/g, "").slice(0, 4);
    filePath = join(dir, `${slug}_${hash}.md`);
  }

  return filePath;
}

// ─── QMD Health Status ───────────────────────────────────────────────

export interface QmdHealthSummary {
  status: "ok" | "bootstrapping" | "unavailable";
  doc_count?: number;
  collections?: number;
  needs_embedding?: number;
}

// ─── App Factory ─────────────────────────────────────────────────────

export interface AppDeps {
  queue?: QueueRepository;
  qmdStatus?: () => Promise<QmdHealthSummary>;
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
  dataPath?: string;
  memoryIndex?: MemoryIndex;
  eventDispatcher?: EventDispatcher;
  consolidationTracker?: ConsolidationTracker;
  pluginRegistry?: PluginRegistryRepository;
  consolidationLoopHandle?: ConsolidationHandle;
  qmdUpdateFn?: () => Promise<unknown>;
}

export function createApp(deps: AppDeps = {}) {
  const dataPath = deps.dataPath || resolveDataPath();
  const queue = deps.queue || new QueueRepository();
  const qmdStatus = deps.qmdStatus || (async () => ({ status: "unavailable" as const }));
  const searchFn = deps.searchFn;
  const memoryIndex = deps.memoryIndex || new MemoryIndex();
  const eventDispatcher = deps.eventDispatcher || new EventDispatcher();
  const apiKey = process.env.KORE_API_KEY;

  const app = new Elysia()
    .use(cors())
    .use(bearer())
    .onBeforeHandle(({ bearer: token, path, set }) => {
      // Skip auth for health endpoint
      if (path === "/api/v1/health") return;

      if (apiKey && token !== apiKey) {
        set.status = 401;
        return { error: "Missing or invalid Bearer token", code: "UNAUTHORIZED" };
      }
    })
    // ─── Health ───────────────────────────────────────────────────
    .get("/api/v1/health", async () => {
      return await healthOp({
        memoryIndex,
        queue,
        qmdStatus,
        dataPath,
      });
    })
    // ─── Task Status ──────────────────────────────────────────────
    .get("/api/v1/task/:id", ({ params, set }) => {
      const task = queue.getTask(params.id);
      if (!task) {
        set.status = 404;
        return { error: "Task not found", code: "NOT_FOUND" };
      }
      return {
        id: task.id,
        status: task.status,
        created_at: task.created_at,
        updated_at: task.updated_at,
        error_log: task.error_log,
      };
    })
    // ─── Ingest Structured ────────────────────────────────────────
    .post("/api/v1/ingest/structured", async ({ body, set }) => {
      const result = StructuredIngestPayload.safeParse(body);
      if (!result.success) {
        set.status = 400;
        return {
          error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          code: "VALIDATION_ERROR",
        };
      }

      const { title, markdown_body, frontmatter } = result.data.content;
      const id = randomUUID();

      const fullFrontmatter: BaseFrontmatter = { id, ...frontmatter };

      const filePath = await resolveFilePath(dataPath, frontmatter.type, title);

      const md = renderMarkdown({
        frontmatter: fullFrontmatter,
        title,
        distilledItems: undefined,
        rawSource: markdown_body,
      });

      await Bun.write(filePath, md);

      set.status = 200;
      return {
        status: "indexed",
        file_path: filePath,
      };
    }, { body: t.Any() })
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
      if (deps.consolidationTracker) {
        deps.consolidationTracker.truncateAll();
      }

      // Clear task queue and plugin registry
      const deletedTasks = queue.clearAll();
      if (deps.pluginRegistry) {
        deps.pluginRegistry.clearAll();
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
        consolidationTracker: deps.consolidationTracker,
      });
      if (!result.deleted) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }
      return { status: "deleted", id: params.id, restored_sources: result.restoredSources };
    })
    // ─── Consolidate (shared operation) ──────────────────────────
    .post("/api/v1/consolidate", async ({ body, query, set }) => {
      // Support reset_failed as query param (backward compat) or body param
      const resetFailed = query.reset_failed === "true" || (body as any)?.reset_failed === true;
      if (resetFailed) {
        const tracker = deps.consolidationTracker;
        if (tracker) tracker.resetFailed();
      }

      const params = (body ?? {}) as ConsolidateInput;
      // Also accept dry_run from query param for backward compat
      if (query.dry_run === "true") params.dry_run = true;

      try {
        return await consolidateOp(params, {
          dataPath,
          qmdSearch: searchFn!,
          consolidationTracker: deps.consolidationTracker,
          memoryIndex,
          eventDispatcher,
          consolidationLoopHandle: deps.consolidationLoopHandle,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = message.includes("not available") ? 503 : 500;
        return { error: message };
      }
    }, { body: t.Any() })
    // ─── Recall (shared operation) ─────────────────────────────────
    .post("/api/v1/recall", async ({ body, set }) => {
      if (!searchFn) {
        set.status = 503;
        return { error: "Search index not available" };
      }
      const params = (body ?? {}) as RecallInput;
      try {
        return await recall(params, {
          memoryIndex,
          qmdSearch: searchFn,
          dataPath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { error: message };
      }
    }, { body: t.Any() })
    // ─── Remember (shared operation) ──────────────────────────────
    .post("/api/v1/remember", async ({ body, set }) => {
      const params = body as { content?: string; source?: string; url?: string; priority?: string; suggested_tags?: string[]; suggested_category?: string };
      if (!params?.content) {
        set.status = 400;
        return { error: "content is required", code: "VALIDATION_ERROR" };
      }
      try {
        const result = await remember({
          content: params.content,
          source: params.source,
          url: params.url,
          priority: (params.priority as "low" | "normal" | "high") ?? "normal",
          suggested_tags: params.suggested_tags,
          suggested_category: params.suggested_category,
        }, { queue });
        set.status = 202;
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { error: message };
      }
    }, { body: t.Any() })
    // ─── Inspect (shared operation) ──────────────────────────────
    .get("/api/v1/inspect/:id", async ({ params, set }) => {
      try {
        const result = await inspectOp(params.id, { memoryIndex });
        if (!result) {
          set.status = 404;
          return { error: "Memory not found", code: "NOT_FOUND" };
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { error: message };
      }
    })
    // ─── Insights (shared operation) ─────────────────────────────
    .get("/api/v1/insights", async ({ query, set }) => {
      if (!searchFn) {
        set.status = 503;
        return { error: "Search index not available" };
      }
      const params: InsightsInput = {};
      if (query.query) params.query = query.query as string;
      if (query.type) params.insight_type = query.type as string;
      if (query.status) params.status = query.status as string;
      if (query.limit) params.limit = Number(query.limit);
      try {
        return await insightsOp(params, {
          dataPath,
          qmdSearch: searchFn,
          memoryIndex,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { error: message };
      }
    })
    // ─── Reset Consolidation ─────────────────────────────────────
    .delete("/api/v1/consolidation", async ({ set }) => {
      const tracker = deps.consolidationTracker;
      const loopHandle = deps.consolidationLoopHandle;
      const qmdUpdateFn = deps.qmdUpdateFn;

      if (!tracker || !dataPath) {
        set.status = 503;
        return { error: "Consolidation service not available" };
      }

      try {
        if (loopHandle) await loopHandle.pause();

        const result = await resetConsolidation({
          dataPath,
          tracker,
          memoryIndex,
          qmdUpdate: qmdUpdateFn ?? (async () => {}),
        });

        return {
          status: "reset",
          deleted_insights: result.deletedInsights,
          restored_memories: result.restoredMemories,
          tracker_backfilled: result.trackerBackfilled,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[consolidation-reset] Reset failed:", message);
        set.status = 500;
        return { error: message, code: "RESET_FAILED" };
      } finally {
        if (loopHandle) loopHandle.resume();
      }
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

  return app;
}

import { Elysia, t } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { cors } from "@elysiajs/cors";
import { z } from "zod";
import { randomUUID } from "crypto";
import { BaseFrontmatterSchema, MemoryTypeEnum } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";
import { QueueRepository } from "./queue";
import { slugify } from "./slugify";
import { renderMarkdown } from "./markdown";
import { mkdir, unlink, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataPath, resolveQmdDbPath } from "./config";
import * as qmdClient from "@kore/qmd-client";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { deleteMemoryById } from "./delete-memory";
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { ConsolidationDeps, ConsolidationHandle } from "./consolidation-loop";
import { runConsolidationCycle, runConsolidationDryRun, buildConsolidationDeps } from "./consolidation-loop";
import { resetConsolidation } from "./consolidation-reset";
import type { PluginRegistryRepository } from "./plugin-registry";

// ─── Zod Schemas for request validation ─────────────────────────────

const RawIngestPayload = z.object({
  source: z.string(),
  content: z.string(),
  original_url: z.string().url().optional(),
  date_created: z.string().datetime().optional(),
  date_modified: z.string().datetime().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

const StructuredIngestPayload = z.object({
  content: z.object({
    title: z.string(),
    markdown_body: z.string(),
    frontmatter: BaseFrontmatterSchema.omit({ id: true }),
  }),
});

const SearchRequestPayload = z.object({
  query: z.string().min(1, "query is required"),
  intent: z.string().optional(),
  limit: z.number().int().positive().optional(),
  minScore: z.number().min(0).max(1).optional(),
  collection: z.string().optional(),
});

const DEFAULT_SEARCH_INTENT =
  "personal knowledge base containing notes, contacts, and bookmarks";

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

function parseTagsArray(raw: string): string[] {
  // Tags are stored as: ["tag1", "tag2"]
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch {
    return raw ? [raw] : [];
  }
}

function extractTitleFromMarkdown(content: string): string {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : "";
}

async function parseMemoryFile(id: string, filePath: string): Promise<MemorySummary | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    const summary: MemorySummary = {
      id: fm.id,
      type: fm.type || "",
      title: extractTitleFromMarkdown(content),
      source: fm.source || "",
      date_saved: fm.date_saved || "",
      ...(fm.date_created ? { date_created: fm.date_created } : {}),
      ...(fm.date_modified ? { date_modified: fm.date_modified } : {}),
      tags: parseTagsArray(fm.tags || ""),
      ...(fm.intent ? { intent: fm.intent } : {}),
      ...(fm.confidence !== undefined ? { confidence: parseFloat(fm.confidence) } : {}),
    };
    // Add insight-specific fields
    if (fm.type === "insight") {
      if (fm.insight_type) summary.insight_type = fm.insight_type;
      if (fm.status) summary.status = fm.status;
      const sourceIds = parseTagsArray(fm.source_ids || "");
      summary.source_ids_count = sourceIds.length;
    }
    return summary;
  } catch {
    return null;
  }
}

async function parseMemoryFileFull(id: string, filePath: string): Promise<MemoryFull | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    const full: MemoryFull = {
      id: fm.id,
      type: fm.type || "",
      category: fm.category || "",
      date_saved: fm.date_saved || "",
      ...(fm.date_created ? { date_created: fm.date_created } : {}),
      ...(fm.date_modified ? { date_modified: fm.date_modified } : {}),
      source: fm.source || "",
      tags: parseTagsArray(fm.tags || ""),
      url: fm.url,
      ...(fm.intent ? { intent: fm.intent } : {}),
      ...(fm.confidence !== undefined ? { confidence: parseFloat(fm.confidence) } : {}),
      title: extractTitleFromMarkdown(content),
      content,
    };
    // Add insight-specific fields
    if (fm.type === "insight") {
      if (fm.insight_type) full.insight_type = fm.insight_type;
      if (fm.status) full.status = fm.status;
      full.source_ids = parseTagsArray(fm.source_ids || "");
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

interface MemorySummary {
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
  // Insight-specific fields
  insight_type?: string;
  status?: string;
  source_ids_count?: number;
}

interface MemoryFull extends MemorySummary {
  category: string;
  url?: string;
  content: string;
  // Insight-specific fields
  insight_type?: string;
  status?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  reinforcement_count?: number;
  last_synthesized_at?: string;
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
      const qmd = await qmdStatus();
      return {
        status: "ok",
        version: "1.0.0",
        qmd,
        queue_length: queue.getQueueLength(),
      };
    })
    // ─── Search ───────────────────────────────────────────────────
    .post("/api/v1/search", async ({ body, set }) => {
      const result = SearchRequestPayload.safeParse(body);
      if (!result.success) {
        set.status = 400;
        return {
          error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          code: "VALIDATION_ERROR",
        };
      }

      if (!searchFn) {
        set.status = 503;
        return { error: "Search index not available" };
      }

      const { query, intent, limit, collection, minScore } = result.data;
      const cappedLimit = Math.min(limit ?? 10, 20);

      try {
        const results = await searchFn(query, {
          intent: intent ?? DEFAULT_SEARCH_INTENT,
          limit: cappedLimit,
          collection,
          minScore,
        });

        // Post-filter: exclude retired insights (§4.5)
        const filtered: typeof results = [];
        for (const r of results) {
          if (r.file && r.file.includes("/insights/")) {
            try {
              const fileContent = await readFile(r.file, "utf-8");
              const fm = parseFrontmatter(fileContent);
              if (fm.status === "retired") continue;
            } catch {
              // file unreadable, include it
            }
          }
          filtered.push(r);
        }

        return filtered.map((r) => {
          // Extract collection name from displayPath (qmd://collection-name/...)
          const dpMatch = r.displayPath?.match(/^qmd:\/\/([^/]+)/);
          return {
            id: memoryIndex.getIdByPath(r.file) ?? null,
            path: r.file,
            title: r.title,
            snippet: r.bestChunk,
            score: r.score,
            collection: dpMatch?.[1] ?? null,
          };
        });
      } catch (err) {
        console.error("Search error:", err instanceof Error ? err.message : err);
        set.status = 503;
        return { error: "Search index not available" };
      }
    }, { body: t.Any() })
    // ─── Ingest Raw ───────────────────────────────────────────────
    .post("/api/v1/ingest/raw", async ({ body, set }) => {
      const result = RawIngestPayload.safeParse(body);
      if (!result.success) {
        set.status = 400;
        return {
          error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          code: "VALIDATION_ERROR",
        };
      }

      const { source, content, original_url, date_created, date_modified, priority } = result.data;
      const taskId = queue.enqueue({ source, content, original_url, date_created, date_modified }, priority);

      set.status = 202;
      return {
        status: "queued",
        task_id: taskId,
        message: "Enrichment added to queue.",
      };
    }, { body: t.Any() })
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
    // ─── List Memories ────────────────────────────────────────────
    .get("/api/v1/memories", async ({ query }) => {
      const typeFilter = query.type as string | undefined;
      const limit = Math.min(Number(query.limit) || 20, 100);

      const results: MemorySummary[] = [];
      for (const [id, filePath] of memoryIndex.entries()) {
        const memory = await parseMemoryFile(id, filePath);
        if (!memory) continue;
        if (typeFilter && memory.type !== typeFilter) continue;
        results.push(memory);
        if (results.length >= limit) break;
      }

      return results;
    })
    // ─── Get Memory ───────────────────────────────────────────────
    .get("/api/v1/memory/:id", async ({ params, set }) => {
      const filePath = memoryIndex.get(params.id);
      if (!filePath) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }

      const memory = await parseMemoryFileFull(params.id, filePath);
      if (!memory) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }

      return memory;
    })
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
      const deleted = await deleteMemoryById(params.id, { memoryIndex, eventDispatcher });
      if (!deleted) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }
      return { status: "deleted", id: params.id };
    })
    // ─── Consolidate ──────────────────────────────────────────────
    .post("/api/v1/consolidate", async ({ query, set }) => {
      const tracker = deps.consolidationTracker;
      if (!tracker || !searchFn) {
        set.status = 503;
        return { error: "Consolidation service not available" };
      }

      const resetFailed = query.reset_failed === "true";
      const dryRun = query.dry_run === "true";

      if (resetFailed) {
        tracker.resetFailed();
      }

      const consolidationDeps = buildConsolidationDeps({
        dataPath,
        qmdSearch: searchFn,
        tracker,
        memoryIndex,
        eventDispatcher,
      });

      if (dryRun) {
        const result = await runConsolidationDryRun(consolidationDeps);
        return result;
      }

      const result = await runConsolidationCycle(consolidationDeps);
      return result;
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

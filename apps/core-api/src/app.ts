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
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";

// ─── Zod Schemas for request validation ─────────────────────────────

const RawIngestPayload = z.object({
  source: z.string(),
  content: z.string(),
  original_url: z.string().url().optional(),
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
    return {
      id: fm.id,
      type: fm.type || "",
      title: extractTitleFromMarkdown(content),
      source: fm.source || "",
      date_saved: fm.date_saved || "",
      tags: parseTagsArray(fm.tags || ""),
    };
  } catch {
    return null;
  }
}

async function parseMemoryFileFull(id: string, filePath: string): Promise<MemoryFull | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.id) return null;
    return {
      id: fm.id,
      type: fm.type || "",
      category: fm.category || "",
      date_saved: fm.date_saved || "",
      source: fm.source || "",
      tags: parseTagsArray(fm.tags || ""),
      url: fm.url,
      title: extractTitleFromMarkdown(content),
      content,
    };
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
  tags: string[];
}

interface MemoryFull extends MemorySummary {
  category: string;
  url?: string;
  content: string;
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

        return results.map((r) => {
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

      const { source, content, original_url, priority } = result.data;
      const taskId = queue.enqueue({ source, content, original_url }, priority);

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

      // Clear task queue
      const deletedTasks = queue.clearAll();

      // Reset QMD index
      const qmdDbPath = resolveQmdDbPath();
      try {
        await qmdClient.closeStore();
        await rm(qmdDbPath, { force: true });
        await rm(`${qmdDbPath}-wal`, { force: true });
        await rm(`${qmdDbPath}-shm`, { force: true });
        await qmdClient.initStore(qmdDbPath);
      } catch (err) {
        console.warn("Warning: QMD store reset encountered an error:", err);
      }

      return {
        status: "reset",
        deleted_memories: deletedMemories,
        deleted_tasks: deletedTasks,
      };
    })
    // ─── Delete Memory ────────────────────────────────────────────
    .delete("/api/v1/memory/:id", async ({ params, set }) => {
      const filePath = memoryIndex.get(params.id);
      if (!filePath) {
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }

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
        set.status = 404;
        return { error: "Memory not found", code: "NOT_FOUND" };
      }

      memoryIndex.delete(params.id);

      await eventDispatcher.emit("memory.deleted", {
        id: params.id,
        filePath,
        frontmatter,
        timestamp: new Date().toISOString(),
      });

      return { status: "deleted", id: params.id };
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

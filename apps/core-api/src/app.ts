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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataPath } from "./config";

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

// ─── App Factory ─────────────────────────────────────────────────────

export interface AppDeps {
  queue?: QueueRepository;
  qmdStatus?: () => string;
  dataPath?: string;
}

export function createApp(deps: AppDeps = {}) {
  const dataPath = deps.dataPath || resolveDataPath();
  const queue = deps.queue || new QueueRepository();
  const qmdStatus = deps.qmdStatus || (() => "unavailable");
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
    .get("/api/v1/health", () => ({
      status: "ok",
      version: "1.0.0",
      qmd_status: qmdStatus(),
      queue_length: queue.getQueueLength(),
    }))
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
    }, { body: t.Any() });

  return app;
}

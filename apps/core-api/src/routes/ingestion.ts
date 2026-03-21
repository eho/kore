import { Elysia, t } from "elysia";
import { z } from "zod";
import { randomUUID } from "crypto";
import { BaseFrontmatterSchema } from "@kore/shared-types";
import type { BaseFrontmatter } from "@kore/shared-types";
import { renderMarkdown } from "../markdown";
import { resolveFilePath } from "../lib/file-utils";
import type { QueueRepository } from "../queue";

const StructuredIngestPayload = z.object({
  content: z.object({
    title: z.string(),
    markdown_body: z.string(),
    frontmatter: BaseFrontmatterSchema.omit({ id: true }),
  }),
});

export { StructuredIngestPayload };

interface IngestionDeps {
  queue: QueueRepository;
  dataPath: string;
}

export function createIngestionRoutes(deps: IngestionDeps) {
  const { queue, dataPath } = deps;

  return new Elysia()
    // ─── Task Status ─────────────────────────────────────────────
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
    // ─── Ingest Structured ───────────────────────────────────────
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
}

import { Elysia, t } from "elysia";
import { recall, remember, inspect as inspectOp, insights as insightsOp } from "../operations";
import type { RecallInput, InsightsInput } from "../operations";
import type { MemoryIndex } from "../memory-index";
import type { QueueRepository } from "../queue";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";

interface OperationsDeps {
  memoryIndex: MemoryIndex;
  queue: QueueRepository;
  dataPath: string;
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
}

export function createOperationsRoutes(deps: OperationsDeps) {
  const { memoryIndex, queue, dataPath, searchFn } = deps;

  return new Elysia()
    // ─── Recall ──────────────────────────────────────────────────
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
    // ─── Remember ────────────────────────────────────────────────
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
    // ─── Inspect ─────────────────────────────────────────────────
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
    // ─── Insights ────────────────────────────────────────────────
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
    });
}

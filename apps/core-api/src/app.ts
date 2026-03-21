import { Elysia } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { cors } from "@elysiajs/cors";
import { QueueRepository } from "./queue";
import { resolveDataPath } from "./config";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import type { ConsolidationTracker } from "./consolidation-tracker";
import type { ConsolidationHandle } from "./consolidation-loop";
import type { PluginRegistryRepository } from "./plugin-registry";
import { ensureDataDirectories } from "./lib/file-utils";
import { createSystemRoutes } from "./routes/system";
import { createIngestionRoutes } from "./routes/ingestion";
import { createMemoryRoutes } from "./routes/memory";
import { createConsolidationRoutes } from "./routes/consolidation";
import { createOperationsRoutes } from "./routes/operations";

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

export { ensureDataDirectories };

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
    .use(createSystemRoutes({ memoryIndex, queue, qmdStatus, dataPath }))
    .use(createIngestionRoutes({ queue, dataPath }))
    .use(createMemoryRoutes({
      memoryIndex,
      eventDispatcher,
      queue,
      dataPath,
      consolidationTracker: deps.consolidationTracker,
      pluginRegistry: deps.pluginRegistry,
    }))
    .use(createConsolidationRoutes({
      dataPath,
      searchFn,
      consolidationTracker: deps.consolidationTracker,
      memoryIndex,
      eventDispatcher,
      consolidationLoopHandle: deps.consolidationLoopHandle,
      qmdUpdateFn: deps.qmdUpdateFn,
    }))
    .use(createOperationsRoutes({ memoryIndex, queue, dataPath, searchFn }));

  return app;
}

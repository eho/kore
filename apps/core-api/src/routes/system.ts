import { Elysia } from "elysia";
import { health as healthOp } from "../operations";
import type { QueueRepository } from "../queue";
import type { MemoryIndex } from "../memory-index";
import type { QmdHealthSummary } from "../app";

interface SystemDeps {
  memoryIndex: MemoryIndex;
  queue: QueueRepository;
  qmdStatus: () => Promise<QmdHealthSummary>;
  dataPath: string;
}

export function createSystemRoutes(deps: SystemDeps) {
  const { memoryIndex, queue, qmdStatus, dataPath } = deps;

  return new Elysia()
    .get("/api/v1/health", async () => {
      return await healthOp({ memoryIndex, queue, qmdStatus, dataPath });
    });
}

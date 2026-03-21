import { readFile } from "node:fs/promises";
import type { OperationDeps, HealthOutput } from "./types";
import { parseFrontmatter } from "./inspect";

const VERSION = "1.0.0";

export async function health(
  deps: Pick<OperationDeps, "memoryIndex" | "queue" | "qmdStatus" | "dataPath">
): Promise<HealthOutput> {
  // Count memories by type
  const byType: Record<string, number> = {};
  let total = 0;
  for (const [, filePath] of deps.memoryIndex.entries()) {
    total++;
    try {
      const content = await readFile(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      const type = String(fm.type || "unknown");
      byType[type] = (byType[type] || 0) + 1;
    } catch {
      byType["unknown"] = (byType["unknown"] || 0) + 1;
    }
  }

  // Queue counts
  const queueCounts = deps.queue.getStatusCounts();

  // Index state
  const qmd = await deps.qmdStatus();
  let indexStatus: string;
  if (qmd.status === "unavailable") {
    indexStatus = "unavailable";
  } else if (qmd.needs_embedding && qmd.needs_embedding > 0) {
    indexStatus = "embedding";
  } else {
    indexStatus = "ok";
  }

  const result: HealthOutput = {
    version: VERSION,
    memories: { total, by_type: byType },
    queue: {
      pending: queueCounts.queued,
      processing: queueCounts.processing,
      failed: queueCounts.failed,
    },
    index: {
      documents: qmd.doc_count ?? 0,
      embedded: (qmd.doc_count ?? 0) - (qmd.needs_embedding ?? 0),
      status: indexStatus,
    },
  };

  // Sync state (Apple Notes) — only present if plugin is enabled
  // This is populated by the caller if available, via the plugin's status endpoint
  // For now, we check if the env var is set
  if (process.env.KORE_APPLE_NOTES_ENABLED === "true") {
    result.sync = {
      apple_notes: {
        enabled: true,
        total_tracked: 0, // populated by caller with actual plugin data
      },
    };
  }

  return result;
}

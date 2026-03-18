import type { ConsolidationTracker } from "./consolidation-tracker";
import type { MemoryIndex } from "./memory-index";
import type { MemoryEvent } from "@kore/shared-types";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";

// ─── Types ───────────────────────────────────────────────────────────

type QmdSearchFn = (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;

export interface ConsolidationEventHandlers {
  onMemoryIndexed: (event: MemoryEvent) => Promise<void>;
  onMemoryDeleted: (event: MemoryEvent) => Promise<void>;
  onMemoryUpdated: (event: MemoryEvent) => Promise<void>;
}

export interface EventHandlerOptions {
  relevanceThreshold?: number;
  cooldownDays?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file content string.
 */
function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else if (value === "null") {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Serialize frontmatter back to YAML string.
 */
function serializeFrontmatter(fm: Record<string, any>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ─── Event Handlers ──────────────────────────────────────────────────

/**
 * Create consolidation event handlers that match KorePlugin hook signatures.
 *
 * These handlers:
 * 1. Track new memories for future consolidation
 * 2. Reactively flag insights for re-synthesis when related memories appear
 * 3. Update insight status when source memories are deleted
 */
export function createConsolidationEventHandlers(
  tracker: ConsolidationTracker,
  qmdSearch: QmdSearchFn,
  memoryIndex: MemoryIndex,
  options: EventHandlerOptions = {},
): ConsolidationEventHandlers {
  const relevanceThreshold = options.relevanceThreshold ?? 0.5;
  const cooldownDays = options.cooldownDays ?? 7;

  return {
    /**
     * Handle memory.indexed events:
     * 1. Upsert into tracker as pending
     * 2. Skip reactive check if source=kore_synthesis
     * 3. Search for related insights and flag as evolving
     */
    async onMemoryIndexed(event: MemoryEvent): Promise<void> {
      const memType = event.frontmatter.type ?? "note";

      // 1. Upsert new memory into tracker
      tracker.upsertMemory(event.id, memType);

      // 2. Skip reactive re-synthesis check for insights (self-triggering)
      if (event.frontmatter.source === "kore_synthesis") {
        return;
      }

      // 3. Reactive re-synthesis: search QMD for related existing insights
      try {
        const title = event.frontmatter.title ?? "";
        const distilledItems: string[] = [];

        // Try to extract distilled items from the file
        try {
          const content = await Bun.file(event.filePath).text();
          const bodyMatch = content.match(/## Distilled Memory Items\n([\s\S]*?)(?:\n##|\n$|$)/);
          if (bodyMatch) {
            for (const line of bodyMatch[1].split("\n")) {
              const itemMatch = line.match(/^- \*\*(.+)\*\*$/);
              if (itemMatch) distilledItems.push(itemMatch[1]);
            }
          }
        } catch {
          // file read failed, proceed with title-only search
        }

        const queryParts = [title, ...distilledItems.slice(0, 3)].filter(Boolean);
        if (queryParts.length === 0) return;
        const query = queryParts.join(". ");

        const results = await qmdSearch(query, {
          limit: 10,
          collection: "memories",
          intent: "Find existing insights related to this new memory",
          minScore: relevanceThreshold,
        });

        for (const r of results) {
          // Only consider insight files
          if (!r.file.includes("/insights/")) continue;

          const insightId = memoryIndex.getIdByPath(r.file);
          if (!insightId) continue;

          // Read insight to check source_ids
          try {
            const insightContent = await Bun.file(r.file).text();
            const insightFm = parseFrontmatter(insightContent);
            const sourceIds: string[] = Array.isArray(insightFm.source_ids)
              ? insightFm.source_ids
              : [];

            // Skip if new memory is already in source_ids
            if (sourceIds.includes(event.id)) continue;

            // Check tracker status — skip if already evolving
            const status = tracker.getStatus(insightId);
            if (status?.status === "evolving") continue;

            // Throttle: skip if insight was flagged recently (within cooldownDays)
            if (status?.consolidated_at) {
              const consolidatedAt = new Date(status.consolidated_at);
              const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
              if (Date.now() - consolidatedAt.getTime() < cooldownMs) continue;
            }

            // Flag for re-evaluation
            tracker.markEvolving(insightId, "new_evidence");
            console.log(
              `[consolidation] Flagged insight ${insightId} for re-eval: new evidence from ${event.id}`,
            );
          } catch {
            // insight file read failed, skip
            continue;
          }
        }
      } catch (err) {
        console.error("[consolidation] Reactive re-synthesis check failed:", err);
      }
    },

    /**
     * Handle memory.deleted events:
     * - If insight deleted: retire in tracker
     * - If regular memory deleted: compute source integrity for referenced insights
     */
    async onMemoryDeleted(event: MemoryEvent): Promise<void> {
      // Check if deleted file is an insight
      if (event.frontmatter.type === "insight" || event.filePath.includes("/insights/")) {
        tracker.markRetired(event.id);
        console.log(`[consolidation] Insight ${event.id} deleted, marked retired in tracker`);
        return;
      }

      // Regular memory deleted — check insight_refs
      let insightRefs: string[] = [];

      // The frontmatter from delete-memory.ts uses a simple parser that doesn't parse arrays.
      // insight_refs might be a raw string like '["ins-abc", "ins-def"]'
      const rawRefs = event.frontmatter.insight_refs;
      if (Array.isArray(rawRefs)) {
        insightRefs = rawRefs;
      } else if (typeof rawRefs === "string" && rawRefs.startsWith("[")) {
        // Parse array from string
        try {
          const inner = rawRefs.slice(1, -1).trim();
          if (inner) {
            insightRefs = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
          }
        } catch {
          // failed to parse, skip
        }
      }

      if (insightRefs.length === 0) return;

      for (const insightId of insightRefs) {
        const insightPath = memoryIndex.get(insightId);
        if (!insightPath) continue;

        try {
          const content = await Bun.file(insightPath).text();
          const insightFm = parseFrontmatter(content);
          const sourceIds: string[] = Array.isArray(insightFm.source_ids)
            ? insightFm.source_ids
            : [];

          // Count remaining sources that still exist
          let remainingCount = 0;
          for (const srcId of sourceIds) {
            if (srcId === event.id) continue; // the deleted one
            if (memoryIndex.get(srcId)) remainingCount++;
          }

          const ratio = sourceIds.length > 0 ? remainingCount / sourceIds.length : 0;

          // Apply integrity rules (design doc §10.4)
          if (ratio === 0) {
            // No sources remain — terminal
            tracker.markRetired(insightId);
            await updateInsightStatus(insightPath, content, "retired");
            console.log(`[consolidation] Insight ${insightId}: all sources deleted → retired`);
          } else if (ratio < 0.5) {
            tracker.markDegraded(insightId);
            await updateInsightStatus(insightPath, content, "degraded");
            console.log(
              `[consolidation] Insight ${insightId}: ${remainingCount}/${sourceIds.length} sources remain (${(ratio * 100).toFixed(0)}%) → degraded`,
            );
          } else {
            tracker.markEvolving(insightId, "source_deleted");
            await updateInsightStatus(insightPath, content, "evolving");
            console.log(
              `[consolidation] Insight ${insightId}: ${remainingCount}/${sourceIds.length} sources remain (${(ratio * 100).toFixed(0)}%) → evolving`,
            );
          }
        } catch (err) {
          console.error(`[consolidation] Failed to process insight ${insightId} after source deletion:`, err);
        }
      }
    },

    /**
     * Handle memory.updated events: treat as delete + index in sequence.
     */
    async onMemoryUpdated(event: MemoryEvent): Promise<void> {
      await this.onMemoryDeleted(event);
      await this.onMemoryIndexed(event);
    },
  };
}

/**
 * Update the status field in an insight file's frontmatter.
 */
async function updateInsightStatus(
  filePath: string,
  content: string,
  status: string,
): Promise<void> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  const fmContent = fmMatch[1];
  const body = content.slice(fmMatch[0].length);
  const fm = parseFrontmatter(content);
  fm.status = status;

  const updated = serializeFrontmatter(fm) + body;
  await Bun.write(filePath, updated);
}

import { readFile } from "node:fs/promises";
import type { OperationDeps, RecallInput, RecallOutput, RecallResultItem } from "./types";
import { parseMemoryFileFull, extractDistilledItems, resolveQmdPath } from "./inspect";
import type { MemoryFileFull } from "./inspect";

const BATCH_SIZE = 50;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface EnrichedMemory extends MemoryFileFull {
  score: number;
  distilled_items: string[];
}

/**
 * Shared filter logic used by both query and no-query paths.
 * Excludes retired insights by default.
 */
export function applyKoreFilters(memories: EnrichedMemory[], params: RecallInput): EnrichedMemory[] {
  let filtered = memories.filter(m => !(m.type === "insight" && m.status === "retired"));
  if (params.type) filtered = filtered.filter(m => m.type === params.type);
  if (params.intent) filtered = filtered.filter(m => m.intent === params.intent);
  if (params.tags?.length) filtered = filtered.filter(m => params.tags!.every(t => m.tags.includes(t)));
  if (params.min_confidence) filtered = filtered.filter(m => (m.confidence ?? 0) >= params.min_confidence!);
  if (params.min_score) filtered = filtered.filter(m => m.score >= params.min_score!);
  if (params.created_after) filtered = filtered.filter(m => m.date_saved >= params.created_after!);
  if (params.created_before) filtered = filtered.filter(m => m.date_saved <= params.created_before!);
  if (params.include_insights === false) filtered = filtered.filter(m => m.type !== "insight");
  return filtered;
}

function toResultItem(m: EnrichedMemory): RecallResultItem {
  const item: RecallResultItem = {
    id: m.id,
    title: m.title,
    type: m.type,
    category: m.category,
    tags: m.tags,
    date_saved: m.date_saved,
    source: m.source,
    distilled_items: m.distilled_items,
    score: m.score,
  };
  if (m.intent) item.intent = m.intent;
  if (m.confidence !== undefined) item.confidence = m.confidence;
  // Insight-specific fields
  if (m.type === "insight") {
    if (m.insight_type) item.insight_type = m.insight_type;
    if (m.source_ids) item.source_count = m.source_ids.length;
    if (m.status) item.status = m.status;
  }
  return item;
}

export async function recall(
  params: RecallInput,
  deps: Pick<OperationDeps, "memoryIndex" | "qmdSearch" | "dataPath">
): Promise<RecallOutput> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = params.offset ?? 0;

  // No-query path: scan memory index directly, sort by date_saved descending
  if (!params.query) {
    const all: EnrichedMemory[] = [];
    const entries = [...deps.memoryIndex.entries()];

    const parsed = await Promise.all(
      entries.map(async ([id, filePath]) => {
        const memory = await parseMemoryFileFull(id, filePath);
        if (!memory) return null;
        let fileContent: string;
        try {
          fileContent = await readFile(filePath, "utf-8");
        } catch {
          fileContent = memory.content;
        }
        return {
          ...memory,
          score: 1.0,
          distilled_items: extractDistilledItems(fileContent),
        } as EnrichedMemory;
      })
    );

    for (const m of parsed) {
      if (m) all.push(m);
    }

    const filtered = applyKoreFilters(all, params);
    filtered.sort((a, b) => b.date_saved.localeCompare(a.date_saved));

    const results = filtered.slice(offset, offset + limit).map(toResultItem);
    return {
      results,
      query: "",
      total: results.length,
      offset,
      has_more: filtered.length > offset + limit,
    };
  }

  // Query path: iterative batch loop through QMD
  const filtered: EnrichedMemory[] = [];
  let currentLimit = BATCH_SIZE;
  let lastFetchedCount = 0;
  let qmdExhausted = false;

  while (filtered.length < offset + limit && !qmdExhausted) {
    const qmdResults = await deps.qmdSearch(params.query, {
      intent: "personal knowledge retrieval",
      limit: currentLimit,
    });

    const newResults = qmdResults.slice(lastFetchedCount);
    if (newResults.length === 0) {
      qmdExhausted = true;
      break;
    }
    
    lastFetchedCount = qmdResults.length;
    currentLimit += BATCH_SIZE;

    // Enrich batch with Kore metadata
    const enriched = await Promise.all(
      newResults.map(async (r) => {
        const resolvedPath = resolveQmdPath(r.file, deps.dataPath);
        const id = deps.memoryIndex.getIdByPath(resolvedPath);
        if (!id) return null;
        const memory = await parseMemoryFileFull(id, resolvedPath);
        if (!memory) return null;
        let fileContent: string;
        try {
          fileContent = await readFile(resolvedPath, "utf-8");
        } catch {
          fileContent = memory.content;
        }
        return {
          ...memory,
          score: r.score,
          distilled_items: extractDistilledItems(fileContent),
        } as EnrichedMemory;
      })
    );

    // Apply filters to this batch and accumulate
    const batchFiltered = applyKoreFilters(
      enriched.filter((m): m is EnrichedMemory => m !== null),
      params
    );
    filtered.push(...batchFiltered);
  }

  // Apply pagination over accumulated filtered results
  const results = filtered.slice(offset, offset + limit).map(toResultItem);
  return {
    results,
    query: params.query,
    total: results.length,
    offset,
    has_more: !qmdExhausted || filtered.length > offset + limit,
  };
}

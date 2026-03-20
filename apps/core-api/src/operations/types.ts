import type { MemoryIndex } from "../memory-index";
import type { QueueRepository } from "../queue";
import type { ConsolidationTracker } from "../consolidation-tracker";
import type { EventDispatcher } from "../event-dispatcher";
import type { QmdHealthSummary } from "../app";
import type { SearchOptions, HybridQueryResult } from "@kore/qmd-client";
import type { ConsolidationHandle } from "../consolidation-loop";

// ─── Shared Dependencies ──────────────────────────────────────────

export interface OperationDeps {
  dataPath: string;
  memoryIndex: MemoryIndex;
  queue: QueueRepository;
  qmdSearch: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
  qmdStatus: () => Promise<QmdHealthSummary>;
  consolidationTracker?: ConsolidationTracker;
  eventDispatcher?: EventDispatcher;
  consolidationLoopHandle?: ConsolidationHandle;
  pluginRegistry?: { listExternalKeys: () => Array<{ memory_id: string }> };
}

// ─── Recall ───────────────────────────────────────────────────────

export interface RecallInput {
  query?: string;
  type?: string;
  intent?: string;
  tags?: string[];
  created_after?: string;
  created_before?: string;
  limit?: number;
  offset?: number;
  min_score?: number;
  min_confidence?: number;
  include_insights?: boolean;
}

export interface RecallResultItem {
  id: string;
  title: string;
  type: string;
  category: string;
  intent?: string;
  confidence?: number;
  tags: string[];
  date_saved: string;
  source: string;
  distilled_items: string[];
  score: number;
  // Insight-specific fields
  insight_type?: string;
  source_count?: number;
  status?: string;
}

export interface RecallOutput {
  results: RecallResultItem[];
  query: string;
  total: number;
  offset: number;
  has_more: boolean;
}

// ─── Remember ─────────────────────────────────────────────────────

export interface RememberInput {
  content: string;
  source?: string;
  url?: string;
  priority?: "low" | "normal" | "high";
  suggested_tags?: string[];
  suggested_category?: string;
}

export interface RememberOutput {
  task_id: string;
  status: "queued";
  message: string;
}

// ─── Inspect ──────────────────────────────────────────────────────

export interface InspectOutput {
  id: string;
  title: string;
  type: string;
  category: string;
  intent?: string;
  confidence?: number;
  tags: string[];
  date_saved: string;
  date_created?: string;
  date_modified?: string;
  source: string;
  url?: string;
  distilled_items: string[];
  content: string;
  // Consolidation metadata
  consolidated_at?: string;
  insight_refs?: string[];
  // Insight-specific fields
  insight_type?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  status?: string;
  reinforcement_count?: number;
}

// ─── Insights ─────────────────────────────────────────────────────

export interface InsightsInput {
  query?: string;
  insight_type?: string;
  status?: string;
  limit?: number;
}

export interface InsightResultItem {
  id: string;
  title: string;
  insight_type: string;
  confidence: number;
  status: string;
  source_ids: string[];
  source_count: number;
  synthesis: string;
  distilled_items: string[];
  tags: string[];
  date_saved: string;
  last_synthesized_at?: string;
  reinforcement_count: number;
  supersedes?: string[];
}

export interface InsightsOutput {
  results: InsightResultItem[];
  total: number;
}

// ─── Health ───────────────────────────────────────────────────────

export interface HealthOutput {
  version: string;
  memories: {
    total: number;
    by_type: Record<string, number>;
  };
  queue: {
    pending: number;
    processing: number;
    failed: number;
  };
  index: {
    documents: number;
    embedded: number;
    status: string;
  };
  sync?: {
    apple_notes: {
      enabled: boolean;
      last_sync_at?: string;
      total_tracked: number;
    };
  };
}

// ─── Consolidate ──────────────────────────────────────────────────

export interface ConsolidateInput {
  dry_run?: boolean;
}

export interface ConsolidateOutput {
  status: "consolidated" | "no_seed" | "cluster_too_small" | "retired_reeval" | "synthesis_failed" | "dry_run";
  seed?: { id: string; title: string };
  insight_id?: string;
  cluster_size?: number;
  candidate_count?: number;
  // Dry-run specific fields
  candidates?: Array<{ id: string; title: string; score: number }>;
  proposed_insight_type?: string;
  estimated_confidence?: number;
}

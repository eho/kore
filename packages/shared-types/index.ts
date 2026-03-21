import { z } from "zod";
import type { Elysia } from "elysia";

// ─── Zod Schemas (data_schema.md §3.1) ─────────────────────────────

export const MemoryTypeEnum = z.enum(["place", "media", "note", "person", "insight"]);
export type MemoryType = z.infer<typeof MemoryTypeEnum>;

export const IntentEnum = z.enum(["recommendation", "reference", "personal-experience", "aspiration", "how-to"]);
export type Intent = z.infer<typeof IntentEnum>;

export const BaseFrontmatterSchema = z.object({
  /** A stable UUIDv4 unique to this discrete memory */
  id: z.string().uuid(),

  /** The structural type for directory routing */
  type: MemoryTypeEnum,

  /** A QMD Context URI (e.g. 'qmd://travel/food/japan') */
  category: z.string().startsWith("qmd://"),

  /** The ISO string date when this memory was initially saved/bookmarked */
  date_saved: z.string().datetime(),

  /** The ISO string date when the original source content was created (e.g. Apple Note creation date) */
  date_created: z.string().datetime().optional(),

  /** The ISO string date when the original source content was last modified */
  date_modified: z.string().datetime().optional(),

  /** The system that originally captured this (e.g. 'apple_notes', 'x_bookmark') */
  source: z.string(),

  /** 1-5 core descriptive tags. Never more than 5. */
  tags: z.array(z.string()).max(5),

  /** The original URL if applicable (e.g. Safari Bookmark, Reddit thread) */
  url: z.string().url().optional(),

  /** The intent/disposition of the memory */
  intent: IntentEnum.optional(),

  /** LLM extraction confidence score (0–1) */
  confidence: z.number().min(0).max(1).optional(),

  /** ISO timestamp — added to source memories after consolidation */
  consolidated_at: z.string().datetime().optional(),

  /** Insight IDs that reference this source memory */
  insight_refs: z.array(z.string()).optional(),
});

export type BaseFrontmatter = z.infer<typeof BaseFrontmatterSchema>;

// ─── Insight Schemas (consolidation_system_design.md §3.2, §5.4, §10.7) ─

export const InsightTypeEnum = z.enum(["cluster_summary", "evolution", "contradiction", "connection"]);
export type InsightType = z.infer<typeof InsightTypeEnum>;

export const InsightStatusEnum = z.enum(["active", "evolving", "degraded", "retired", "failed"]);
export type InsightStatus = z.infer<typeof InsightStatusEnum>;

export const InsightFrontmatterSchema = z.object({
  id: z.string(),
  type: z.literal("insight"),
  category: z.string().startsWith("qmd://"),
  date_saved: z.string().datetime(),
  source: z.literal("kore_synthesis"),
  tags: z.array(z.string()).max(5),
  insight_type: InsightTypeEnum,
  source_ids: z.array(z.string()),
  supersedes: z.array(z.string()),
  superseded_by: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  status: InsightStatusEnum.default("active"),
  reinforcement_count: z.number().default(0),
  re_eval_reason: z.enum(["new_evidence", "source_deleted"]).nullable().default(null),
  last_synthesized_at: z.string().datetime(),
});
export type InsightFrontmatter = z.infer<typeof InsightFrontmatterSchema>;

export const InsightOutputSchema = z.object({
  title: z.string(),
  insight_type: InsightTypeEnum,
  synthesis: z.string(),
  connections: z.array(z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
  })),
  distilled_items: z.array(z.string()).min(1).max(7),
  tags: z.array(z.string()).min(1).max(5),
});
export type InsightOutput = z.infer<typeof InsightOutputSchema>;

// ─── LLM Extraction Schema (data_schema.md §3.2) ───────────────────

export const MemoryExtractionSchema = z.object({
  title: z
    .string()
    .describe(
      "A concise, declarative title or entity name for the memory."
    ),

  distilled_items: z
    .array(z.string())
    .min(1)
    .max(7)
    .describe(
      "1 to 7 atomic facts, quotes, or instructions extracted from the raw source. Must be standalone sentences."
    ),

  qmd_category: z
    .string()
    .regex(/^qmd:\/\//, "qmd_category must start with qmd://")
    .describe(
      "A hierarchical classification path starting with qmd://, e.g. qmd://tech/programming/python"
    ),

  type: z.enum(["place", "media", "note", "person"]).describe("The type of memory, either place, media, note, or person."),

  tags: z
    .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "tags must be lowercase kebab-case"))
    .min(1)
    .max(5)
    .describe("Between 1 and 5 thematic tags. lowercase, kebab-case."),

  intent: IntentEnum.optional().describe("The intent/disposition of the memory."),

  confidence: z.number().min(0).max(1).optional().describe("Extraction confidence score between 0 and 1."),
});

export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;

// ─── Plugin Event Interfaces (plugin_system.md §2) ─────────────────

export interface MemoryEvent {
  id: string;
  filePath: string;
  frontmatter: Record<string, any>;
  timestamp: string;
  taskId?: string;
}

// ─── Plugin Lifecycle Dependencies (prd-plugin-infrastructure §PLUG-001) ─

export interface PluginStartDeps {
  enqueue(
    payload: { source: string; content: string; original_url?: string; date_created?: string; date_modified?: string },
    priority?: "low" | "normal" | "high"
  ): string;
  deleteMemory(id: string): Promise<{ deleted: boolean; restoredSources: number }>;
  getMemoryIdByExternalKey(externalKey: string): string | undefined;
  setExternalKeyMapping(externalKey: string, memoryId: string, metadata?: string): void;
  removeExternalKeyMapping(externalKey: string): void;
  clearRegistry(): void;
  listExternalKeys(): Array<{ externalKey: string; memoryId: string; metadata?: string }>;
}

// ─── KorePlugin Interface (plugin_system.md §1) ────────────────────

export interface KorePlugin {
  name: string;
  start?: (deps: PluginStartDeps) => Promise<void>;
  stop?: () => Promise<void>;
  routes?: (app: Elysia) => Elysia;
  onMemoryIndexed?: (event: MemoryEvent) => Promise<void>;
  onMemoryDeleted?: (event: MemoryEvent) => Promise<void>;
  onMemoryUpdated?: (event: MemoryEvent) => Promise<void>;
}

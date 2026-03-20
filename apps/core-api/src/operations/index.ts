// Shared operations module — business logic reusable by both MCP tools and CLI commands
export { recall, applyKoreFilters } from "./recall";
export { remember } from "./remember";
export { inspect, parseMemoryFileFull, extractDistilledItems, parseFrontmatter, parseTagsArray, extractTitleFromMarkdown, resolveQmdPath } from "./inspect";
export { insights } from "./insights";
export { health } from "./health";
export { consolidate } from "./consolidate";

// Re-export types
export type {
  OperationDeps,
  RecallInput,
  RecallOutput,
  RecallResultItem,
  RememberInput,
  RememberOutput,
  InspectOutput,
  InsightsInput,
  InsightsOutput,
  InsightResultItem,
  HealthOutput,
  ConsolidateInput,
  ConsolidateOutput,
} from "./types";
export type { MemoryFileFull } from "./inspect";

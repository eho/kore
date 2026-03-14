# PRD: Extraction Quality (Track A)

## Introduction

Kore's value depends entirely on the quality of its LLM extraction pipeline. Every memory saved passes through `@kore/llm-extractor`, which calls a local 7B model to produce structured metadata (title, distilled facts, category, type, tags). Today that pipeline has three gaps: it discards *why* content was saved (no intent/disposition field), it gives no signal about its own reliability (no confidence score), and it has no tests verifying which code path actually runs in practice.

This PRD addresses all four Track A items:
- **A1**: Add `intent` field (disposition of the memory — recommendation, reference, etc.)
- **A2**: Add `confidence` score to extraction output
- **A3**: Add tests to observe which extraction path fires (structured vs. fallback)
- **A4**: Improve the system prompt with snapshot tests to verify category accuracy

## Goals

- Give each memory a machine-readable `intent` field so downstream systems (consolidation, search ranking) can reason about *why* content was saved
- Surface extraction reliability via a `confidence` score stored in frontmatter and returned by the API
- Make extraction path observability explicit — know when the fallback parser is firing vs. structured output
- Improve category and type accuracy through a better system prompt, verified by snapshot tests
- Zero breaking changes to existing memories (all new fields are additive)

## User Stories

### EXTR-001: Add `intent` and `confidence` to extraction schema and frontmatter

**Description:** As a developer, I want the extraction schema and memory frontmatter to capture intent and confidence so downstream systems can reason about why content was saved and how reliably it was extracted.

**Acceptance Criteria:**
- [ ] Define `export const IntentEnum = z.enum(["recommendation", "reference", "personal-experience", "aspiration", "how-to"])` in `packages/shared-types/index.ts` and reference it in both schemas below
- [ ] `MemoryExtractionSchema` gains:
  - `intent: IntentEnum.optional()`
  - `confidence: z.number().min(0).max(1).optional()`
- [ ] `BaseFrontmatterSchema` gains:
  - `intent: IntentEnum.optional()` — persisted in memory file YAML frontmatter
  - `confidence: z.number().min(0).max(1).optional()` — persisted in memory file YAML frontmatter
- [ ] Worker in `apps/core-api/src/worker.ts` copies `intent` and `confidence` from extraction result into `BaseFrontmatter` before writing the memory file
- [ ] When `intent` is absent from LLM output, worker defaults it to `"reference"` and logs a warning: `Worker: intent not classified for task {taskId}, defaulting to "reference"`
- [ ] `renderMarkdown` in `apps/core-api/src/markdown.ts` updated to conditionally emit `intent` and `confidence` YAML lines when present in `BaseFrontmatter` (same pattern as the existing `url` field)
- [ ] `MemorySummary` interface in `apps/core-api/src/app.ts` gains `intent?: string` and `confidence?: number`
- [ ] `MemoryFull` interface gains `intent?: string` and `confidence?: number` (inherited from `MemorySummary`)
- [ ] `parseMemoryFile` and `parseMemoryFileFull` in `apps/core-api/src/app.ts` updated to extract `intent` and `confidence` from parsed frontmatter
- [ ] Existing memories without these fields are unaffected (both are optional; no migration needed)
- [ ] Typecheck passes
- [ ] Unit tests covering:
  - `MemoryExtractionSchema.parse()` accepts all five valid intent values
  - `MemoryExtractionSchema.parse()` accepts missing `intent` (optional)
  - `MemoryExtractionSchema.parse()` rejects an invalid intent string
  - Worker defaults `intent` to `"reference"` when absent from extraction result
  - Worker passes through `intent` and `confidence` to frontmatter when present
  - `renderMarkdown` includes `intent` and `confidence` lines when present, omits them when absent

### EXTR-002: llm-extractor improvements — prompt, observability, and fallback normalization

**Description:** As a developer, I want the system prompt to instruct the model on intent and confidence, the extractor to log which code path fired, and the fallback parser to gracefully handle the new fields, so extraction quality improves and failures are visible.

**Acceptance Criteria:**

**Prompt updates** (`packages/llm-extractor/index.ts` — `SYSTEM_PROMPT`):
- [ ] Add `intent` classification rule with all five values and when to use each:
  - `"recommendation"` — someone suggests this as worth trying/using
  - `"reference"` — factual information saved for future lookup (use when uncertain)
  - `"personal-experience"` — something the user directly experienced or did
  - `"aspiration"` — something the user wants to do, try, or achieve
  - `"how-to"` — instructions, steps, or procedures
- [ ] Add `confidence` rule: a float 0.0–1.0 reflecting extraction certainty (>0.8 = clear content, 0.5–0.8 = some interpretation needed, <0.5 = ambiguous or very short)
- [ ] Add negative classification examples to prevent common misclassifications:
  - Restaurant recommendation → `type: "place"`, not `type: "note"`
  - Book recommendation → `type: "media"`, not `type: "note"`
  - Sub-paths describe *content*, not *source* (e.g. recipe from YouTube → `qmd://health/nutrition/recipes`, not `qmd://media/youtube`)
- [ ] Add rule: when content fits multiple categories, prefer the most specific applicable root
- [ ] Update the existing Mutekiya example JSON to include `"intent": "recommendation"` and `"confidence": 0.95`

**Observability** (`extract()` function):
- [ ] Log which path was taken:
  - Structured success: `LLM extractor: structured output succeeded for source {source}`
  - Fallback success: `LLM extractor: structured output failed, fallback succeeded for source {source}`
- [ ] `extract()` return type is `Promise<MemoryExtraction & { _extractionPath: "structured" | "fallback" }>`. The `_extractionPath` field is diagnostic only. Since `MemoryExtractionSchema` uses Zod's default strip mode, passing the result through `MemoryExtractionSchema.parse()` in the worker automatically drops `_extractionPath` — no manual stripping needed.

**Fallback normalization** (`fallbackParse()`):
- [ ] If `raw.intent` is present but not one of the five valid values, strip it (worker will apply the default)
- [ ] If `raw.confidence` is present but outside [0, 1], clamp it to that range

**Tests** (no live Ollama — mock `generateText` using `mock()` from `bun:test`):
- [ ] Prompt content tests:
  - Prompt contains all five intent values
  - Prompt contains confidence instructions
  - Mutekiya example JSON includes `intent` and `confidence`
- [ ] Observability tests:
  - When `Output.object()` succeeds, `_extractionPath` is `"structured"`
  - When `Output.object()` fails and `fallbackParse()` succeeds, `_extractionPath` is `"fallback"`
- [ ] Fallback normalization tests:
  - `fallbackParse()` strips invalid intent values rather than throwing
  - `fallbackParse()` clamps confidence values outside [0, 1]
- [ ] Classification snapshot tests — 6 fixed input → mock response → expected output cases:
  1. Restaurant recommendation → `type: "place"`, `qmd://travel/food/...`, `intent: "recommendation"`
  2. Book save → `type: "media"`, `qmd://media/books/...`
  3. Personal health note → `type: "note"`, `qmd://health/...`, `intent: "personal-experience"`
  4. Programming tutorial → `type: "note"`, `qmd://tech/...`, `intent: "how-to"`
  5. Travel aspiration → `type: "place"`, `qmd://travel/...`, `intent: "aspiration"`
  6. Person/contact save → `type: "person"`, `qmd://personal/...`
- [ ] Typecheck passes
- [ ] All tests pass with `bun test`

## Functional Requirements

- FR-1: `MemoryExtractionSchema` gains optional `intent` (enum, 5 values) and `confidence` (float 0–1) fields
- FR-2: `BaseFrontmatterSchema` gains optional `intent` and `confidence` fields — persisted in memory file YAML frontmatter
- FR-3: When `intent` is absent from LLM output, the worker defaults it to `"reference"` and logs a warning
- FR-4: `confidence` is stored in frontmatter as-is; no threshold behavior in V1 (flagging/filtering is a future story)
- FR-5: `extract()` logs whether structured or fallback path was used
- FR-6: `fallbackParse()` normalizes invalid `intent` (strip) and out-of-range `confidence` (clamp) rather than throwing
- FR-7: System prompt includes all five intent values with descriptions, confidence scoring guidance, and negative classification examples
- FR-8: Snapshot tests cover the 6 core classification cases using mocked LLM responses

## Non-Goals

- Filtering or quarantining low-confidence extractions (confidence is stored only; no behavior change based on value in V1)
- Re-extracting existing memories to add `intent`/`confidence` (migrations are out of scope)
- Fine-tuning or swapping the underlying model
- Changing the Ollama model configuration or base URL handling
- Retrieval weighting changes based on `intent` (that's a QMD configuration change, independent)
- A UI for reviewing low-confidence memories
- `PUT /api/v1/memory/:id` re-extraction trigger (tracked separately as a low-priority item in the design review)

## Technical Considerations

- **Schema changes are additive only.** Both `intent` and `confidence` are optional in Zod. Existing memories parse correctly without them. No migration script needed.
- **`_extractionPath` field**: Should not leak into the `BaseFrontmatter` written to disk. The `extract()` function returns `Promise<MemoryExtraction & { _extractionPath: string }>`. Since `MemoryExtractionSchema` uses Zod's default `strip` behavior, passing the LLM result through `MemoryExtractionSchema.parse()` in the worker is the natural boundary that removes this diagnostic field.
- **Mocking strategy for tests**: The tests in EXTR-002 must not call live Ollama. The `createProvider()` function or `generateText` import should be mockable. Bun's `mock()` utility (`import { mock } from "bun:test"`) is the preferred approach. Alternatively, the `extractFn` injection pattern already present in `WorkerDeps` shows the established pattern for testability.
- **Confidence self-reporting**: The LLM assigns its own confidence. This is acknowledged as imperfect (LLMs can be confidently wrong). V1 treats it as a soft signal only. More robust confidence scoring (e.g., derived from extraction path, schema parse success) is a future enhancement.
- **`worker.ts` implementation**: `processTask` will be updated to copy `intent` and `confidence` to `BaseFrontmatter`. It must also handle the `intent` default logic and log the warning if the model fails to classify it.

## Success Metrics

- All 2 user stories pass acceptance criteria and tests
- `bun test` passes across workspace with no regressions
- Every newly extracted memory has an `intent` field in its frontmatter (either LLM-assigned or defaulted to `"reference"`)
- The 6 snapshot test cases serve as a living regression suite for prompt changes going forward

## Open Questions

- Q1: Should `confidence` also be included in the `GET /api/v1/memories` list response, or only in `GET /api/v1/memory/:id`? Currently the list endpoint returns frontmatter fields. **Recommendation:** No change needed — list endpoint already returns a subset of fields; confidence is available on the detail endpoint.
- Q2: Should the intent enum be shared between `MemoryExtractionSchema` and `BaseFrontmatterSchema` as a named export (`IntentEnum`)? **Recommendation:** Yes — define `export const IntentEnum = z.enum([...])` once and reference it in both schemas to avoid duplication.

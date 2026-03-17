# PRD: Consolidation System

## Introduction

Kore currently processes every memory in isolation: ingest → extract → write → index → search. Over time this creates fragmentation (40 notes on React patterns with no single synthesized answer), contradiction persistence (two conflicting beliefs with equal weight), and latent connection blindness (related memories in different categories that are never linked). The Consolidation System addresses all three by running a background loop that identifies clusters of related memories via QMD hybrid search, synthesizes them into higher-order **insight** files via LLM, and tracks the lifecycle of each insight as new evidence arrives or sources are deleted. Full design specification: [`docs/phase2/consolidation_system_design.md`](../docs/phase2/consolidation_system_design.md).

---

## Goals

- Synthesize clusters of related memories into durable `insight` memory files stored in `$KORE_DATA_PATH/insights/`
- Run autonomously in the background every 30 minutes (configurable) without user intervention
- Maintain insight quality over time: re-synthesize when new evidence arrives, degrade/retire when sources are deleted
- Expose insights through all existing Kore interfaces (`kore list`, `kore show`, `kore search`, `kore consolidate`)
- Remain fully non-destructive: source memories are never modified beyond adding bookkeeping frontmatter fields

---

## User Stories

### CON-001: Extend shared types and consolidation tracker

**Description:** As a developer, I want the `insight` memory type, its Zod schemas, and the `ConsolidationTracker` SQLite module fully defined so that all downstream consolidation code has type-safe foundations and persistent state management.

**Acceptance Criteria:**

**Type extensions in `packages/shared-types/index.ts`:**
- [ ] `MemoryTypeEnum` extended with `"insight"`
- [ ] **Important:** `MemoryExtractionSchema.type` (line 73) must remain `z.enum(["place", "media", "note", "person"])` — LLM extraction must never produce `"insight"`. Only the base `MemoryTypeEnum` gains the new value.
- [ ] `InsightTypeEnum` exported: `z.enum(["cluster_summary", "evolution", "contradiction", "connection"])`
- [ ] `InsightStatusEnum` exported: `z.enum(["active", "evolving", "degraded", "retired", "failed"])`
- [ ] `InsightFrontmatterSchema` Zod schema defined with all fields from design doc §3.2 + §10.7:
  - `id: string` (UUID)
  - `type: z.literal("insight")`
  - `category: string` (qmd:// URI inherited from cluster's dominant category)
  - `date_saved: string` (ISO timestamp)
  - `source: z.literal("kore_synthesis")`
  - `tags: z.array(z.string()).max(5)`
  - `insight_type: InsightTypeEnum`
  - `source_ids: z.array(z.string())` (IDs of source memories)
  - `supersedes: z.array(z.string())` (IDs of previous insights this replaces)
  - `superseded_by: z.array(z.string())` (set when this insight is replaced)
  - `confidence: z.number().min(0).max(1)`
  - `status: InsightStatusEnum` (default: `"active"`)
  - `reinforcement_count: z.number()` (default: `0`)
  - `re_eval_reason: z.enum(["new_evidence", "source_deleted"]).nullable()` (default: `null`)
  - `last_synthesized_at: string` (ISO timestamp, set to `date_saved` on initial creation)
- [ ] `BaseFrontmatterSchema` extended with optional fields:
  - `consolidated_at?: string` (ISO timestamp — added to source memories after consolidation)
  - `insight_refs?: z.array(z.string())` (insight IDs that reference this source memory)
- [ ] `InsightOutputSchema` Zod schema for LLM synthesis output (design doc §5.4):
  ```typescript
  z.object({
    title: z.string(),
    insight_type: InsightTypeEnum,   // LLM may override to "contradiction"
    synthesis: z.string(),           // 3-5 sentence synthesized summary
    connections: z.array(z.object({  // structured relationships between sources
      source_id: z.string(),
      target_id: z.string(),
      relationship: z.string(),
    })),
    distilled_items: z.array(z.string()).min(1).max(7),  // atomic synthesized facts
    tags: z.array(z.string()).min(1).max(5),             // kebab-case tags
  })
  ```

**Consolidation Tracker in `apps/core-api/src/consolidation-tracker.ts`:**
- [ ] `ConsolidationTracker` class constructor accepts a `bun:sqlite` Database instance (same `kore-queue.db` used by `QueueRepository`)
- [ ] Creates `consolidation_tracker` table on construction if it does not exist:
  ```sql
  CREATE TABLE IF NOT EXISTS consolidation_tracker (
    memory_id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    consolidated_at DATETIME,
    status TEXT DEFAULT 'pending',
    re_eval_reason TEXT,
    synthesis_attempts INTEGER DEFAULT 0,
    last_attempted_at DATETIME,
    updated_at DATETIME DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_tracker(status);
  CREATE INDEX IF NOT EXISTS idx_consolidation_pending ON consolidation_tracker(consolidated_at, memory_type)
    WHERE status = 'pending' AND memory_type != 'insight';
  ```
- [ ] `upsertMemory(id, type)` — insert with `status='pending'` if not exists, no-op if exists
- [ ] `markConsolidated(id, insightId)` — set `status='active'`, `consolidated_at=now()`
- [ ] `markFailed(id)` — increment `synthesis_attempts`, set `last_attempted_at=now()`, set `status='failed'` if `synthesis_attempts >= maxSynthesisAttempts` (default: 3)
- [ ] `markEvolving(id, reason: 'new_evidence' | 'source_deleted')` — set `status='evolving'`, `re_eval_reason`
- [ ] `markDegraded(id)` — set `status='degraded'`
- [ ] `markRetired(id)` — set `status='retired'`
- [ ] `selectSeed(cooldownDays?: number, maxSynthesisAttempts?: number)` — dual-queue seed selection per design doc §10.6:
  1. **Re-evaluation queue first** (priority): query for insights with `status IN ('evolving', 'degraded')` and `synthesis_attempts < maxSynthesisAttempts`, ordered by `updated_at ASC`. Uses the SQL from design doc §4.6:
     ```sql
     SELECT memory_id FROM consolidation_tracker
     WHERE memory_type = 'insight'
       AND status IN ('evolving', 'degraded')
       AND synthesis_attempts < ?
     ORDER BY updated_at ASC
     LIMIT 1;
     ```
  2. **New seed queue** (if no re-eval work): query for non-insight memories with `status NOT IN ('failed', 'retired')`, `synthesis_attempts < maxSynthesisAttempts`, and either never consolidated or consolidated more than `cooldownDays` ago. Uses the SQL from design doc §4.6:
     ```sql
     SELECT memory_id FROM consolidation_tracker
     WHERE memory_type != 'insight'
       AND status NOT IN ('failed', 'retired')
       AND synthesis_attempts < ?
       AND (consolidated_at IS NULL OR consolidated_at < datetime('now', ? || ' days'))
     ORDER BY
       CASE WHEN consolidated_at IS NULL THEN 0 ELSE 1 END,
       consolidated_at ASC
     LIMIT 1;
     ```
  - Returns `{ memoryId: string, isReeval: boolean }` or `null` if no seed available
- [ ] `getStatus(id)` — return current tracker row or `null`
- [ ] `resetFailed()` — set all `failed` rows back to `pending`, reset `synthesis_attempts` to 0
- [ ] `truncateAll()` — delete all rows (used by reset command)
- [ ] `TYPE_DIRS` map in `apps/core-api/src/worker.ts` and `apps/core-api/src/app.ts` extended with `insight: "insights"`
- [ ] `bun tsc --noEmit` passes across the monorepo
- [ ] Unit tests for:
  - `InsightFrontmatterSchema` and `InsightOutputSchema` Zod validation (valid and invalid inputs)
  - Tracker upsert idempotency
  - Seed selection priority (re-eval queue before pending queue)
  - Failed skip logic (≥ maxSynthesisAttempts skipped)
  - Cooldown window respected
  - `resetFailed()` resets attempts and status

---

### CON-002: Candidate finder, cluster analyzer, and LLM synthesis engine

**Description:** As a developer, I want the core consolidation pipeline — finding candidates via QMD, classifying cluster type, and synthesizing via LLM — so that clusters of related memories can be transformed into structured insight output.

**Acceptance Criteria:**

**Candidate Finder in `apps/core-api/src/consolidation-candidate-finder.ts`:**
- [ ] `findCandidates(seed: MemoryFull, qmdSearch, options)` function:
  - Constructs query as `"${seed.title}. ${seed.distilledItems.slice(0, 3).join('. ')}"` (design doc §4.4)
  - Calls `qmdClient.search()` with:
    - `limit: maxClusterSize + 5` (over-fetch to account for filtering)
    - `collection: "memories"`
    - `intent: "Find memories related to the same topic, concept, or entity for knowledge consolidation"`
    - `minScore: minSimilarityScore` (default `0.45`)
  - Excludes the seed itself from results (match by file path)
  - Excludes memories with `type: "insight"` from candidates (no meta-synthesis)
  - Returns `CandidateResult[]` each with `{ memoryId, filePath, score, frontmatter }`
- [ ] `validateCluster(seed, candidates, options)` function:
  - Returns `{ valid: false, reason: string }` if cluster size (seed + candidates) is < `minClusterSize` (default 3) or > `maxClusterSize` (default 8)
  - If over `maxClusterSize`, truncates to top-scoring candidates rather than rejecting
  - Returns `{ valid: true, cluster: CandidateResult[] }` otherwise
- [ ] `classifyCluster(cluster: CandidateResult[])` function implementing deterministic rules (design doc §4.3):
  ```
  spanDays = max(all date_saved values) - min(all date_saved values)
  categories = unique category values across all cluster members
  types = unique type values across all cluster members

  if categories.length > 1 OR types.length > 1 → "connection"
  else if spanDays > 30 → "evolution"
  else → "cluster_summary"
  // "contradiction" is detected by LLM during synthesis, not here
  ```
  - Returns `InsightType`: `"cluster_summary" | "evolution" | "connection"`

**LLM Synthesis in `apps/core-api/src/consolidation-synthesizer.ts`:**
- [ ] Uses `LLM_PROVIDER` and `LLM_MODEL` env vars by default (same as `packages/llm-extractor/index.ts`), with optional `KORE_SYNTHESIS_MODEL` env var override for using a more capable model (design doc §5.1)
- [ ] `synthesizeInsight(cluster, insightType, options)` function:
  - Builds a type-specific system prompt per design doc §5.2. Three prompts:
    - **cluster_summary**: "Given a cluster of related memories on the same topic, synthesize them into a single reference document..."
    - **evolution**: "Given a set of memories on the same topic saved at different times, identify how the user's understanding, position, or practices have changed..."
    - **connection**: "Given memories from different categories or types that are semantically related, identify and articulate the cross-domain connection..."
  - All three prompts include the contradiction detection rule: "Before synthesizing, examine all source facts for contradictions. If significant contradictions exist, set insight_type to 'contradiction'"
  - User message constructed per design doc §5.3 `buildSynthesisPrompt()`:
    ```
    Insight type requested: ${insightType}

    ### Memory 1 (ID: ${m.id}, saved: ${m.dateSaved})
    - **Title:** ${m.title}
    - **Type:** ${m.type}
    - **Category:** ${m.category}
    - **Tags:** ${m.tags.join(", ")}
    - **Facts:**
      - ${distilledItem1}
      - ${distilledItem2}
    - **Source excerpt:** "${rawSource.slice(0, 300)}..."
    ```
  - Uses Vercel AI SDK structured output with `InsightOutputSchema` (same pattern as `llm-extractor`)
  - Falls back to text generation + JSON parsing if structured output fails
- [ ] `computeInsightConfidence(params)` function implementing revised formula (design doc §10.5.2):
  ```typescript
  function computeInsightConfidence(params: {
    avgSimilarity: number;       // mean QMD scores of candidates
    clusterSize: number;         // number of source memories
    reinforcementCount: number;  // times re-synthesized with new evidence
    sourceIntegrity: number;     // ratio of source_ids still on disk (0.0–1.0)
  }): number {
    const sizeFactor = Math.min((clusterSize - 2) / 3, 1.0);
    const reinforcementFactor = Math.min(1.0 + reinforcementCount * 0.05, 1.15);
    const base = avgSimilarity * 0.5 + sizeFactor * 0.5;
    const adjusted = base * reinforcementFactor * sourceIntegrity;
    return Number(Math.min(adjusted, 1.0).toFixed(2));
  }
  ```
  - Note: this supersedes the simpler §6 formula (`avgSimilarity * 0.7 + sizeFactor * 0.3`). Use only this revised version.
- [ ] `bun tsc --noEmit` passes
- [ ] Unit tests for:
  - Query construction from seed title + distilled items
  - Cluster validation (too small, too large, valid)
  - `classifyCluster` for all three deterministic paths (cross-category connection, temporal evolution >30 days, same-topic summary)
  - Confidence score calculation (edge cases: min cluster size=3, max cluster=8, max reinforcement=3, partial source integrity=0.5, zero sources=0.0)
  - `InsightOutputSchema` Zod validation of synthesis output (valid and malformed LLM responses)
  - Prompt construction includes all source memory content with correct format

---

### CON-003: Insight file writer and source frontmatter updater

**Description:** As a developer, I want `writeInsight()` and `updateSourceFrontmatter()` functions that persist insight files and update source memories with back-references, including dedup detection and supersession, so that insights are durable and sources remain consistent.

**Acceptance Criteria:**
- [ ] New file: `apps/core-api/src/consolidation-writer.ts`
- [ ] `writeInsight(synthesis, cluster, metadata)` function:
  - Generates insight ID as `ins-<uuid-short>` (8-char UUID prefix)
  - Writes file to `$KORE_DATA_PATH/insights/ins-<uuid-short>-<slug-title>.md` (truncated to 60 chars total to avoid filesystem issues). Uses the same `slugify()` from `apps/core-api/src/slugify.ts`
  - File format matches design doc §3.2 example:
    - YAML frontmatter with all `InsightFrontmatterSchema` fields
    - `# <Title>` heading
    - `## Synthesis` section with the synthesis paragraph
    - `## Key Connections` section listing `connections` as structured entries: `- **<source_id>** ("<title>") → **<target_id>** ("<title>"): <relationship>`
    - `## Distilled Memory Items` section with `distilled_items` as bullet list (matches naming convention of regular memory files)
    - `## Source Material` section: `Synthesized from N memories: id1, id2, id3`
  - Ensures `$KORE_DATA_PATH/insights/` directory exists before writing (use `mkdir -p` equivalent)
  - **Write ordering guarantee (design doc §7.1):** insight file is written to disk before any source frontmatter is updated. Rationale: an orphaned insight file is harmless; orphaned `insight_refs` pointing to nonexistent files cause errors.
  - Returns `{ insightId, filePath }`
- [ ] `checkDedup(sourceIds: string[], existingInsights: InsightFrontmatter[])` function:
  - For each existing insight, compute overlap: `intersection(insight.source_ids, sourceIds).length / insight.source_ids.length`
  - Returns the existing insight if overlap ≥ 50%
  - Returns `null` if no significant overlap (proceed with new insight)
- [ ] `supersede(oldInsightFilePath, newInsightId)` function:
  - Reads old insight file, sets `superseded_by: [newInsightId]` and `status: "retired"` in frontmatter, writes back
  - The new insight file should have `supersedes: [oldInsightId]` set during `writeInsight()`
- [ ] `updateSourceFrontmatter(sourceFilePaths, insightId)` function (design doc §7):
  - For each source file: reads content via `Bun.file().text()`, parses YAML frontmatter, merges `consolidated_at` (current ISO timestamp) and appends `insightId` to `insight_refs[]` (deduped via `Set`), writes back
  - Preserves all existing frontmatter fields and body content exactly — only adds/updates `consolidated_at` and `insight_refs`
  - Skips sources that already reference the insight ID (idempotent)
- [ ] `bun tsc --noEmit` passes
- [ ] Unit tests for:
  - Insight file format (frontmatter fields present and valid via Zod, all sections generated, `## Distilled Memory Items` naming matches regular memories)
  - Dedup detection (50% overlap threshold — test exact boundary)
  - Supersession updates both old and new insight frontmatter correctly
  - Source frontmatter update preserves existing fields, is idempotent on repeated calls

---

### CON-004: Consolidation loop, startup integration, and event handlers

**Description:** As a developer, I want the consolidation loop running as a background service, wired into the startup sequence with event handlers for reactive lifecycle management, so that insights are generated automatically, evolve when new evidence arrives, and degrade when sources are deleted.

**Acceptance Criteria:**

**Consolidation Loop in `apps/core-api/src/consolidation-loop.ts`:**
- [ ] `ConsolidationDeps` interface matching design doc §4.2 + §10.6:
  ```typescript
  interface ConsolidationDeps {
    dataPath: string;
    qmdSearch: typeof search;       // from @kore/qmd-client
    tracker: ConsolidationTracker;
    memoryIndex: MemoryIndex;
    eventDispatcher: EventDispatcher;
    intervalMs: number;             // default: 1_800_000 (30 min), env: CONSOLIDATION_INTERVAL_MS
    minClusterSize: number;         // default: 3
    maxClusterSize: number;         // default: 8
    minSimilarityScore: number;     // default: 0.45
    cooldownDays: number;           // default: 7, env: CONSOLIDATION_COOLDOWN_DAYS
    maxSynthesisAttempts: number;   // default: 3, env: CONSOLIDATION_MAX_ATTEMPTS
    relevanceThreshold: number;     // default: 0.5 (for reactive re-synthesis detection)
  }
  ```
- [ ] `startConsolidationLoop(deps)` function that:
  - Runs one consolidation cycle every `deps.intervalMs`
  - Uses a boolean concurrency guard — skips a cycle if a previous one is still running (same pattern as Apple Notes sync in `plugin-apple-notes`)
  - One cycle executes the full pipeline for one seed:
    1. Select seed via `tracker.selectSeed(cooldownDays, maxSynthesisAttempts)` — re-eval queue checked first
    2. Exit cycle early if no seed available (log at debug level)
    3. Load seed memory file from `memoryIndex`
    4. **If re-eval seed (isReeval=true):** load existing insight's `source_ids`, resolve which sources still exist, search QMD for additional candidates using insight's title + distilled items
    5. **If new seed:** find candidates via `findCandidates(seed)`
    6. Validate cluster size (3–8); if invalid and new seed, call `tracker.markFailed(seed.id)` and exit. If re-eval and below `minClusterSize`, retire the insight.
    7. Classify insight type via `classifyCluster()`
    8. Check dedup — if existing insight found with >50% overlap, call `supersede()` on it
    9. Call `synthesizeInsight()`
    10. Write insight via `writeInsight()`
    11. Update source frontmatter via `updateSourceFrontmatter()`
    12. Update tracker: `markConsolidated(seed.id)` for new seeds; upsert insight into tracker as `active`. For re-eval: retire old insight, add new insight as `active`, increment `reinforcement_count` on the new insight.
    13. Emit `memory.indexed` event for the new insight file (triggers QMD watcher + re-index)
  - On any unhandled error: log error, call `tracker.markFailed(seed.id)`, continue loop
  - Returns a `stop()` function for graceful shutdown (clears interval, waits for in-progress cycle)
- [ ] `runConsolidationCycle(deps)` — exported separately so the API endpoint can trigger a single cycle synchronously without the interval wrapper
- [ ] `runConsolidationDryRun(deps)` — runs steps 1–7 (seed selection through classification) but stops before LLM synthesis. Returns `{ seed, candidates, proposedInsightType, estimatedConfidence }` or `{ status: "no_seed" | "cluster_too_small" }`

**Startup Reconciliation (design doc §7.1):**
- [ ] On startup (before loop begins), run a lightweight consistency check:
  1. **Forward check:** For each `active` insight in tracker, verify insight file exists on disk. If missing, remove tracker entry.
  2. **Backward check:** For each insight file in `$KORE_DATA_PATH/insights/`, verify it has a tracker entry. If missing, add entry with `status='active'`.
  3. **Orphaned refs:** When reading `insight_refs` from source frontmatter, treat references to non-existent insight files as no-ops (do not error). Stale refs are cleaned up lazily during the next consolidation cycle.

**Event Handlers in `apps/core-api/src/consolidation-event-handlers.ts`:**
- [ ] `createConsolidationEventHandlers(tracker, qmdSearch, memoryIndex)` — returns an object implementing `onMemoryIndexed`, `onMemoryDeleted`, `onMemoryUpdated` (matches `KorePlugin` event hook signatures)
- [ ] `onMemoryIndexed(event)`:
  - **Tracker population:** Upsert the new memory into `consolidation_tracker` with `status='pending'` (design doc §4.6 — this is the primary write path for new tracker entries, avoiding filesystem scanning)
  - **Skip self-triggering:** If `event.frontmatter.source === "kore_synthesis"`, upsert into tracker but skip the reactive re-synthesis check below
  - **Reactive re-synthesis (design doc §10.3):** Search QMD for existing insights related to the new memory (query: new memory's title + first 3 distilled items, filter results to `type: insight`, `minScore: relevanceThreshold` default 0.5). For each matching insight where the new memory is not already in `source_ids` and not already in `evolving` state: set `status → evolving`, `re_eval_reason → "new_evidence"` in tracker. Throttle: skip if insight was already flagged within `cooldownDays`.
- [ ] `onMemoryDeleted(event)`:
  - **If deleted file is an insight** (type=insight or path under `insights/`): set tracker `status='retired'`. Stale `insight_refs` in source files cleaned up lazily.
  - **If deleted file is a regular memory:** Read `insight_refs` from the deleted memory's frontmatter (if present). For each referenced insight ID:
    - Load insight frontmatter to get `source_ids`
    - Count remaining sources that still exist in `memoryIndex`
    - Apply integrity rules (design doc §10.4):
      - `ratio == 0` → `status: "retired"` (terminal)
      - `ratio < 0.5` → `status: "degraded"`
      - `ratio >= 0.5` → `status: "evolving"`, `re_eval_reason: "source_deleted"`
    - Update insight file frontmatter `status` field to reflect new state
    - Update tracker accordingly
- [ ] `onMemoryUpdated(event)`: treat as `onMemoryDeleted` + `onMemoryIndexed` in sequence
- [ ] Event handlers registered with `eventDispatcher` in `apps/core-api/src/index.ts` (as a pseudo-plugin or directly via `registerPlugins`), after real plugins are loaded

**Startup Sequence in `apps/core-api/src/index.ts`:**
- [ ] `startConsolidationLoop()` called as step 10, after `startEmbedInterval()` (step 9) — ensures vectors exist before first cycle runs
- [ ] `stopConsolidationLoop()` called in the graceful shutdown handler alongside existing service stops
- [ ] `CONSOLIDATION_INTERVAL_MS` env var controls interval (default: `1_800_000`)
- [ ] `CONSOLIDATION_COOLDOWN_DAYS` env var controls seed cooldown (default: `7`)
- [ ] `CONSOLIDATION_MAX_ATTEMPTS` env var controls dead-letter threshold (default: `3`)
- [ ] `bun tsc --noEmit` passes
- [ ] Unit tests for:
  - Concurrency guard prevents overlapping cycles
  - Loop exits early when no seed is available
  - Failed synthesis increments tracker attempts
  - Re-eval seeds are processed before new seeds
  - `onMemoryIndexed` upserts new memories into tracker
  - `onMemoryIndexed` skips reactive check for `kore_synthesis` source
  - `onMemoryDeleted` correctly transitions insight status at all three ratio boundaries (0, <0.5, ≥0.5)
  - Startup reconciliation adds tracker entries for orphaned insight files

---

### CON-005: API endpoint and CLI command

**Description:** As a developer and user, I want a `POST /api/v1/consolidate` API endpoint and a `kore consolidate [--dry-run]` CLI command so that consolidation can be triggered on demand and tested without LLM synthesis.

**Acceptance Criteria:**
- [ ] `POST /api/v1/consolidate` endpoint added to `apps/core-api/src/app.ts`:
  - Accepts optional query params:
    - `?reset_failed=true` — calls `tracker.resetFailed()` before running cycle
    - `?dry_run=true` — runs pipeline through classification but stops before LLM synthesis
  - Normal mode: triggers one synchronous consolidation cycle via `runConsolidationCycle(deps)`
  - Returns JSON:
    - Success: `{ status: "consolidated", insightId: string, seed: { id, title }, clusterSize: number }`
    - No work: `{ status: "no_seed" }`
    - Insufficient cluster: `{ status: "cluster_too_small", seed: { id, title }, candidateCount: number }`
    - Dry run: `{ status: "dry_run", seed: { id, title }, candidates: [{ id, title, score }], proposedInsightType: string, estimatedConfidence: number }`
  - Protected by `KORE_API_KEY` bearer auth (same as all other endpoints)
- [ ] `kore consolidate` command added to `apps/cli/src/index.ts`:
  - Calls `POST /api/v1/consolidate` via `apiFetch()`
  - Prints result in human-readable form (seed title, cluster size, insight ID if created)
  - `--dry-run` flag: calls `POST /api/v1/consolidate?dry_run=true`
- [ ] `--dry-run` CLI output format:
  ```
  Seed: "<title>" (<id>)
  Candidates (4):
    - "<title>" (score: 0.72)
    - "<title>" (score: 0.68)
    ...
  Proposed type: evolution
  Estimated confidence: 0.74
  ```
- [ ] `bun tsc --noEmit` passes
- [ ] Unit tests for:
  - API returns `no_seed` when tracker has no eligible seeds
  - API returns `cluster_too_small` when fewer than 3 candidates found
  - `reset_failed` resets failed tracker rows before cycle runs
  - `dry_run` returns candidate list without writing any files

---

### CON-006: Insight type in existing list, show, search, delete, and reset commands

**Description:** As a user, I want insights to be fully accessible through the existing Kore CLI and API — including search filtering of retired insights — so that I can browse, read, and delete insights the same way I manage any other memory.

**Acceptance Criteria:**
- [ ] `MemoryIndex` in `apps/core-api/src/memory-index.ts`:
  - `TYPE_DIRS` array updated to include `"insights"` (currently: `["places", "media", "notes", "people"]`)
  - Insights are scanned on startup alongside all other memory types
- [ ] `kore list --type insight` returns insights from `$KORE_DATA_PATH/insights/`
  - Output includes `insight_type`, `confidence`, `status`, and `source_ids` count alongside standard fields (id, title, date_saved, tags)
- [ ] `kore show <insight-id>` displays the full insight file including synthesis paragraph, distilled items, and connections
  - Prefix matching works (e.g., `kore show ins-abc` matches `ins-abc123...`)
- [ ] `kore search` returns insights in results alongside regular memories (already handled by QMD watcher indexing `.md` files in `insights/`)
  - **Retired insight filtering (design doc §4.5):** `POST /api/v1/search` must filter out results where the file's frontmatter has `status: retired`. Without this, queries return multiple versions of the same evolving insight. This can be done by post-filtering search results or by adding QMD context hints.
- [ ] `kore delete <insight-id>` / `DELETE /api/v1/memory/:id` for an insight:
  - Deletes the insight file
  - Removes the insight ID from `insight_refs` in all source memory frontmatter files that reference it (iterate `source_ids` from insight frontmatter, update each source file)
  - Removes the insight from `consolidation_tracker` (or marks as retired)
  - Emits `memory.deleted` event
  - `--force` flag skips confirmation prompt (existing CLI behavior)
- [ ] `GET /api/v1/memories?type=insight` returns insights
- [ ] `GET /api/v1/memory/:id` works for insight IDs
- [ ] **Reset integration:** `DELETE /api/v1/memories` (reset endpoint in `apps/core-api/src/app.ts`) must also call `tracker.truncateAll()` to clear the `consolidation_tracker` table. Currently it only deletes files and clears the task queue — the tracker would retain stale rows without this.
- [ ] `ensureDataDirectories()` in `apps/core-api/src/app.ts` updated to create `insights/` directory alongside existing type directories
- [ ] `bun tsc --noEmit` passes
- [ ] Unit tests for:
  - `MemoryIndex` correctly includes the `insights/` directory in its scan
  - Delete API cleans up `insight_refs` from source frontmatter
  - Search results exclude `status: retired` insights
  - Reset endpoint truncates `consolidation_tracker`

---

### CON-007: End-to-end integration tests

**Description:** As a developer, I want end-to-end integration tests in `e2e/` that exercise the full consolidation pipeline against a real QMD index so that regressions are caught before shipping.

**Acceptance Criteria:**
- [ ] New directory: `e2e/consolidation/`
- [ ] Test setup: seeded with at least 5 synthetic memory `.md` files across two topics (≥3 on topic A, ≥2 on topic B) written to a temporary `$KORE_DATA_PATH`; QMD indexed and embedded before tests run
- [ ] **Happy path test** (`consolidation.test.ts`):
  - Call `POST /api/v1/consolidate`
  - Assert response `status: "consolidated"` with a valid `insightId`
  - Assert insight file exists at `$KORE_DATA_PATH/insights/`
  - Assert insight frontmatter passes `InsightFrontmatterSchema.parse()` validation
  - Assert source memory frontmatter has `consolidated_at` and `insight_refs` containing the insight ID
  - Assert insight is returned by `POST /api/v1/search` with a relevant query
- [ ] **Dry-run test**: assert `dry_run=true` returns candidates without writing any files or calling LLM
- [ ] **Cluster-too-small test**: seed corpus with only 2 memories on an isolated topic; assert response `status: "cluster_too_small"`
- [ ] **Reactive lifecycle test**:
  - After creating an insight from 3 source memories, delete one source via `DELETE /api/v1/memory/:id`
  - Assert the insight's status transitions to `evolving` (2/3 remaining = 67% ≥ 50%)
  - Delete a second source
  - Assert the insight's status transitions to `degraded` (1/3 remaining = 33% < 50%)
- [ ] **Retired insight filtering test**: after superseding an insight, assert the retired version does not appear in search results
- [ ] **`kore list --type insight` test**: after consolidation, assert the insight appears in list output
- [ ] Tests use a separate SQLite database and data directory (no pollution of dev data)
- [ ] `bun test e2e/consolidation/` passes reliably (no flakiness from QMD async indexing — use explicit `await qmdClient.update()` + `await qmdClient.embed()` before assertions)
- [ ] Update `docs/phase2/consolidation_system_design.md` to mark implementation status as complete and add any calibration notes discovered during testing

---

## Functional Requirements

- **FR-1**: The system must add an `insight` memory type with its own directory (`insights/`) and Zod schemas to `@kore/shared-types`. The existing `MemoryExtractionSchema.type` must NOT include `"insight"`.
- **FR-2**: The system must maintain a `consolidation_tracker` SQLite table in the existing `kore-queue.db` with indexed columns for status-based queries.
- **FR-3**: Candidate selection must use QMD hybrid search with a consolidation intent, filter by `minSimilarityScore` (default 0.45), and validate cluster size between 3 and 8 members (inclusive).
- **FR-4**: Insight type must be classified deterministically based on temporal spread (>30 days → evolution) and category/type variance (cross-category → connection); contradictions are detected by LLM during synthesis.
- **FR-5**: LLM synthesis must use `LLM_PROVIDER`/`LLM_MODEL` env vars by default with `KORE_SYNTHESIS_MODEL` as an optional override. Output must be validated by `InsightOutputSchema` Zod schema with text-generation fallback.
- **FR-6**: Insight files must be written before source frontmatter is updated (crash-safe write ordering per design doc §7.1).
- **FR-7**: Source memories must never be modified beyond adding `consolidated_at` and `insight_refs` frontmatter fields. No source memory content is altered.
- **FR-8**: The consolidation loop must run every `CONSOLIDATION_INTERVAL_MS` milliseconds (default 30 min) with a concurrency guard preventing overlapping cycles.
- **FR-9**: The loop must start after `startEmbedInterval()` in the startup sequence to ensure vectors are available.
- **FR-10**: When `memory.indexed` fires for a non-synthesis memory, the system must (a) upsert the memory into `consolidation_tracker` and (b) search for affected insights and flag them `evolving`.
- **FR-11**: When `memory.deleted` fires, the system must recompute source integrity ratio and transition the affected insight to `evolving`, `degraded`, or `retired` per §10.4 thresholds.
- **FR-12**: `POST /api/v1/consolidate` must support `?reset_failed=true` and `?dry_run=true` query parameters.
- **FR-13**: `kore consolidate --dry-run` must show seed, candidates with scores, proposed insight type, and estimated confidence without writing any files or calling the LLM.
- **FR-14**: `MemoryIndex` must scan the `insights/` directory so all existing commands (`list`, `show`, `search`, `delete`) work with insights.
- **FR-15**: Deleting an insight must clean up `insight_refs` references in source memory frontmatter files.
- **FR-16**: The `DELETE /api/v1/memories` reset endpoint must truncate `consolidation_tracker` in addition to deleting files and clearing the task queue.
- **FR-17**: `POST /api/v1/search` must filter out `status: retired` insights from default results to prevent superseded insight clutter.
- **FR-18**: On startup, the consolidation system must run a reconciliation check: verify tracker ↔ filesystem consistency and heal orphaned entries (design doc §7.1).

---

## Non-Goals

- **No insight-of-insights (meta-synthesis)**: Insight files are excluded from consolidation candidates. Recursive synthesis is deferred.
- **No real-time consolidation**: Consolidation is interval-based only; there is no per-ingest trigger. Event handlers flag insights for re-evaluation, but actual re-synthesis is deferred to the next loop cycle.
- **No manual user feedback**: No thumbs-up/down or rating mechanism for insights.
- **No time-based confidence decay**: Age of an insight is not penalized; only source integrity and re-synthesis affect confidence. See design doc §10.5.3 for rationale.
- **No knowledge graph database**: The structured `connections` field in insights provides link information; no Neo4j or graph-specific SQLite tables.

---

## Technical Considerations

- **QMD `intent` parameter**: Confirmed supported — `SearchOptions.intent` is a `string` field in `@tobilu/qmd` (see `node_modules/@tobilu/qmd/src/index.ts:151`). It steers query expansion and reranking.
- **Frontmatter read/write**: The codebase uses a simple regex-based `parseFrontmatter()` in `app.ts` and `memory-index.ts`. For the consolidation writer, use a proper YAML parser (e.g., `yaml` package or `gray-matter`) since insight frontmatter has arrays and nested values that the regex parser can't handle. Preserve existing frontmatter fields exactly; only add/update consolidation fields.
- **File slug generation**: Insight filenames should be `ins-<8-char-uuid>-<kebab-title>.md` (truncated to 60 chars total). Use the same `slugify()` from `apps/core-api/src/slugify.ts`.
- **LLM context budget**: Each source memory is represented as title + distilled items + 300-char raw excerpt. For `maxClusterSize=8` this produces ~2400 extra chars of raw content — well within context budget for a 7B model.
- **Embedder dependency**: The consolidation loop relies on QMD vectors being present. Starting the loop after `startEmbedInterval()` is sufficient; no explicit wait/poll for embed completion is needed.
- **Event loop / watcher**: The watcher triggers QMD re-index when the insight file is written to disk. No special QMD registration is needed — insights are `.md` files in a watched subdirectory of `$KORE_DATA_PATH`.
- **Concurrency with watcher**: The `updateSourceFrontmatter()` writes will trigger the watcher for each source file. This is expected and correct — it re-indexes sources with updated `insight_refs` fields.
- **`TYPE_DIRS` duplication**: `TYPE_DIRS` is defined in three places: `worker.ts`, `app.ts`, and `memory-index.ts`. All three must be updated. Consider extracting to `shared-types` in a future refactor, but for now update each location.
- **State transition rules**: Follow the explicit state transition matrix in design doc §4.7. Key constraint: `retired` is terminal (no transitions out). `failed` is only recoverable via manual `resetFailed()` API call.
- **Confidence formula**: Use ONLY the revised formula from design doc §10.5.2 (`avgSimilarity * 0.5 + sizeFactor * 0.5` with `sizeFactor = min((clusterSize - 2) / 3, 1.0)`). The simpler formula in §6 is superseded.

---

## Success Metrics

- After 7 days of normal Kore usage (≥50 memories), at least one insight file is generated without manual intervention
- `kore consolidate --dry-run` completes in under 3 seconds
- `kore search "react state management"` returns relevant insight files ranked in the top 5 results when applicable
- Zero source memory content is altered (only `consolidated_at` and `insight_refs` frontmatter fields added)
- Integration tests pass reliably with `bun test e2e/consolidation/`

---

## Open Questions

1. ~~**QMD `intent` field support**~~: Confirmed — `SearchOptions.intent` is supported in `@tobilu/qmd`.
2. **`minSimilarityScore` calibration**: The default of `0.45` is a starting point. After running against a real memory corpus, this may need tuning up (to reduce noise) or down (to increase cluster size). The `--dry-run` command is the primary calibration tool.
3. **Startup reconciliation**: On server restart, memories ingested while the server was down won't be in `consolidation_tracker`. The `onMemoryIndexed` handler + reconciliation step handles this, but there may be a brief delay before new memories are eligible.
4. **Insight file naming collisions**: Mitigated by always including a UUID prefix in the filename (`ins-<8-char-uuid>-<slug>.md`). Two clusters will never produce the same UUID.

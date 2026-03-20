# PRD: Consolidation Reset & Insight Delete

## Introduction

The Kore consolidation system creates insights by synthesizing clusters of related memories. During development, testing, and normal operation, users need the ability to (1) reset all consolidation artifacts while preserving ingested memories, and (2) delete individual insights with proper restoration of source memories to the consolidation pool.

Currently, `kore reset` wipes everything (memories, tasks, QMD index). There is no way to clear only the consolidation layer. And while `kore delete <id>` can remove an insight file, it leaves source memories stuck in `active` tracker status — permanently excluded from future consolidation.

**Design doc:** `docs/phase2/consolidation_reset_delete_design.md`

## Goals

- Allow surgical reset of consolidation artifacts (insights, tracker state, source frontmatter) without deleting ingested memories
- When an insight is deleted, automatically restore its source memories to the consolidation pool so they can be re-consolidated
- Pause the consolidation loop during reset to prevent race conditions
- Provide clear CLI feedback showing what was cleaned up

## User Stories

### CONRST-001: Consolidation Reset
**Description:** As a Kore user, I want to run `kore consolidation reset` to delete all insights and return all memories to unconsolidated state, so that the system can start over with fresh insight generation while keeping my ingested memories intact.

**Acceptance Criteria:**
- [ ] New `resetConsolidation()` function in `apps/core-api/src/consolidation-reset.ts`
- [ ] Scans ALL non-insight memories in memoryIndex and strips `consolidated_at` and `insight_refs` from their frontmatter (indiscriminate scan — does not rely on insight `source_ids`)
- [ ] Deletes all files in `{dataPath}/insights/` and recreates the empty directory
- [ ] Removes all insight entries from memoryIndex
- [ ] Calls `tracker.truncateAll()` then backfills all remaining indexed memories as `pending`
- [ ] Calls `qmdUpdate()` to remove stale insight vectors (skips `embed()` — semantic content unchanged)
- [ ] Returns `{ deletedInsights, restoredMemories, trackerBackfilled }` with accurate counts
- [ ] Handles missing/unreadable files gracefully (logs warning, continues)
- [ ] Memories with no consolidation fields are not unnecessarily written to disk
- [ ] Add `pause()` and `resume()` methods to the consolidation loop handle returned by `startConsolidationLoop()` — `pause()` prevents new cycles from starting and waits for any in-flight cycle to complete; `resume()` re-enables the interval timer
- [ ] New `DELETE /api/v1/consolidation` route in `app.ts` that pauses the loop, calls `resetConsolidation()`, then resumes the loop in a `finally` block
- [ ] Route returns `{ status: "reset", deleted_insights, restored_memories, tracker_backfilled }` on success; 500 with `{ error, code: "RESET_FAILED" }` on failure
- [ ] Pass consolidation loop handle and `qmdUpdate` function through `AppDeps`; wire up in `index.ts`
- [ ] New `kore consolidation reset` CLI subcommand in `apps/cli/src/commands/consolidation-reset.ts` — prompts for confirmation (skippable with `--force`), supports `--json` flag, displays deleted/restored/backfilled counts
- [ ] Register the subcommand in `apps/cli/src/index.ts`
- [ ] Typecheck/lint passes
- [ ] **[Testing]** Unit tests in `consolidation-reset.test.ts` covering: full reset flow, accurate counts, missing files handled, no-op on clean memories, pause/resume behavior

### CONRST-002: Enhanced Insight Delete with Source Restoration
**Description:** As a Kore user, I want deleting an insight via `kore delete <insight-id>` to automatically restore its source memories to the consolidation pool so they can participate in future consolidation cycles.

**Acceptance Criteria:**
- [ ] Add `resetToPending(id)` method to `ConsolidationTracker` — sets status to `pending`, clears `consolidated_at`, `synthesis_attempts`, `last_attempted_at`, `re_eval_reason`
- [ ] Enhance `removeInsightRefFromSource()` in `delete-memory.ts` to perform single-pass file I/O: when `insight_refs` becomes empty after removal, also strip `consolidated_at` in the same write; return `{ refsEmpty: boolean }`
- [ ] Enhance `deleteMemoryById()`: after removing insight refs, call `tracker.resetToPending(sourceId)` for each source where `refsEmpty === true`; add optional `consolidationTracker?: ConsolidationTracker` to `DeleteMemoryDeps`
- [ ] Change `deleteMemoryById()` return type from `Promise<boolean>` to `Promise<{ deleted: boolean, restoredSources: number }>`
- [ ] **[Breaking change]** Update ALL existing callers of `deleteMemoryById()` across the codebase to use the new return type. Current callers check `if (!deleted)` which will silently break (object is always truthy). Search for all invocations and change to `if (!result.deleted)`. Affected locations include `app.ts`, `index.ts`, test files (`plugin-lifecycle.test.ts`, `con006-integration.test.ts`, etc.)
- [ ] Source referenced by multiple insights: only reset to pending when ALL insight refs are removed (i.e., `refsEmpty === true`)
- [ ] Update `DELETE /api/v1/memory/:id` route in `app.ts` to pass `consolidationTracker` to `deleteMemoryById` and include `restored_sources` in response
- [ ] Enhance `kore delete` CLI output: when deleting an insight, show "N source memories restored to consolidation pool"; for non-insights, output unchanged
- [ ] Typecheck/lint passes
- [ ] **[Testing]** Unit tests in `delete-memory.test.ts`: single-pass I/O removes both fields; multi-insight source not reset; `resetToPending` tracker test; `deleteMemoryById` returns correct `restoredSources` count
- [ ] **[Documentation]** Update design doc `docs/phase2/consolidation_reset_delete_design.md` status from "Draft" to "Implemented"

## Functional Requirements

- FR-1: `resetConsolidation()` must strip `consolidated_at` and `insight_refs` from ALL non-insight memories (indiscriminate scan via memoryIndex, not insight `source_ids`)
- FR-2: `resetConsolidation()` must delete all insight files, truncate the tracker, backfill all memories as `pending`, and call QMD `update()`
- FR-3: The consolidation loop must be paused before reset and resumed after, to prevent races
- FR-4: `DELETE /api/v1/consolidation` must return counts of deleted insights, restored memories, and backfilled tracker entries
- FR-5: `deleteMemoryById()` must restore source memories to `pending` tracker status when their `insight_refs` becomes empty after an insight deletion
- FR-6: `removeInsightRefFromSource()` must strip both `insight_refs` entry and `consolidated_at` in a single file write when refs become empty
- FR-7: Source memories referenced by multiple insights must only be reset to `pending` when ALL insight references are removed
- FR-8: `kore consolidation reset` must prompt for confirmation unless `--force` is passed
- FR-9: `kore delete <insight-id>` must display restored source count in output

## Non-Goals

- Bulk delete of insights by filter or query
- Undo or restore deleted insights
- Soft-delete or archival (tracker `retired` status already serves this purpose)
- Integration/e2e tests (deferred — unit tests only for this PRD)
- Plugin instrumentation for reset events

## Technical Considerations

- **Consolidation tracker** shares the SQLite database with `QueueRepository` — `truncateAll()` only affects the `consolidation_tracker` table
- **QMD re-index cost:** stripping frontmatter fields changes file hashes; `update()` will re-index all touched source files' metadata. `embed()` is skipped since semantic content is unchanged. For ~275 memories this is acceptable for an infrequent operation
- **`deleteMemoryById` return type is a breaking change:** The return type changes from `Promise<boolean>` to `Promise<{ deleted: boolean, restoredSources: number }>`. All existing callers (roughly 14 invocations across `app.ts`, `index.ts`, test files) currently do `if (!deleted)` which will silently pass since an object is always truthy. Every caller must be updated to `if (!result.deleted)`. The `consolidationTracker` dep is optional — existing callers that don't provide it get `restoredSources: 0`
- **Identifying non-insights in memoryIndex:** `MemoryIndex` is a `Map<string, string>` (ID → filePath) with no type field. To filter out insights during reset, check if the file path contains `/insights/` (e.g., `filePath.includes("/insights/")`) or if the ID starts with `ins-`
- **Pause/resume implementation:** Add a `let paused = false` variable inside the `startConsolidationLoop` closure. `pause()` sets `paused = true` and, if a cycle is in-flight (`running === true`), awaits a promise that resolves when the cycle completes (reuse the existing `resolveInProgress` pattern). The `cycle()` function returns immediately if `paused === true`. `resume()` sets `paused = false` — the `setInterval` continues ticking in the background, so no timer reconstruction is needed
- **Single-pass frontmatter stripping:** When enhancing `removeInsightRefFromSource()` to also strip `consolidated_at`, use regex `(/^consolidated_at:.*\n?/m)` to find and remove the line. This must handle the line appearing anywhere in the frontmatter block without destroying adjacent fields. Test with various frontmatter orderings
- **Existing `DELETE /api/v1/memories` (full reset):** already calls `tracker.truncateAll()` — no changes needed there

## Success Metrics

- `kore consolidation reset` completes without errors and all source memories show `status: pending` in tracker
- After reset, `kore consolidate` successfully picks seeds and generates new insights
- `kore delete <insight-id>` restores sources: subsequent `kore consolidate` picks them as seeds
- No regressions in existing `kore reset`, `kore delete` for non-insights, or consolidation loop behavior

## Open Questions

- Should `kore consolidation reset` also reset the QMD embeddings for insight vectors, or is `update()` sufficient? (Current design: `update()` only)
- Should we add a `kore consolidation status` command showing tracker summary (pending/active/failed counts)? (Deferred — nice-to-have)

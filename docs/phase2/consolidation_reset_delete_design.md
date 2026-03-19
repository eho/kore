# Consolidation Reset & Insight Delete Design

**Status:** Draft (v2 — revised after review)
**Date:** 2026-03-20

## Problem Statement

The consolidation system creates insights from clusters of related memories. During development, testing, and normal operation, users need the ability to:

1. **Reset all consolidation** — wipe all insights and return every memory to an unconsolidated state so the system can start fresh
2. **Delete a single insight** — remove one insight and properly restore its source memories to the consolidation pool

Currently, `kore reset` wipes *everything* (memories, tasks, QMD index, tracker). There is no way to reset only the consolidation layer while preserving ingested memories. And while `kore delete <id>` can delete an insight file and clean up `insight_refs` in sources, it does **not** reset source memories' tracker status back to `pending`, leaving them stuck in `active` and permanently excluded from future consolidation.

## Design Goals

1. **Surgical reset** — clear only consolidation artifacts, preserving all ingested memories and the QMD search index
2. **Correct source restoration** — when an insight is removed, its source memories must re-enter the consolidation pool
3. **Consistent state** — tracker, filesystem, memoryIndex, and source frontmatter must all agree after any operation
4. **CLI parity** — both operations available as CLI commands with confirmation prompts

## Non-Goals

- Bulk delete of insights by filter/query (future feature)
- Undo/restore deleted insights
- Insight archival (soft-delete) — `retired` status already serves this role in the tracker

---

## Architecture

### State Inventory

Every consolidation cycle touches these locations:

| State | Location | Created/Modified |
|-------|----------|-----------------|
| Insight `.md` files | `{dataPath}/insights/` | Written by `writeInsight()` |
| Tracker rows | `consolidation_tracker` SQLite table | Managed by `ConsolidationTracker` methods |
| Source `insight_refs` | Frontmatter of each source memory `.md` | Appended by `updateSourceFrontmatter()` |
| Source `consolidated_at` | Frontmatter of each source memory `.md` | Set by `updateSourceFrontmatter()` |
| Memory index entries | In-memory `MemoryIndex` Map | `memoryIndex.set(insightId, path)` |
| Supersession markers | Old insight `superseded_by` array + `status: retired` | Written by `supersede()` |
| QMD search vectors | QMD SQLite database | Indexed by QMD `update()` + `embed()` |

### Operation 1: Consolidation Reset

**Command:** `kore consolidation reset`
**API:** `DELETE /api/v1/consolidation`

#### Steps

```
1. Pause consolidation loop (prevent races)

2. Clean ALL non-insight memory frontmatter
   └─ Iterate every entry in memoryIndex
   └─ Skip entries whose filePath is in insights/
   └─ For each non-insight memory file:
      a. Remove `consolidated_at` field
      b. Remove `insight_refs` field (or set to [])
      c. Write updated file back to disk
   └─ This is deliberately indiscriminate — does not rely on
      insight source_ids, so it self-heals corrupted states
      where insight files were manually deleted or corrupted.

3. Delete all insight files
   └─ rm -rf {dataPath}/insights/
   └─ Recreate empty directory

4. Reset consolidation tracker
   └─ Call tracker.truncateAll() to clear all rows
   └─ Backfill all indexed memories as 'pending'
      (same as reconcileOnStartup phase 3)
   └─ Note: truncateAll() intentionally destroys tracker history
      (synthesis_attempts, last_attempted_at). This is acceptable
      because the insights they reference no longer exist. A full
      reset is a clean slate.

5. Remove insight entries from memoryIndex
   └─ For each insight ID, call memoryIndex.delete(id)

6. Trigger QMD re-index
   └─ Call qmdClient.update() to remove stale insight vectors
      and detect modified source files (frontmatter changes)
   └─ Skip qmdClient.embed() — see "QMD Re-index Cost" below

7. Resume consolidation loop
```

#### QMD Re-index Cost

Stripping `consolidated_at` and `insight_refs` from source files changes their file hashes. QMD will detect all touched source files as "modified" during `update()` and re-index their metadata. However, the semantic content (body text) is unchanged, so **we skip `embed()`** — the existing embeddings remain valid. Only a `update()` call is needed to:
- Remove deleted insight vectors from the search index
- Update metadata for modified source files

If QMD's `update()` triggers automatic re-embedding of modified files, this is an acceptable cost for a reset operation (which is infrequent). For a knowledge base with 275 memories, this is a one-time cost.

#### Response

```typescript
interface ConsolidationResetResponse {
  status: "reset";
  deleted_insights: number;
  restored_memories: number; // source memories whose frontmatter was cleaned
  tracker_backfilled: number;
}
```

#### Sequence Diagram

```
CLI                          API                         Filesystem/DB
 │                            │                              │
 │ DELETE /api/v1/consolidation                              │
 │──────────────────────────>│                              │
 │                            │ pause consolidation loop     │
 │                            │                              │
 │                            │ Scan ALL non-insight         │
 │                            │ memories in memoryIndex      │
 │                            │ Strip consolidated_at &      │
 │                            │ insight_refs from each       │
 │                            │────────────────────────────>│
 │                            │                              │
 │                            │ rm insights/                 │
 │                            │────────────────────────────>│
 │                            │                              │
 │                            │ tracker.truncateAll()        │
 │                            │ backfill pending             │
 │                            │────────────────────────────>│
 │                            │                              │
 │                            │ memoryIndex cleanup          │
 │                            │ QMD update (no embed)        │
 │                            │────────────────────────────>│
 │                            │                              │
 │                            │ resume consolidation loop    │
 │                            │                              │
 │  { deleted_insights: N }   │                              │
 │<──────────────────────────│                              │
```

### Operation 2: Insight Delete

**Command:** `kore delete <insight-id>` (existing command, enhanced behavior)
**API:** `DELETE /api/v1/memory/:id` (existing endpoint, enhanced behavior)

The existing `deleteMemoryById()` already handles:
- Removing `insight_refs` from source memories via `removeInsightRefFromSource()`
- Deleting the file from disk
- Removing from memoryIndex
- Emitting `memory.deleted` event → `onMemoryDeleted` marks insight as retired in tracker

**What's missing:** restoring source memories to the consolidation pool.

#### Current Flow (what happens today)

```
deleteMemoryById(insightId)
  ├── removeInsightRefFromSource() for each source  ← cleans insight_refs ✓
  ├── unlink(insightFile)                            ← deletes file ✓
  ├── memoryIndex.delete(insightId)                  ← removes from index ✓
  └── emit("memory.deleted")
       └── onMemoryDeleted()
            └── tracker.markRetired(insightId)       ← marks insight retired ✓
                                                      ← source tracker status? ✗
                                                      ← source consolidated_at? ✗
```

#### Enhanced Flow (proposed)

Source restoration is placed **directly in `deleteMemoryById()`**, not in the async event handler. This keeps it synchronous with the delete operation so the API can return accurate `restored_sources` count without awaiting decoupled events.

```
deleteMemoryById(insightId, deps)
  ├── Read insight frontmatter → extract source_ids
  ├── For each source in source_ids:
  │    └── removeInsightRefFromSource(sourcePath, insightId)
  │         └── Single-pass: removes ref AND strips consolidated_at
  │             if insight_refs becomes empty (see "Single-Pass I/O")
  │         └── Returns { refsEmpty: boolean }
  │    └── If refsEmpty: tracker.resetToPending(sourceId)
  ├── unlink(insightFile)
  ├── memoryIndex.delete(insightId)
  └── emit("memory.deleted")
       └── onMemoryDeleted()
            └── tracker.markRetired(insightId)        ✓
                (source restoration already done above)
  └── Return { deleted: true, restoredSources: count }
```

#### Single-Pass File I/O

The existing `removeInsightRefFromSource()` reads and writes the source file. Rather than performing a second read/write to conditionally strip `consolidated_at`, the function is enhanced to handle both in a single pass:

```typescript
// delete-memory.ts (enhanced)

interface RemoveRefResult {
  refsEmpty: boolean; // true if insight_refs is now empty after removal
}

async function removeInsightRefFromSource(
  sourceFilePath: string,
  insightId: string,
): Promise<RemoveRefResult> {
  // ... existing logic to read file, parse frontmatter, filter refs ...

  // NEW: if refs array is now empty, also strip consolidated_at
  if (refs.length === 0) {
    // Remove consolidated_at line from frontmatter in same pass
    updatedFm = updatedFm.replace(/^consolidated_at:.*\n?/m, "");
  }

  // Write file once with both changes
  await writeFile(sourceFilePath, updatedContent, "utf-8");
  return { refsEmpty: refs.length === 0 };
}
```

#### New Tracker Method

```typescript
// consolidation-tracker.ts
resetToPending(id: string): void {
  this.db.run(
    `UPDATE consolidation_tracker
     SET status = 'pending',
         consolidated_at = NULL,
         synthesis_attempts = 0,
         last_attempted_at = NULL,
         re_eval_reason = NULL,
         updated_at = datetime('now')
     WHERE memory_id = ?`,
    [id]
  );
}
```

#### Edge Case: Source Referenced by Multiple Insights

A source memory may appear in multiple insights (e.g., memory A is in both `ins-001` and `ins-002`). When `ins-001` is deleted:

- `removeInsightRefFromSource()` removes `ins-001` from `insight_refs`
- `insight_refs` still contains `ins-002` → `refsEmpty = false`
- Memory remains `active` in tracker, `consolidated_at` preserved
- Only reset to `pending` if `insight_refs` becomes empty after removal

**Decision logic:**

```
After removing insightId from source's insight_refs:
  if insight_refs is now empty:
    → remove consolidated_at from frontmatter (same file write)
    → tracker.resetToPending(sourceId)
  else:
    → leave as-is (still consolidated in another insight)
```

#### Enhanced `deleteMemoryById` Deps

Source restoration requires access to the consolidation tracker, which is not currently in `DeleteMemoryDeps`:

```typescript
export interface DeleteMemoryDeps {
  memoryIndex: MemoryIndex;
  eventDispatcher: EventDispatcher;
  consolidationTracker?: ConsolidationTracker; // NEW — optional for backward compat
}

export interface DeleteMemoryResult {
  deleted: boolean;
  restoredSources: number; // 0 for non-insight deletions
}
```

---

## API Design

### `DELETE /api/v1/consolidation`

**Auth:** Bearer token (same as all API routes)
**Query params:** none
**Confirmation:** CLI prompts before calling; API has no built-in confirmation

**Success response (200):**
```json
{
  "status": "reset",
  "deleted_insights": 14,
  "restored_memories": 42,
  "tracker_backfilled": 275
}
```

**Error response (500):**
```json
{
  "error": "Consolidation reset failed: <reason>",
  "code": "RESET_FAILED"
}
```

### `DELETE /api/v1/memory/:id` (existing, enhanced response)

**Enhanced success response (200):**
```json
{
  "status": "deleted",
  "id": "ins-488d4e14",
  "restored_sources": 3
}
```

For non-insight deletions, `restored_sources` is `0` (or omitted).

---

## CLI Design

### `kore consolidation reset`

```
$ kore consolidation reset
This will delete all insights and return all memories to unconsolidated state.
Source memories will be preserved. Continue? (y/n) y

✓ Consolidation reset complete.
  Deleted insights:    14
  Restored memories:   42
  Tracker backfilled:  275
```

With `--force` flag, skips confirmation.
With `--json` flag, outputs raw JSON response.

### `kore delete <insight-id>` (existing, enhanced output)

```
$ kore delete ins-488d4e14
Delete memory ins-488d4e14? (y/n) y
✓ Deleted insight ins-488d4e14. 3 source memories restored to consolidation pool.
```

For non-insight deletions, output remains unchanged:
```
$ kore delete mem-abc123
Delete memory mem-abc123? (y/n) y
✓ Deleted memory mem-abc123.
```

---

## Implementation Plan

### New Files

| File | Description |
|------|-------------|
| `apps/core-api/src/consolidation-reset.ts` | `resetConsolidation()` function — core logic for Operation 1 |
| `apps/core-api/src/consolidation-reset.test.ts` | Unit tests for `resetConsolidation()` |
| `apps/cli/src/commands/consolidation-reset.ts` | CLI command for `kore consolidation reset` |

### Modified Files

| File | Change |
|------|--------|
| `apps/core-api/src/consolidation-tracker.ts` | Add `resetToPending(id)` method |
| `apps/core-api/src/delete-memory.ts` | Enhance `removeInsightRefFromSource()` for single-pass I/O; enhance `deleteMemoryById()` to restore sources and return `DeleteMemoryResult` |
| `apps/core-api/src/app.ts` | Add `DELETE /api/v1/consolidation` route; update delete response to include `restored_sources`; add consolidation loop handle + QMD fns to AppDeps |
| `apps/cli/src/commands/delete.ts` | Show restored source count for insight deletions |
| `apps/cli/src/index.ts` | Register `consolidation reset` subcommand |
| `apps/core-api/src/index.ts` | Pass QMD update fn and consolidation loop handle to app deps |

### Test Files

| File | Description |
|------|-------------|
| `apps/core-api/src/consolidation-reset.test.ts` | Unit tests for `resetConsolidation()` |
| `apps/core-api/src/consolidation-tracker.test.ts` | Add tests for `resetToPending()` |
| `apps/core-api/src/delete-memory.test.ts` | Add tests for single-pass source restoration on insight delete |

---

## Detailed Function Signatures

### `resetConsolidation()` — Core reset logic

```typescript
// consolidation-reset.ts

export interface ResetConsolidationDeps {
  dataPath: string;
  tracker: ConsolidationTracker;
  memoryIndex: MemoryIndex;
  qmdUpdate: () => Promise<{ indexed: number; updated: number }>;
}

export interface ResetConsolidationResult {
  deletedInsights: number;
  restoredMemories: number;   // non-insight memories whose frontmatter was cleaned
  trackerBackfilled: number;
}

export async function resetConsolidation(
  deps: ResetConsolidationDeps
): Promise<ResetConsolidationResult>
```

**Implementation outline:**

```typescript
export async function resetConsolidation(deps): Promise<ResetConsolidationResult> {
  const { dataPath, tracker, memoryIndex, qmdUpdate } = deps;
  const insightsDir = join(dataPath, "insights");

  // 1. Count insights before deletion
  let deletedInsights = 0;
  try {
    const files = await readdir(insightsDir);
    deletedInsights = files.filter(f => f.endsWith(".md")).length;
  } catch { /* dir may not exist */ }

  // 2. Clean ALL non-insight memory frontmatter (indiscriminate scan)
  let restoredMemories = 0;
  for (const [id, filePath] of memoryIndex.entries()) {
    if (filePath.includes("/insights/")) continue;
    const cleaned = await removeConsolidationFields(filePath);
    if (cleaned) restoredMemories++;
  }

  // 3. Delete insights directory
  await rm(insightsDir, { recursive: true, force: true });
  await mkdir(insightsDir, { recursive: true });

  // 4. Remove insight entries from memoryIndex
  const insightIds: string[] = [];
  for (const [id, filePath] of memoryIndex.entries()) {
    if (filePath.includes("/insights/")) insightIds.push(id);
  }
  for (const id of insightIds) memoryIndex.delete(id);

  // 5. Reset tracker and backfill
  tracker.truncateAll();
  let trackerBackfilled = 0;
  for (const [id, filePath] of memoryIndex.entries()) {
    const type = inferTypeFromPath(filePath);
    tracker.upsertMemory(id, type);
    trackerBackfilled++;
  }

  // 6. QMD re-index (update only, no embed — semantic content unchanged)
  await qmdUpdate();

  return { deletedInsights, restoredMemories, trackerBackfilled };
}
```

### `removeConsolidationFields()` — Strip consolidation frontmatter

```typescript
// consolidation-reset.ts

/**
 * Remove consolidated_at and insight_refs from a memory file's frontmatter.
 * Returns true if any fields were actually removed.
 */
async function removeConsolidationFields(filePath: string): Promise<boolean> {
  const content = await Bun.file(filePath).text();
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  let fm = fmMatch[1];
  let changed = false;

  // Remove consolidated_at line
  const newFm1 = fm.replace(/^consolidated_at:.*\n?/m, "");
  if (newFm1 !== fm) { fm = newFm1; changed = true; }

  // Remove insight_refs line
  const newFm2 = fm.replace(/^insight_refs:.*\n?/m, "");
  if (newFm2 !== fm) { fm = newFm2; changed = true; }

  if (!changed) return false;

  const updated = content.replace(fmMatch[0], `---\n${fm}\n---`);
  await Bun.write(filePath, updated);
  return true;
}
```

---

## Edge Cases

### 1. Insight supersession chains

If insight A was superseded by insight B, deleting B should:
- Remove B's `superseded_by` entry from A (if A still exists)
- A remains `retired` (it was superseded for a reason; re-consolidation will naturally produce a new insight)
- **Decision:** Do NOT un-retire superseded insights. They re-enter the pool organically via `reconcileOnStartup` if their sources support it.

### 2. Consolidation loop running during reset

The reset operation and the consolidation loop could race. The consolidation loop must be paused during reset.

**Approach:** Add a `pause()`/`resume()` method to the consolidation loop handle. The reset endpoint pauses the loop, performs the reset, then resumes.

```typescript
// In app.ts DELETE /api/v1/consolidation handler:
consolidationHandle?.pause();
try {
  const result = await resetConsolidation(deps);
  // ...
} finally {
  consolidationHandle?.resume();
}
```

### 3. Source memory was deleted after consolidation

During reset, some memories in memoryIndex may have been deleted from disk. `removeConsolidationFields()` will fail to read them — catch and skip silently.

During insight delete, some `source_ids` may reference memories no longer in memoryIndex. These are silently skipped — no frontmatter to clean up, no tracker entry to reset.

### 4. Partial failure during reset

If reset fails midway (e.g., filesystem error cleaning source frontmatter), the state may be inconsistent. The next `reconcileOnStartup` will correct tracker-to-filesystem mismatches. Stale `insight_refs` pointing to deleted insights are harmless.

**Decision:** Reset is not transactional. Log warnings for individual failures, continue with remaining work, report counts of what was successfully cleaned.

### 5. QMD re-index cost

Stripping `consolidated_at` and `insight_refs` from source files changes their file hashes. QMD `update()` will detect all touched source files as "modified" and re-index their metadata. For a knowledge base with 275 memories, this means all 275 files are re-indexed during the `update()` call.

However, the semantic content (body text, headings, distilled items) is unchanged, so we **skip `embed()`** — the existing embedding vectors remain valid. Only `update()` is needed to remove stale insight entries and refresh file metadata.

If QMD's `update()` triggers automatic re-embedding of modified files, the cost is acceptable for a reset operation (infrequent, user-initiated). This should be noted in the CLI help text.

---

## Example Workflows

### Workflow 1: Development iteration

```bash
# Consolidation produced low-quality insights during testing
$ kore consolidation reset --force
✓ Consolidation reset complete.
  Deleted insights:    14
  Restored memories:   42
  Tracker backfilled:  275

# Memories are preserved, re-consolidation starts automatically
# (or manually trigger with kore consolidate)
```

### Workflow 2: Remove a bad insight

```bash
# This insight merged unrelated memories due to the self-filter bug
$ kore delete ins-488d4e14
Delete memory ins-488d4e14? (y/n) y
✓ Deleted insight ins-488d4e14. 3 source memories restored to consolidation pool.

# Source memories will be picked up by the next consolidation cycle
```

### Workflow 3: Full system reset (existing)

```bash
# When you want to start completely fresh (memories + insights + everything)
$ kore reset
This will permanently delete all memories, tasks, and the search index. Continue? (y/n) y
✓ Reset complete. Deleted 289 memories and 0 tasks.
```

---

## Testing Strategy

### Unit Tests

**`consolidation-reset.test.ts`:**
- Reset deletes all insight files from disk
- Reset removes `consolidated_at` and `insight_refs` from ALL non-insight memory frontmatter (indiscriminate scan)
- Reset truncates tracker and backfills all memories as pending
- Reset removes insight entries from memoryIndex
- Reset handles missing/unreadable source files gracefully (skip, don't throw)
- Reset returns accurate counts
- Source with no consolidation fields is untouched (no unnecessary write)

**`consolidation-tracker.test.ts` (addition):**
- `resetToPending()` sets status to pending, clears consolidated_at, resets synthesis_attempts
- `resetToPending()` on non-existent ID is a no-op

**`delete-memory.test.ts` (addition):**
- Insight delete restores source tracker status to pending when insight_refs becomes empty
- Insight delete does NOT reset source when it still has other insight_refs
- Insight delete strips consolidated_at in same file write when insight_refs becomes empty
- `deleteMemoryById` returns `restoredSources` count
- Non-insight delete returns `restoredSources: 0`

### Integration Tests

**`e2e/consolidation/consolidation-reset.test.ts`:**
- Full cycle: ingest memories → consolidate → verify insights exist → reset → verify insights gone → verify sources restored → verify tracker is all pending

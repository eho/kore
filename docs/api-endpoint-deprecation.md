# REST API Endpoint Deprecation Plan

After MCP-003 (CLI Alignment), the shared operations module (`apps/core-api/src/operations/`) is the single source of business logic for all MCP tools and CLI commands. Four legacy REST endpoints in `apps/core-api/src/app.ts` contain inline duplicates of this logic and should be removed.

## Status

**Blocked on:** MCP-005 (Integration Tests) — remove after integration tests confirm the new endpoints work end-to-end.

## Endpoints to Remove

### 1. `POST /api/v1/search` → replaced by `POST /api/v1/recall`

The old search endpoint calls QMD directly with minimal post-processing. The new recall endpoint calls the `recall()` operation which adds:

- `distilled_items` extracted from each memory's Markdown
- Filters: `type`, `intent`, `tags`, `min_confidence`, `min_score`, `created_after`, `created_before`, `include_insights`
- Pagination via `offset` / `has_more`
- Automatic exclusion of retired insights
- Iterative QMD batching (batch size 50) to handle selective filters

**Current callers:** None. CLI `kore search` uses `/recall`. MCP calls `recall()` directly.

### 2. `GET /api/v1/memory/:id` → replaced by `GET /api/v1/inspect/:id`

The old endpoint calls an inline `parseMemoryFileFull()` (the copy in app.ts, not the shared one). The new endpoint calls the `inspect()` operation which adds:

- `distilled_items` parsed from the `## Distilled Memory Items` section
- Content truncation at 20,000 characters (prevents agent context overflow)
- Consolidation metadata: `consolidated_at`, `insight_refs`
- Full insight-specific fields: `source_ids`, `supersedes`, `superseded_by`, `reinforcement_count`

**Current callers:** None. CLI `kore show` uses `/inspect/:id`. MCP calls `inspect()` directly.

### 3. `POST /api/v1/ingest/raw` → replaced by `POST /api/v1/remember`

The old endpoint accepts `{ source, content, original_url, priority }`. The new endpoint calls the `remember()` operation which adds:

- `suggested_tags` — hints passed through to the extraction worker
- `suggested_category` — category hint for the extraction worker
- Field name change: `url` instead of `original_url`

**Current callers:** None. CLI `kore ingest` uses `/remember`. MCP calls `remember()` directly.

### 4. `GET /api/v1/memories` → replaced by `POST /api/v1/recall` (no query)

The old endpoint scans `memoryIndex.entries()` and returns a flat array of summaries. `POST /recall` with no `query` field does the same scan but through the `recall()` operation, which adds:

- All filter support (type, intent, tags, confidence, date range)
- Pagination via `offset` / `has_more`
- `distilled_items` per result
- Sorted by `date_saved` descending
- Retired insight exclusion

The trade-off: recall reads full file content per entry (slightly heavier), but with a max page size of 50 this is negligible.

**Current callers:** CLI `kore list` still uses `GET /memories`. Must be updated to use `POST /recall` before removal.

## Migration Steps

1. Update `kore list` command (`apps/cli/src/commands/list.ts`) to call `POST /api/v1/recall` with no query
2. Remove the 4 old endpoints from `apps/core-api/src/app.ts`
3. Remove the inline `parseMemoryFile()` and `parseMemoryFileFull()` functions from `app.ts` (the shared versions in `operations/inspect.ts` are the canonical copies)
4. Update `apps/core-api/src/app.test.ts` — remove or migrate tests that hit the old endpoints
5. Remove unused imports (`SearchRequestPayload`, `RawIngestPayload`, etc.)

## Endpoints That Stay

| Endpoint | Reason |
|---|---|
| `GET /api/v1/health` | Already operation-backed |
| `POST /api/v1/consolidate` | Already operation-backed |
| `GET /api/v1/task/:id` | Task status polling — no MCP equivalent |
| `POST /api/v1/ingest/structured` | Direct structured write (no queue) — different use case |
| `DELETE /api/v1/memory/:id` | Destructive op, not in MCP scope |
| `DELETE /api/v1/memories` | Full reset, not in MCP scope |
| `DELETE /api/v1/consolidation` | Consolidation reset, not in MCP scope |
| `PUT /api/v1/memory/:id` | Memory update, not in MCP scope |

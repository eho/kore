# PRD: Apple Notes Plugin (`plugin-apple-notes`)

## Introduction

Kore's first fully automated, passive ingestion source. The Apple Notes plugin runs a background sync loop inside the Kore server, using `@kore/an-export` to incrementally export Apple Notes to a staging directory, then diffs the export manifest against the Plugin Identity Registry to detect new, updated, and deleted notes. New/updated notes are transformed into LLM-ready content (with folder hierarchy as context) and enqueued for extraction. Deleted notes are removed from Kore's memory store. The plugin exposes API routes for status/manual sync and a `kore sync` CLI command.

**Architecture reference:** [apple_notes_integration_design.md](../docs/design/apple_notes_integration_design.md)

## Goals

- Automatically ingest new and modified Apple Notes without any user action
- Incrementally sync — only process changed notes, skip unchanged ones
- Handle note deletions — remove Kore memories when source notes are deleted in Apple Notes
- Use Apple Notes folder hierarchy as LLM context to improve extraction categorization
- Be strictly read-only against the Apple Notes database
- Handle failures gracefully (Full Disk Access revoked, locked notes, Ollama down)
- Provide visibility via API status endpoint and CLI commands

## User Stories

### ANOTE-001: Content builder

**Description:** As the sync loop, I need to transform an exported Apple Notes Markdown file into LLM-ready content so that the extraction pipeline receives clean, context-enriched text.

**Acceptance Criteria:**
- [ ] Create `packages/plugin-apple-notes/` with `package.json` (deps: `@kore/an-export`, `@kore/shared-types`)
- [ ] Implement `content-builder.ts` with `buildIngestContent(absoluteNotePath, relativeNotePath): Promise<string | null>`
- [ ] Extracts folder hierarchy from relative path (e.g., `notes/Work/Projects/Q1 Planning.md` → `Work / Projects`) and prepends as `Apple Notes Folder: Work / Projects`
- [ ] Extracts title from first `# heading` and prepends as `Title: ...`
- [ ] Strips local attachment image references (`![](../attachments/...)`) and replaces with `[Attachment: filename]`
- [ ] Preserves URL-based images, Markdown tables, and `[[internal links]]`
- [ ] Returns `null` for empty or unreadable files
- [ ] Enforces 8,000 character limit — truncates body (taking into account the length of the prepended header) and appends `[Content truncated for extraction]`
- [ ] Write unit tests covering: folder extraction, title extraction, attachment stripping, truncation, empty file handling, URL image preservation
- [ ] Typecheck passes

### ANOTE-002: Sync loop with manifest diffing and delete/update detection

**Description:** As the plugin, I need a background sync loop that calls `an-export`'s `syncNotes()` on an interval, diffs the resulting manifest against the Plugin Identity Registry, and enqueues new notes, re-processes updated notes, and deletes removed notes.

**Acceptance Criteria:**
- [ ] Add `listExternalKeys: () => Array<{ externalKey: string; memoryId: string; metadata?: string }>` to `PluginStartDeps` in `packages/shared-types/index.ts` and wire it in `apps/core-api/src/index.ts` plugin startup loop (calls `pluginRegistry.listByPlugin(plugin.name)`)
- [ ] Add optional `metadata` TEXT column to `plugin_key_registry` table in `plugin-registry.ts` (stores JSON, e.g. `{"mtime": 1234567890}`). Update `set()` to accept optional metadata param, `listByPlugin()` to return it
- [ ] Add unit test in `plugin-lifecycle.test.ts` verifying `listExternalKeys` is callable from the deps object and returns correct entries
- [ ] Implement `sync-loop.ts` with `startSyncLoop(deps, opts): { stop: () => void }`
- [ ] Calls `syncNotes()` from `@kore/an-export` targeting the staging directory (passing `omitFirstLine: false`, `includeTrashed: false`, and `includeHandwriting: opts.includeHandwriting`)
- [ ] After sync, loads `an-export-manifest.json` from the staging directory
- [ ] **New notes** (Z_PK in manifest but not in registry): builds content via `buildIngestContent`, enqueues with `source: "apple_notes"` and `priority: "low"`, stores `pending:{taskId}` in registry with `{"mtime": <manifest mtime>}` metadata
- [ ] **Pending notes** (registry value starts with `pending:`): skips (still waiting for worker)
- [ ] **Updated notes**: relies on `an-export`'s `syncNotes()` re-exporting only modified files — re-exported notes whose Z_PK is already resolved in the registry trigger delete of old memory + re-enqueue
- [ ] **Deleted notes** (Z_PK in registry via `listExternalKeys()` but not in manifest): calls `deps.deleteMemory()` and `deps.removeExternalKeyMapping()`
- [ ] Applies folder allowlist/blocklist filtering before processing
- [ ] Runs on configurable interval (default 15 minutes), with 10-second initial delay after start
- [ ] Catches and logs all errors without crashing — sync continues on next interval
- [ ] Guards against concurrent runs (skips if previous cycle still running)
- [ ] Write unit tests with mocked `syncNotes`, `deps`, and manifest data covering: new note detection, skip pending, delete detection, folder filtering, error resilience
- [ ] Typecheck passes

### ANOTE-003: Plugin entry point with `onMemoryIndexed` resolver

**Description:** As the Kore core engine, I need the `AppleNotesPlugin` class that implements `KorePlugin`, starts the sync loop, and resolves pending registry entries when extraction completes.

**Acceptance Criteria:**
- [ ] Implement `index.ts` exporting `AppleNotesPlugin` class implementing `KorePlugin`
- [ ] `start(deps)`: creates staging directories (`$KORE_HOME/staging/apple-notes/{notes,attachments}`), reads config from env vars (`KORE_AN_SYNC_INTERVAL_MS`, `KORE_AN_INCLUDE_HANDWRITING`, `KORE_AN_FOLDER_ALLOWLIST`, `KORE_AN_FOLDER_BLOCKLIST`), starts sync loop
- [ ] `stop()`: stops the sync loop
- [ ] `onMemoryIndexed(event)`: if `event.frontmatter.source === "apple_notes"` and `event.taskId` is present, scans registry via `listExternalKeys()` for a matching `pending:{taskId}` entry and resolves it by calling `deps.setExternalKeyMapping(externalKey, event.id)`
- [ ] Register plugin in `apps/core-api/src/index.ts` behind `KORE_APPLE_NOTES_ENABLED=true` guard (import and push to `plugins` array)
- [ ] Ensure `onMemoryIndexed` events are received by the plugin via `EventDispatcher` (event emitting is already implemented in `worker.ts`, registering the plugin is sufficient)
- [ ] Write unit tests for `onMemoryIndexed` resolution logic: matching pending entry resolved, non-matching source ignored, missing taskId ignored
- [ ] Typecheck passes

### ANOTE-004: API routes, CLI command, and integration test

**Description:** As a user, I want to check Apple Notes sync status and trigger a manual sync via both the API and CLI. As a developer, I need an integration test against the real test database to verify end-to-end correctness.

**Acceptance Criteria:**
- [ ] Plugin `routes` method mounts `GET /api/v1/plugins/apple-notes/status` returning: `{ enabled, last_sync_at, last_sync_result, total_tracked_notes, next_sync_in_seconds, staging_path }`
- [ ] Plugin `routes` method mounts `POST /api/v1/plugins/apple-notes/sync` returning `202` and triggering an immediate sync cycle
- [ ] Both routes require bearer token auth (consistent with existing Kore API routes)
- [ ] Add `sync` command to CLI (`apps/cli/src/commands/sync.ts`): `kore sync` POSTs to the sync endpoint, `kore sync --status` GETs the status endpoint
- [ ] Register sync command in `apps/cli/src/index.ts`
- [ ] Write unit test for status route response shape
- [ ] Add `KORE_AN_*` env vars to `.env.example` with comments
- [ ] Create integration test at `packages/plugin-apple-notes/__tests__/integration.test.ts` using copied database at `e2e/notes-testdata/group.com.apple.notes/` via `an-export`'s `dbDir` option (no Full Disk Access required)
- [ ] Integration test runs a full sync cycle: `syncNotes()` exports to a temp staging dir, content builder processes files, verifies output structure (folder prefix, title, body)
- [ ] Integration test verifies folder path extraction for nested folders and attachment reference stripping
- [ ] Integration test cleans up temp staging directory after completion
- [ ] Update [apple_notes_integration_design.md](../docs/design/apple_notes_integration_design.md) Phase 4 validation section to reference this test
- [ ] Typecheck passes

## Functional Requirements

- FR-1: The plugin must call `syncNotes()` from `@kore/an-export` on a configurable interval (default 15 min) to export Apple Notes to a staging directory at `$KORE_HOME/staging/apple-notes/`
- FR-2: After each sync, the plugin must diff `an-export-manifest.json` against the Plugin Identity Registry to classify each note as new, pending, updated, deleted, or unchanged
- FR-3: New notes must be transformed via the content builder (folder context + title + cleaned markdown) and enqueued with `source: "apple_notes"` and `priority: "low"`
- FR-4: Deleted notes (present in registry but absent from manifest) must have their Kore memory deleted and registry entry removed
- FR-5: Updated notes (re-exported by `an-export`) must have their old memory deleted and content re-enqueued for extraction
- FR-6: The plugin must resolve pending `pending:{taskId}` registry entries to real Kore UUIDs via the `onMemoryIndexed` hook using exact `taskId` matching
- FR-7: The content builder must enforce an 8,000 character limit on LLM input content
- FR-8: The content builder must strip local attachment image references and replace with `[Attachment: filename]`
- FR-9: Folder allowlist/blocklist must be configurable via `KORE_AN_FOLDER_ALLOWLIST` and `KORE_AN_FOLDER_BLOCKLIST` env vars
- FR-10: The plugin must never write to the Apple Notes database — strictly read-only
- FR-11: `GET /api/v1/plugins/apple-notes/status` must return sync status, tracked note count, and next sync time
- FR-12: `POST /api/v1/plugins/apple-notes/sync` must trigger an immediate sync cycle and return `202`
- FR-13: `kore sync` CLI command must trigger a manual sync; `kore sync --status` must show sync status

## Non-Goals

- No image/PDF/audio attachment processing (V1 is text-only; attachments replaced with placeholders)
- No real-time file system watching of the Notes database (polling interval is sufficient for V1)
- No writing to Apple Notes (permanently out of scope — Kore is read-only)
- No chunking of long notes into multiple memories (truncation only for V1)
- No content deduplication/hashing (can be added independently to the ingestion pipeline later)
- No shared notes special handling (treated same as personal notes; use blocklist to exclude)
- No handwriting OCR by default (opt-in via `KORE_AN_INCLUDE_HANDWRITING=true`)

## Technical Considerations

- **Dependency**: `@kore/an-export` is already implemented as a workspace package with `syncNotes()`, manifest diffing (`computeNoteSyncDecisions`), and full protobuf decoding
- **Manifest format**: `SyncManifest.notes` is `Record<number, ManifestNoteEntry>` — `Object.keys()` returns string keys, which are used as external keys in the Plugin Identity Registry
- **Staging directory**: `$KORE_HOME/staging/apple-notes/` is NOT indexed by QMD. It is only read by the plugin's content builder
- **Plugin scoping**: `PluginStartDeps` methods are scoped to the plugin name via closure in `core-api/src/index.ts` — the plugin never passes its own name
- **Event dispatching**: The worker emits `memory.indexed` events with `taskId` (already implemented at `worker.ts:129`). The `EventDispatcher` must route these to registered plugin `onMemoryIndexed` handlers
- **Test database**: Real Apple Notes SQLite database copied to `e2e/notes-testdata/group.com.apple.notes/` — use `an-export`'s `dbDir` option to point at it without requiring Full Disk Access
- **Configuration**: All via environment variables (`KORE_APPLE_NOTES_ENABLED`, `KORE_AN_SYNC_INTERVAL_MS`, `KORE_AN_INCLUDE_HANDWRITING`, `KORE_AN_FOLDER_ALLOWLIST`, `KORE_AN_FOLDER_BLOCKLIST`)

## Success Metrics

- A full sync cycle completes without errors against the test database
- New notes appear as Kore memory files with correct type, category, and tags (informed by folder context)
- Deleting a note from Apple Notes results in its Kore memory being removed on the next sync cycle
- The sync loop runs continuously in the background without crashing the core server
- `kore sync --status` reports accurate sync state

## Resolved Questions

- **mtime storage**: Yes — store mtime as JSON metadata in the registry alongside each mapping. Cheap to add now, enables V2 mtime-based update detection later.
- **Filtered note tracking**: No — not needed for V1 status reporting.
- **Unblocked folder behavior**: Handled automatically. `syncNotes()` exports all notes regardless of Kore's allowlist/blocklist. Filtering happens in the sync loop before enqueuing. When a folder is unblocked, its notes appear as "new" (Z_PK in manifest, not in registry) on the next cycle and get enqueued normally.

# PRD: Plugin Infrastructure (Track C1–C4)

## Introduction

Kore's `KorePlugin` interface currently supports only passive event hooks (`onMemoryIndexed`, `onMemoryDeleted`, `onMemoryUpdated`) and route injection. It has no mechanism for plugins to run background work, enqueue tasks, delete memories, or track mappings between external IDs and Kore memory IDs. This PRD specifies the infrastructure required to support active plugins — starting with the Apple Notes integration (Track D) as the first consumer.

The scope covers: lifecycle methods (`start`/`stop`), a `PluginStartDeps` dependency injection interface, a SQLite-backed plugin identity registry, `task_id` propagation through the worker into `MemoryEvent`, and a minimal test plugin to validate the infrastructure end-to-end.

## Goals

- Enable plugins to run background work (timers, file watchers) with proper startup/shutdown lifecycle
- Give plugins controlled access to core capabilities (enqueue tasks, delete memories) without coupling to internals
- Provide a plugin-scoped identity registry so plugins can track `externalKey → koreMemoryId` mappings
- Propagate `task_id` through the extraction pipeline so plugins can correlate enqueued tasks with resulting memories
- Fix the gap where `memory.indexed` events are never emitted by the worker
- Validate the entire infrastructure with a minimal test plugin

## User Stories

### PLUG-001: Plugin type definitions (`KorePlugin` lifecycle, `PluginStartDeps`, `MemoryEvent.taskId`)

**Description:** As a plugin author, I want well-typed interfaces for plugin lifecycle, dependency injection, and event payloads so I can build plugins against a stable contract.

**Acceptance Criteria:**
- [ ] `KorePlugin` interface in `packages/shared-types/index.ts` gains optional `start?: (deps: PluginStartDeps) => Promise<void>` method
- [ ] `KorePlugin` interface gains optional `stop?: () => Promise<void>` method
- [ ] Both methods are optional — existing plugin shapes (hooks-only) remain valid without changes
- [ ] `PluginStartDeps` interface defined in `packages/shared-types/index.ts` with the following methods:
  - `enqueue(payload: { source: string; content: string; original_url?: string }, priority?: "low" | "normal" | "high") => string` — synchronous, returns task ID (wraps `bun:sqlite` sync call)
  - `deleteMemory(id: string) => Promise<boolean>` — async (file I/O), returns true if deleted
  - `getMemoryIdByExternalKey(externalKey: string) => string | undefined` — synchronous (`bun:sqlite`)
  - `setExternalKeyMapping(externalKey: string, memoryId: string) => void` — synchronous (`bun:sqlite`)
  - `removeExternalKeyMapping(externalKey: string) => void` — synchronous (`bun:sqlite`)
  - `clearRegistry() => void` — synchronous (`bun:sqlite`), removes all mappings for the calling plugin
- [ ] Note: `deleteMemory` is the only async method. All registry and enqueue methods are synchronous, matching `bun:sqlite` patterns used by `QueueRepository`
- [ ] Registry methods are plugin-scoped (the `pluginName` is captured in the closure when building deps, not passed per-call)
- [ ] `MemoryEvent` in `packages/shared-types/index.ts` gains optional field `taskId?: string`
- [ ] Typecheck passes (`bun run typecheck` or `bunx tsc --noEmit` across workspace)
- [ ] Write unit tests verifying that a plugin without `start`/`stop` still satisfies the `KorePlugin` interface

### PLUG-002: Plugin key registry repository

**Description:** As a core-api developer, I need a persistent store for plugin external-key-to-memory-ID mappings so that plugins can survive restarts and correlate external entities with Kore memories.

**Acceptance Criteria:**
- [ ] New table created in `kore-queue.db` (reuse existing database, not a new file):
  ```sql
  CREATE TABLE IF NOT EXISTS plugin_key_registry (
    plugin_name TEXT NOT NULL,
    external_key TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (plugin_name, external_key)
  );
  ```
- [ ] New `PluginRegistryRepository` class in `apps/core-api/src/plugin-registry.ts` that accepts the same `Database` instance used by `QueueRepository`
- [ ] Repository exposes methods: `get(pluginName, externalKey)`, `set(pluginName, externalKey, memoryId)`, `remove(pluginName, externalKey)`, `clear(pluginName)`, `listByPlugin(pluginName)`
- [ ] All methods are synchronous (using `bun:sqlite` synchronous API, consistent with `QueueRepository`)
- [ ] Typecheck passes
- [ ] Write unit tests covering: set/get/remove/clear operations, plugin scoping (plugin A cannot see plugin B's keys), upsert behavior on duplicate key, clear removes only the specified plugin's entries

### PLUG-003: Worker `memory.indexed` emission + core-api startup wiring

**Description:** As a core-api developer, I need the worker to emit `memory.indexed` events with `taskId`, and the startup sequence to initialize plugins with their dependencies and register them with the event dispatcher, so the full plugin lifecycle works end-to-end.

**Acceptance Criteria:**
- [ ] Worker in `apps/core-api/src/worker.ts` emits `memory.indexed` event via `EventDispatcher` after successfully writing a memory file, with `taskId` set to the dequeued task's ID
- [ ] `WorkerDeps` interface gains `dispatcher: EventDispatcher` so the worker can emit events
- [ ] `memory.indexed` event payload includes: `id` (new memory UUID), `filePath`, `frontmatter`, `timestamp`, and `taskId`
- [ ] Worker does NOT emit event on extraction failure
- [ ] Existing `memory.deleted` and `memory.updated` events in `app.ts` continue to work unchanged
- [ ] Extract `deleteMemoryById()` from `app.ts` route handler into a shared function so both the API route and `PluginStartDeps` can use it without duplication
- [ ] `apps/core-api/src/index.ts` updated to:
  1. Import plugin modules explicitly (code-driven, not config-driven)
  2. Create `PluginRegistryRepository` from the same database instance as `QueueRepository`
  3. Build `PluginStartDeps` for each plugin (wrapping `QueueRepository.enqueue`, `deleteMemoryById`, and `PluginRegistryRepository` — registry methods scoped by plugin name via closure)
  4. Call `plugin.start(deps)` for each plugin that has a `start` method (after QMD init, before worker start)
  5. Register all plugins with `EventDispatcher.registerPlugins()`
  6. Pass `EventDispatcher` to worker via `WorkerDeps`
  7. Call `plugin.stop()` for each plugin during graceful shutdown (before database close)
- [ ] Plugin start is non-blocking — errors in one plugin's `start()` are logged but do not prevent other plugins or the server from starting
- [ ] Plugin stop is graceful — each plugin's `stop()` is wrapped in `Promise.race` with a 5-second timeout. If a plugin's `stop()` exceeds the timeout, log a warning and continue shutting down remaining plugins
- [ ] Typecheck passes
- [ ] Write unit tests verifying:
  - Worker emits `memory.indexed` after successful extraction with correct `taskId`
  - Worker does NOT emit event on extraction failure
  - Plugins with `start()` have it called during boot
  - Plugins without `start()` are skipped gracefully
  - Plugin `stop()` is called during shutdown
  - A failing plugin `start()` does not crash the server

### PLUG-004: Test plugin for end-to-end validation

**Description:** As a developer, I want a minimal test plugin that exercises all infrastructure pieces so we can verify the end-to-end flow works before building Apple Notes.

**Acceptance Criteria:**
- [ ] New package `packages/plugin-test/` with:
  - `index.ts` — exports a `KorePlugin` that:
    - Has a `name: "test-plugin"`
    - `start(deps)`: logs startup, stores deps reference
    - `stop()`: logs shutdown
    - `onMemoryIndexed(event)`: logs event, records `taskId` mapping via `deps.setExternalKeyMapping()`
  - `package.json` with `@kore/shared-types` dependency
- [ ] The test plugin is imported and registered in `index.ts` **only** when `KORE_TEST_PLUGIN=true` env var is set (not in production by default)
- [ ] An integration test in `packages/plugin-test/__tests__/` that:
  1. Starts core-api with test plugin enabled
  2. POSTs to `/api/v1/ingest/raw` with test content
  3. Waits for worker to process the task
  4. Verifies `onMemoryIndexed` was called with a valid `taskId`
  5. Verifies the external key mapping was persisted in `plugin_key_registry`
- [ ] Typecheck passes
- [ ] Test passes with `bun test`

## Functional Requirements

- FR-1: `KorePlugin.start(deps)` is called once per plugin during server startup, after QMD initialization, before the worker begins polling
- FR-2: `KorePlugin.stop()` is called once per plugin during graceful shutdown, before databases are closed
- FR-3: `PluginStartDeps.enqueue()` wraps `QueueRepository.enqueue()` and supports `"low" | "normal" | "high"` priority
- FR-4: `PluginStartDeps.deleteMemory()` deletes the memory file from disk, removes from `MemoryIndex`, and emits `memory.deleted` event
- FR-5: `PluginStartDeps.clearRegistry()` removes all key mappings for the calling plugin
- FR-6: Identity registry methods are scoped by `pluginName` — a plugin cannot read or modify another plugin's mappings
- FR-7: The `plugin_key_registry` table persists across server restarts (stored in `kore-queue.db`)
- FR-8: Worker emits `memory.indexed` event with `taskId` after every successful extraction and file write
- FR-9: Plugin registration is code-driven — each plugin is explicitly imported in `index.ts`
- FR-10: A plugin's `start()` failure is logged but does not prevent other plugins or the server from starting

## Non-Goals

- Config-driven or dynamic plugin discovery (no scanning directories or reading plugin lists from env vars)
- Plugin hot-reload or runtime registration/deregistration
- Plugin dependency ordering (plugins are independent; if ordering is needed later, it's a separate concern)
- Plugin-to-plugin communication
- UI for plugin management
- Versioning or compatibility checks for the plugin interface
- Any Apple Notes-specific logic (that's Track D / a separate PRD)

## Technical Considerations

- **Database:** Reuse `kore-queue.db` for the `plugin_key_registry` table. This avoids creating another database file and keeps all queue/plugin state together. The `PluginRegistryRepository` can share the same `Database` instance.
- **Synchronous SQLite:** `bun:sqlite` is synchronous. Registry methods should be synchronous to match `QueueRepository` patterns.
- **Event dispatcher threading:** `EventDispatcher.emit()` already catches and logs errors per-plugin. This fail-safe behavior must be preserved.
- **Worker modification:** The worker currently has no reference to `EventDispatcher`. Adding it to `WorkerDeps` is the minimal change. The worker already has access to `id`, `filePath`, and `frontmatter` at the point where it would emit.
- **Memory deletion in PluginStartDeps:** The delete logic currently lives in the `app.ts` route handler. It should be extracted into a shared function (e.g., `deleteMemoryById()` in a new or existing module) so both the API route and `PluginStartDeps` can use it without duplication.
- **Existing tests:** `apps/core-api/src/__tests__/memory.test.ts` has test coverage for events. New tests should follow the same patterns (mock dispatcher, verify emit calls).

## Success Metrics

- All 4 user stories pass acceptance criteria and tests
- The test plugin (PLUG-004) demonstrates end-to-end flow: enqueue → extract → `memory.indexed` event → external key mapping persisted
- No regressions in existing tests (`bun test` passes across workspace)
- Apple Notes plugin (Track D) can be built entirely against `PluginStartDeps` without importing any core-api internals

## Open Questions

- Q1: Should `PluginStartDeps` expose read access to existing memories (e.g., `getMemory(id)`)? Not needed for Apple Notes but could be useful for future plugins. **Recommendation:** Defer until a concrete need arises.
- Q2: Should the `plugin_key_registry` store additional metadata (e.g., content hash for deduplication)? The Apple Notes design doc mentions content hashing as deferred. **Recommendation:** Keep the table minimal now; add columns later if needed.
- Q3: Should `PluginStartDeps.deleteMemory()` also trigger QMD re-indexing? The current delete route doesn't explicitly trigger QMD removal (relies on the file watcher). **Recommendation:** Match existing behavior — delete file, let watcher handle QMD.

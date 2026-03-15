# Progress: Kore MVP

## US-001: Implement Shared Zod Type Definitions — COMPLETED
- Created `packages/shared-types/` with `package.json` (main: `index.ts`), `zod` dependency, `elysia` dev dependency.
- Implemented `MemoryTypeEnum` with exactly `["place", "media", "note", "person"]`.
- Implemented `BaseFrontmatterSchema` matching `docs/architecture/data_schema.md` §3.1 (id uuid, type enum, category qmd://, date_saved datetime, source string, tags max 5, url optional).
- Implemented `MemoryExtractionSchema` matching §3.2 (title, distilled_items 1-7, qmd_category starting with qmd://, type enum, tags max 5 lowercase kebab-case with regex validation).
- Exported `IngestionContext`, `EnrichmentResult`, `MemoryEvent` interfaces per `docs/architecture/plugin_system.md` §2.
- Exported `KorePlugin` interface per `docs/architecture/plugin_system.md` §1.
- Typecheck passes.
- 19 unit tests covering: valid/invalid enum values, uuid validation, qmd:// prefix enforcement, datetime validation, tag count limits, kebab-case tag validation, distilled_items min/max, url validation.
- **Review Sign-off:** Reviewed US-001. Requirements, type-checks, and tests perfectly align with PRD.

## US-002: Stand Up ElysiaJS API Server — COMPLETED
- Initialized `apps/core-api` as a Bun application with `package.json` (deps: elysia, @elysiajs/bearer, @elysiajs/cors, zod, @kore/shared-types).
- Set up Elysia app on port 3000 with `@elysiajs/bearer` and `@elysiajs/cors` plugins.
- Created `.env.example` at project root with `KORE_DATA_PATH`, `KORE_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`.
- Implemented `GET /api/v1/health` returning `{ status, version, qmd_status, queue_length }` per `api_design.md` §2.1. `qmd_status` defaults to `"unavailable"`. `queue_length` queries actual SQLite queue.
- Implemented `POST /api/v1/ingest/raw` with Zod validation (source, content, original_url?, priority). Enqueues to SQLite queue, returns `202 Accepted` with `task_id`.
- Implemented `GET /api/v1/task/:id` returning task status from queue DB, or `404` with `NOT_FOUND` code.
- Implemented `POST /api/v1/ingest/structured` bypassing LLM extraction: validates payload, generates UUIDv4, renders canonical `.md` file to disk, returns `200` with `{ status: "indexed", file_path }`.
- On startup, auto-creates `$KORE_DATA_PATH` subdirectories (`places/`, `media/`, `notes/`, `people/`).
- Bearer token auth rejects requests missing valid `KORE_API_KEY` (health endpoint exempt).
- File naming follows `data_schema.md` §1.1 slugify algorithm with collision handling (4-char UUID hash suffix).
- Created `QueueRepository` (SQLite with WAL mode) supporting `enqueue()`, `getTask()`, `getQueueLength()` — foundational for US-003.
- Created `renderMarkdown()` utility producing canonical template per `data_schema.md` §2.
- Created `slugify()` utility per `data_schema.md` §1.1 naming convention.
- App factory pattern (`createApp(deps)`) enables dependency injection for testing.
- 16 unit tests covering: health endpoint, qmd_status values, auth rejection (no/wrong token), raw ingest (valid/invalid/priority default), task status (found/not found), structured ingest (file creation, collision handling, type routing, invalid payload, invalid category), data directory creation.
- **Review Sign-off:** Reviewed US-002. All endpoints functionally correct with 100% test passing. Directory auto-creation via `app.ts/index.ts` verified.

## US-003: Implement SQLite Background Queue — COMPLETED
- Expanded `QueueRepository` in `apps/core-api/src/queue.ts` with full queue worker support.
- Implemented `dequeueAndLock()` using explicit SQLite transactions for atomic select+update. Respects priority ordering (`high` > `normal` > `low`), then FIFO within same priority via `created_at ASC`.
- Implemented `markCompleted(id)` setting status to `completed` with updated timestamp.
- Implemented `markFailed(id, errorMessage)` with retry logic: increments `retries`, re-queues if under `MAX_RETRIES` (3), permanently sets `failed` status after 3 attempts. Error message stored in `error_log`.
- Implemented `cleanupOldTasks(daysToKeep)` deleting completed/failed tasks older than N days via `DELETE FROM tasks WHERE status IN ('completed', 'failed') AND updated_at < datetime(...)`.
- Implemented `recoverStaleTasks()` resetting `processing` tasks with `updated_at` older than 10 minutes back to `queued` (stale task recovery on worker startup).
- Exported `MAX_RETRIES` (3) and `STALE_TASK_MINUTES` (10) constants.
- SQLite WAL mode and table schema unchanged from US-002 (already correct per PRD spec).
- 24 unit tests in `apps/core-api/src/queue.test.ts` covering: enqueue (status, priority, payload serialization), dequeueAndLock (empty queue, status transition, no double-dequeue, priority ordering, FIFO within priority), markCompleted (status + timestamp update), markFailed (re-queue on first/second failure, permanent failure at MAX_RETRIES, failed tasks not re-dequeued), cleanupOldTasks (old completed/failed removed, recent kept, queued/processing untouched), recoverStaleTasks (stale reset, recent untouched, non-processing unaffected), getQueueLength (empty, counts only queued).
- **Review Sign-off:** Reviewed US-003. SQLite transactions are utilized properly for locking. Tests demonstrate that `dequeueAndLock` respects priorities, and retries limit properly at MAX_RETRIES. Perfect alignment with PRD.

## US-004: Implement Local LLM Extraction Worker — COMPLETED
- Created `apps/core-api/src/worker.ts` with background extraction worker loop.
- Created stub `packages/llm-extractor` package with `extract(rawText, source)` function signature (full implementation deferred to US-007).
- `startWorker(deps)` initializes with stale task recovery, then polls `dequeueAndLock()` at configurable interval (default 5s).
- `pollOnce(deps)` dequeues a task, calls `extract()` from `@kore/llm-extractor` (injectable via `extractFn` for testing), validates output against `MemoryExtractionSchema`, and writes canonical `.md` file to disk.
- File output written to `$KORE_DATA_PATH/[type]/[slugified_title].md` with collision-safe 4-char UUID hash suffix, conforming to canonical template (data_schema.md §2): YAML frontmatter, `# Title`, `## Distilled Memory Items`, `---`, `## Raw Source`.
- Includes `original_url` in frontmatter `url` field when present in task payload.
- On extraction/validation failure, calls `markFailed()` which leverages existing retry logic (re-queue up to MAX_RETRIES=3, then permanent failure).
- Periodic cleanup job runs hourly calling `cleanupOldTasks(7)`.
- Updated `apps/core-api/src/index.ts` to start worker alongside API server with shared `QueueRepository` instance.
- Added `@kore/llm-extractor` as workspace dependency in `apps/core-api/package.json`.
- 12 tests in `apps/core-api/src/worker.test.ts`: empty queue returns false, task processing writes .md file, canonical format verification (frontmatter fields + sections), original_url in frontmatter, extraction error marks failed with retry, permanent failure after MAX_RETRIES, schema validation failure (empty distilled_items), file collision handling (hash suffix), type directory routing (note → notes/), stale task recovery on startup, stop() halts polling, E2E integration test (POST /ingest/raw → pollOnce → .md file + task status via API).
- **Review Sign-off:** Reviewed US-004. Worker properly implements dequeue+LLM extract+MD file generation loop. `llm-extractor` stub matches expectations, canonical file formats strictly enforced, and integration testing beautifully covers E2E flow.

## US-005: Setup File Watcher & QMD Update Strategy — COMPLETED
- Created stub `packages/qmd-client` package with `update()`, `collectionAdd()`, and `status()` function signatures (full implementation deferred to US-008).
- Implemented `apps/core-api/src/watcher.ts` using `fs.watch` with `{ recursive: true }` targeting `$KORE_DATA_PATH`.
- Watcher filters for `.md` file changes only, ignoring non-markdown files.
- Debounce logic waits configurable duration (default 2s) after last write event before calling `qmdClient.update()`.
- Debounce timer resets on each new change, coalescing rapid writes into a single update call.
- Handles `updateFn` failures and exceptions gracefully (logs errors, does not crash).
- `stop()` method clears the debounce timer and closes the `FSWatcher`.
- Decoupling enforced: API server and LLM worker never call QMD directly — only the watcher does.
- Updated `apps/core-api/src/index.ts` to start watcher alongside API server and worker.
- Added `@kore/qmd-client` as workspace dependency in `apps/core-api/package.json`.
- Created `apps/core-api/README.md` with setup instructions, environment config, and startup commands (`bun run start` runs API, Worker, and Watcher concurrently).
- 8 unit tests in `apps/core-api/src/watcher.test.ts` covering: update on .md write, ignoring non-.md files, debouncing rapid changes into single call, debounce timer reset, stop() prevents callbacks, graceful failure handling (error result), graceful exception handling (throw), subdirectory change detection.
- All 268 tests pass across 17 files (0 failures).
- **Review Sign-off:** Reviewed US-005. The `watcher.ts` perfectly implements a 2s debounced `fs.watch` that calls the `qmd-client` stub. Cleanly decoupled from the API. Unit tests and README match PRD accurately.

## US-006: Implement Memory Management Endpoints (CRUD) — COMPLETED
- Created `apps/core-api/src/event-dispatcher.ts`: `EventDispatcher` class dispatching `memory.deleted`, `memory.updated`, and `memory.indexed` plugin lifecycle events. Plugin errors are caught and logged without crashing the core engine (plugin_system.md §4.3).
- Created `apps/core-api/src/memory-index.ts`: `MemoryIndex` class maintaining an in-memory `Map<id, filePath>` index. Builds by scanning all `.md` files in `$KORE_DATA_PATH` subdirectories on startup, parsing `id` from YAML frontmatter. Provides `get()`, `set()`, `delete()` for O(1) lookups.
- Implemented `DELETE /api/v1/memory/:id`: Looks up file via `MemoryIndex`, reads frontmatter for event payload, deletes the file from disk, removes from index, emits `memory.deleted` event, returns `200 OK` with `{ status: "deleted", id }`. Returns `404` if memory not found.
- Implemented `PUT /api/v1/memory/:id`: Looks up existing file via `MemoryIndex`, validates payload against `StructuredIngestPayload` schema, renders updated canonical `.md` file, deletes old file if path changed (type/title change), updates index, emits `memory.updated` event, returns `200 OK` with `{ status: "updated", id, file_path }`. Returns `404` if not found, `400` on invalid payload.
- Both endpoints use the `id` from the route parameter, not the payload.
- Updated `apps/core-api/src/index.ts` to build `MemoryIndex` and create `EventDispatcher` on startup, injecting both into the app factory.
- 12 unit tests in `apps/core-api/src/memory.test.ts` covering: DELETE removes file (200), DELETE unknown id (404), DELETE removes from index, DELETE emits memory.deleted event, PUT updates file (200 with new content verified), PUT unknown id (404), PUT invalid payload (400 VALIDATION_ERROR), PUT emits memory.updated event, PUT updates index with new path on type/title change, MemoryIndex.build() scans .md files from disk, EventDispatcher dispatches to plugins, EventDispatcher handles plugin errors gracefully.
- All 280 tests pass across 18 files (0 failures).
- **Review Sign-off:** Reviewed US-006. In-memory `MemoryIndex` avoids O(n) scans per request during CRUD. `DELETE` and `PUT` strictly conform strictly to schemas and dispatch events via `EventDispatcher` accurately. Unit tests successfully exercise all cases perfectly.

## US-007: Implement `packages/llm-extractor` Module — COMPLETED
- Replaced stub implementation in `packages/llm-extractor/index.ts` with full Vercel AI SDK integration.
- Installed `ai` (Vercel AI SDK) and `@ai-sdk/openai` as dependencies in `packages/llm-extractor/package.json`.
- Configured provider using `createOpenAI()` pointed at `$OLLAMA_BASE_URL` (default `http://localhost:11434/v1`). Model read from `$OLLAMA_MODEL` (default `qwen2.5:7b`).
- Exported `extract(rawText, source)` function using `generateText()` with `Output.object({ schema: MemoryExtractionSchema })` for structured JSON output enforcement.
- System prompt includes all 7 allowed QMD top-level semantic roots (`qmd://tech/`, `qmd://travel/`, `qmd://health/`, `qmd://finance/`, `qmd://media/`, `qmd://personal/`, `qmd://admin/`) per `data_schema.md` §4.
- System prompt includes one few-shot example (Mutekiya Ramen) demonstrating expected JSON output shape.
- Implemented `fallbackParse(text)` function: when `generateText()` with structured output fails, a secondary plain-text `generateText()` call is made, and the response is parsed by extracting JSON via regex and validating against `MemoryExtractionSchema`.
- Exported `fallbackParse` for direct testing.
- 19 unit tests in `packages/llm-extractor/index.test.ts` covering: fallbackParse with clean JSON, embedded JSON in text, no JSON found, malformed JSON, missing required fields, invalid enum, empty distilled_items, tags exceeding max, invalid qmd_category prefix, non-kebab-case tags; extract with mocked generateObject (successful extraction, schema validation, invalid enum, non-kebab-case tags, missing qmd:// prefix); fallback parse success/failure scenarios.
- All 299 tests pass across 19 files (0 failures).
- **Review Sign-off:** Reviewed US-007. Implements Vercel AI SDK gracefully. Fallback text parsing is an excellent stability addition when Ollama returns malformed JSON. The system prompt incorporates the QMD schema structure (categories/tags) strictly. Tested thoroughly with 19 passing unit tests.

## US-008: Implement `packages/qmd-client` Module — COMPLETED
- Replaced stub implementation in `packages/qmd-client/index.ts` with full `Bun.spawn` integration.
- Implemented `update()` wrapping `qmd update` CLI command via `Bun.spawn`, returning typed `QmdCommandResult`.
- Implemented `collectionAdd(path, name)` wrapping `qmd collection add <path> --name <name>`, returning typed `QmdCommandResult`.
- Implemented `status()` wrapping `qmd status`, returning typed `QmdStatusResult` (`{ online: boolean, error?: string }`).
- All three methods handle `Bun.spawn` failures gracefully: non-zero exit codes return typed error results with stderr message (or exit code fallback), and spawn exceptions (e.g., binary not found) are caught and returned as typed errors rather than unhandled exceptions.
- Exported `SpawnFn` type and `setSpawn()` function for dependency injection in tests, with automatic restore support.
- Exported existing `QmdStatusResult` and `QmdCommandResult` interfaces (unchanged from stub — consumers like watcher.ts and app.ts remain compatible).
- 12 unit tests in `packages/qmd-client/index.test.ts` covering: update() success + correct CLI args, update() non-zero exit (stderr message), update() non-zero exit (empty stderr fallback), update() spawn failure; collectionAdd() success + correct CLI args, collectionAdd() non-zero exit, collectionAdd() whitespace-only stderr fallback, collectionAdd() spawn failure; status() success + online, status() non-zero exit (offline + error), status() exit code fallback, status() spawn failure (binary not found).
- Typecheck passes. All 315 tests pass across 20 files (0 failures).
- **Review Sign-off:** Reviewed US-008. `Bun.spawn` implementation elegantly wraps the QMD CLI with clean typed outputs (`QmdCommandResult` & `QmdStatusResult`). The test suite correctly exercises CLI arguments and handles uninstalled / offline CLI binary cases gracefully.

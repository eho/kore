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

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

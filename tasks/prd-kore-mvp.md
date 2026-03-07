# PRD: Kore MVP (Minimum Viable Product)

## 1. Introduction/Overview
Kore is a "Context-Aware Personal Memory Engine." It solves the "Recall Disconnect" by passively ingesting explicit user saves (like Apple Notes or browser bookmarks), distilling them into atomic "Memory Items" using local LLMs, and indexing them using **QMD** (Query Markup Documents) for agentic retrieval via the Model Context Protocol (MCP). 

This PRD outlines the requirements for the initial **MVP (Minimum Viable Product)** implementation of the Kore Core Engine. It focuses on establishing the secure, file-system-first storage architecture, the ElysiaJS REST API, the SQLite-backed background extraction queue, the integration with QMD (via a typed client wrapper and file watchers), and the execution of a local LLM pipeline via Ollama using the Vercel AI SDK.

## 2. Goals
- **G-1: Solidify Data Foundation:** Implement the `packages/shared-types` module defining the canonical Zod schema (`BaseFrontmatterSchema`, `MemoryExtractionSchema`) that all future components will share.
- **G-2: Establish Ingestion Pipeline:** Expose an ElysiaJS API that accepts raw text payloads, validates them, and pushes them safely into a persistent background queue.
- **G-3: Enable Completely Local Extraction:** Implement a background worker that fetches from the queue, passes the text to a local Ollama model (via Vercel AI SDK) to extract structured metadata, and outputs a standardized Markdown file with YAML Frontmatter.
- **G-4: Enable Agentic Search:** Establish the file-watching pattern where QMD automatically tracks and indexes the generated output directory, using a typed QMD client wrapper.

## 3. User Stories

### US-001: Implement Shared Zod Type Definitions
**Description:** As a developer, I want a single source of truth for the data structure so that the API, LLM extractors, and future ingesters stay in sync without duplication.
**Acceptance Criteria:**
- [ ] Initialize `packages/shared-types` with a `package.json` exposing `"main": "index.ts"`.
- [ ] Implement `MemoryTypeEnum` containing exactly: `["place", "media", "note", "person"]`.
- [ ] Implement `BaseFrontmatterSchema` with fields: `id` (uuid), `type` (enum), `category` (string starting with `"qmd://"`), `date_saved` (iso datetime), `source` (string), `tags` (array of max 5 strings), and `url` (optional url string). Schema must match the definition in `docs/architecture/data_schema.md` §3.1.
- [ ] Implement `MemoryExtractionSchema` for LLM output enforcing: `title` (string), `distilled_items` (array of 1-7 strings), `qmd_category` (string starting with `"qmd://"`), `type` (enum), and `tags` (array of max 5 lowercase kebab-case strings). Schema must match the definition in `docs/architecture/data_schema.md` §3.2.
- [ ] Export the `IngestionContext`, `EnrichmentResult`, and `MemoryEvent` interfaces as defined in `docs/architecture/plugin_system.md` §2. These are needed by future plugin consumers but must be defined centrally now.
- [ ] Typecheck and linting pass across the workspace.
- [ ] **[Logic/Backend]** Write unit tests demonstrating successful validation and failure on invalid payloads (e.g., more than 5 tags, category not starting with `qmd://`, invalid enum values).

### US-002: Stand Up ElysiaJS API Server
**Description:** As a system integrating a new data source, I want a standardized REST endpoint to send raw data so it can be handled safely without blocking my request.
**Acceptance Criteria:**
- [ ] Initialize `apps/core-api` as a Bun application.
- [ ] Set up Elysia app on port 3000 utilizing the `@elysiajs/bearer` and `@elysiajs/cors` plugins.
- [ ] Create a `.env.example` file in the project root with the following required keys and defaults:
  ```
  KORE_DATA_PATH=~/kore-data
  KORE_API_KEY=
  OLLAMA_BASE_URL=http://localhost:11434
  OLLAMA_MODEL=qwen2.5:7b
  ```
- [ ] Define `GET /api/v1/health` returning a response matching `docs/architecture/api_design.md` §2.1:
  ```json
  { "status": "ok", "version": "1.0.0", "qmd_status": "online", "queue_length": 0 }
  ```
  `qmd_status` may return `"unavailable"` if QMD is not running. `queue_length` must query the actual queue.
- [ ] Define `POST /api/v1/ingest/raw`. Payload Zod schema:
  ```typescript
  z.object({
    source: z.string(),
    content: z.string(),
    original_url: z.string().url().optional(),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  })
  ```
- [ ] The `/ingest/raw` endpoint must accept the payload, validate it against the Zod schema, enqueue it (mocked for this story), and return `202 Accepted` with a generated `task_id`.
- [ ] Define `POST /api/v1/ingest/structured` to bypass LLM extraction. Payload Zod schema as defined in `docs/architecture/api_design.md` §3.2:
  ```typescript
  z.object({
    content: z.object({
      title: z.string(),
      markdown_body: z.string(),
      frontmatter: BaseFrontmatterSchema.omit({ id: true }),
    }),
  })
  ```
  The endpoint must generate a UUIDv4 `id`, render the `.md` file to disk conforming to the canonical template in `docs/architecture/data_schema.md` §2, and return `200 OK` with `{ status: "indexed", file_path: "<absolute_path>" }`.
- [ ] The API must reject requests missing a valid Bearer token provided via the `KORE_API_KEY` environment variable.
- [ ] **[Logic/Backend]** Write unit tests exercising the Elysia endpoints, mocking the Bearer token checks and queue insertion.

### US-003: Implement SQLite Background Queue
**Description:** As the core engine, I need a durable background queue to handle slow LLM extractions so that spikes in ingestion do not crash the API or timeout.
**Acceptance Criteria:**
- [ ] Add `bun:sqlite` to `apps/core-api`.
- [ ] Initialize a local SQLite database (`kore-queue.db`) with **WAL mode enabled** for safe concurrent read/write access.
- [ ] Create a `tasks` table with the schema: `id TEXT PRIMARY KEY, payload TEXT, status TEXT, priority TEXT DEFAULT 'normal', retries INTEGER DEFAULT 0, created_at DATETIME, updated_at DATETIME, error_log TEXT`. Statuses must be: `queued`, `processing`, `completed`, `failed`.
- [ ] Implement a lightweight Custom Queue Repository with methods: `enqueue(payload, priority?)`, `dequeueAndLock()`, `markCompleted(id)`, `markFailed(id, error_message)`. Use explicit SQLite transactions for safe locking in `dequeueAndLock()`.
- [ ] `dequeueAndLock()` must respect priority ordering: `high` > `normal` > `low`, then FIFO within the same priority.
- [ ] Implement a retry fallback ensuring `retries` increments on failure, failing the task permanently (status = `failed`) after 3 attempts.
- [ ] **[Logic/Backend]** Write unit tests for the queue: enqueueing, executing `dequeueAndLock` (simulating concurrent worker pulls safely), priority ordering, and testing the retry increment limit.

### US-004: Implement Local LLM Extraction Worker
**Description:** As the extraction engine, I want to use a local Ollama model (via the `packages/llm-extractor` module) to turn unstructured raw text into the structured format without sending user data to the cloud.
**Acceptance Criteria:**
- [ ] Create a background worker loop inside `apps/core-api` that polls `dequeueAndLock()` from the Queue Repository every N seconds (configurable, default 5).
- [ ] Import and use the `extract()` function from `packages/llm-extractor` (see US-007) to perform LLM extraction. Do NOT inline LLM calls directly in `apps/core-api`.
- [ ] Validate the LLM output against `MemoryExtractionSchema` from `packages/shared-types`. If validation fails, apply fallback parsing logic (see US-007 AC).
- [ ] Write the finalized output to `$KORE_DATA_PATH/[type]/[slugified_title].md`. If the file already exists, append a short unique hash suffix (e.g., `mutekiya_ramen_a1b2.md`). File naming must follow `docs/architecture/data_schema.md` §1.1.
- [ ] Generated `.md` files MUST conform to the canonical template defined in `docs/architecture/data_schema.md` §2, including: YAML frontmatter (all `BaseFrontmatterSchema` fields), `# <Title>`, `## Distilled Memory Items` (bulleted list), `---`, and `## Raw Source` (original unmodified text).
- [ ] Update `updated_at` and task status to `completed` in the queue database.
- [ ] **[Logic/Backend]** Write unit tests that test the worker logic: replacing the actual `packages/llm-extractor` call with a mocked successful structured return, and asserting the generated file path, `.md` formatting, and frontmatter correctness.
- [ ] **[Logic/Backend]** Write an end-to-end integration test (with mocked LLM extractor) starting from a `POST /ingest/raw` call and ending with a `.md` file verification on disk.

### US-005: Setup File Watcher & QMD Update Strategy
**Description:** As an agentic retrieval tool (QMD), I need to be notified when new markdown files are generated so I can seamlessly re-index them without the API needing to explicitly call me via subprocesses.
**Acceptance Criteria:**
- [ ] Import and use the `update()` function from `packages/qmd-client` (see US-008) to trigger re-indexing. Do NOT call `qmd` via raw `Bun.spawn` or `exec` directly in the watcher.
- [ ] Implement a lightweight watcher script (`apps/core-api/src/watcher.ts`) using Bun/Node `fs.watch` targeting `$KORE_DATA_PATH`.
- [ ] The watcher must debounce changes (e.g. wait 2 seconds after the last write) and execute `qmdClient.update()`.
- [ ] Ensure decoupling: the API Server and LLM Worker never trigger QMD directly. Only the watcher does.
- [ ] **[Logic/Backend]** Write unit tests validating the debounce and executable trigger logic of the watcher wrapper.
- [ ] **[Documentation]** Provide explicit clear instructions in `apps/core-api/README.md` on how to start the service (e.g., `bun run start` running both API, Worker, and Watcher concurrently).

### US-006: Implement Memory Management Endpoints (CRUD)
**Description:** As an agentic service interacting with Kore, I need standard REST endpoints to delete or update specific memories, ensuring the file system stays synced and plugin lifecycle events are dispatched.
**Acceptance Criteria:**
- [ ] Implement `DELETE /api/v1/memory/:id`: Finds the Markdown file by scanning for the matching `id` in frontmatter, deletes it from the `$KORE_DATA_PATH` directory, and returns `200 OK` with `{ status: "deleted", id: "<uuid>" }`.
- [ ] Implement `PUT /api/v1/memory/:id`: Accepts an updated memory payload, safely overwrites the specific Markdown file on disk, and returns `200 OK`.
- [ ] Both `DELETE` and `PUT` operations MUST emit `memory.deleted` / `memory.updated` events via the plugin event dispatcher (even if no plugins are registered in MVP). This ensures the event infrastructure is tested and ready for Phase 2 plugins.
- [ ] Any file mutation correctly fires events and relies on the watcher so QMD can also re-index.
- [ ] **[Logic/Backend]** Write unit tests mocking the file system to ensure `DELETE` removes a file, `PUT` successfully overwrites, and both emit the correct lifecycle events.

### US-007: Implement `packages/llm-extractor` Module
**Description:** As a developer, I need a dedicated, reusable package encapsulating LLM integration so that the extraction logic, system prompts, and provider configuration are decoupled from the API server, as specified in `docs/architecture/monorepo_structure.md`.
**Acceptance Criteria:**
- [ ] Initialize `packages/llm-extractor` with a `package.json`.
- [ ] Install `ai` (Vercel AI SDK) and `@ai-sdk/openai` as dependencies.
- [ ] Implement a provider configuration using Vercel AI SDK's `createOpenAI()` pointed at `$OLLAMA_BASE_URL` (default `http://localhost:11434/v1`). Model is read from `$OLLAMA_MODEL` (default `qwen2.5:7b`).
- [ ] Export an `extract(rawText: string, source: string)` function that uses Vercel AI SDK `generateObject()` with `MemoryExtractionSchema` from `packages/shared-types` to enforce structured JSON output.
- [ ] The system prompt MUST:
  - Instruct the LLM to extract a title, 1-7 distilled atomic facts, a QMD category, a type, and up to 5 tags.
  - Reference the 7 allowed QMD top-level semantic roots as defined in `docs/architecture/data_schema.md` §4: `qmd://tech/`, `qmd://travel/`, `qmd://health/`, `qmd://finance/`, `qmd://media/`, `qmd://personal/`, `qmd://admin/`.
  - Include at least one few-shot example demonstrating the expected JSON output shape.
- [ ] Implement fallback parsing logic: if `generateObject()` fails (e.g., model returns malformed JSON), attempt a secondary text-based parse of the raw response before marking the task as failed.
- [ ] Typecheck and linting pass.
- [ ] **[Logic/Backend]** Write unit tests mocking the Vercel AI SDK `generateObject()` call: test successful extraction, Zod validation failure handling, and fallback parse logic.

### US-008: Implement `packages/qmd-client` Module
**Description:** As a developer, I need a typed wrapper around the QMD CLI so that the core engine interacts with QMD through a clean API rather than raw shell commands, as specified in `docs/architecture/monorepo_structure.md`.
**Acceptance Criteria:**
- [ ] Initialize `packages/qmd-client` with a `package.json`.
- [ ] Implement a `QmdClient` class or a set of exported functions wrapping the QMD CLI via `Bun.spawn`.
- [ ] Implement the following methods with typed inputs/outputs:
  - `update()`: Triggers `qmd update` to refresh the index.
  - `collectionAdd(path: string, name: string)`: Runs `qmd collection add <path> --name <name>`.
  - `status()`: Runs `qmd status` and returns a typed result indicating if QMD is responsive (used by the health endpoint in US-002).
- [ ] Handle `Bun.spawn` failures gracefully (e.g., QMD binary not found, process exit code != 0) by returning typed error results rather than throwing unhandled exceptions.
- [ ] Typecheck and linting pass.
- [ ] **[Logic/Backend]** Write unit tests mocking `Bun.spawn` to verify correct CLI arguments, error handling, and typed return values.

## 4. Functional Requirements
- **FR-1:** All type definitions, validation schemas, and plugin event interfaces MUST exist and be exported from `packages/shared-types` and referenced correctly across workspaces.
- **FR-2:** `apps/core-api` MUST use Bun, ElysiaJS, and Bearer token parsing for ingestion.
- **FR-3:** Extraction tasks MUST be written securely to a local SQLite file (`bun:sqlite`) with WAL mode enabled and explicit transactions for safe locking.
- **FR-4:** The LLM extraction logic MUST be encapsulated in `packages/llm-extractor` using **Vercel AI SDK** with `createOpenAI()` provider pointed at the local Ollama endpoint (`$OLLAMA_BASE_URL`, default `http://localhost:11434`). The default model is `qwen2.5:7b` (`$OLLAMA_MODEL`).
- **FR-5:** Final memory files MUST be saved identically to the canonical template structure documented in `docs/architecture/data_schema.md` §2.
- **FR-6:** QMD index updates are asynchronous to the processing engine and rely on file-watching triggers through `packages/qmd-client` rather than direct coupling.
- **FR-7:** Memory management endpoints (DELETE, PUT) MUST emit plugin lifecycle events (`memory.deleted`, `memory.updated`) as defined in `docs/architecture/plugin_system.md`.

## 5. Non-Goals (Out of Scope for MVP)
- Implementing the plugin system interface (e.g., `kore-plugin-spatialite`). This is marked for Phase 2.
- Complex agentic workflows like the "Consolidation Loop" or "Insight Generators."
- Development of the specific source collector scripts (like building the Web Clipper or Reddit scraper).
- End-to-End tests invoking a live, containerized Ollama instance or QMD daemon (external binaries will be mocked for unit/integration tests).
- Cloud LLM provider integrations (Vercel AI SDK is used as the abstraction layer, but only the Ollama provider is configured for MVP).

## 6. Technical Considerations / Developer Notes
- **Monorepo Setup:** Ensure the root `package.json` declares `workspaces: ["apps/*", "packages/*", "plugins/*"]` to match the structure in `docs/architecture/monorepo_structure.md`.
- **Environment Targeting:** Provide a well-documented `.env.example` (created in US-002). Required keys: `KORE_DATA_PATH` (default `~/kore-data`), `KORE_API_KEY`, `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `qwen2.5:7b`).
- **LLM SDK:** Use **Vercel AI SDK** (`ai` + `@ai-sdk/openai`) with `createOpenAI()` pointing to the local Ollama instance. This provides `generateObject()` with native Zod schema enforcement for structured output. If the model struggles with complex nested JSON, the `packages/llm-extractor` module includes fallback parsing logic.
- **Concurrency:** Ensure the SQLite connection to the Queue DB uses WAL mode for safe concurrent reading/writing when scaling up the worker loop.
- **Dependency Rules:** Code within `apps/` CANNOT depend on other code within `apps/`. Apps can only depend on `packages/` or `plugins/`. All Zod schemas MUST live in `packages/shared-types/`.

## 7. Success Metrics
- **Ingestion Validation:** API reliably returns `202 Accepted` <50ms upon payload validation.
- **Zero-Cloud Validation:** If internet traffic is restricted on port 80/443, the application continues to correctly ingest and extract text via local Ollama.
- **Queue Fault Tolerance:** Any LLM failures or parsing failures safely increment retry counts before locking out bad jobs without crashing the worker.

## 8. Open Questions
- What is the most reliable prompt-engineering structure to ensure `qwen2.5:7b` outputs Zod-compliant JSON via Vercel AI SDK `generateObject()`?
- Should configured `KORE_DATA_PATH` directories be auto-created on first startup, or should the user pre-create them?

## 9. Checklist
- [x] Asked clarifying questions with lettered options
- [x] Incorporated user's answers
- [x] User stories are small and specific
- [x] Every user story includes explicit testing requirements (unit tests or browser verification) in acceptance criteria
- [x] Documentation requirements (design docs, CLI usage) are included in acceptance criteria where applicable
- [x] Functional requirements are numbered and unambiguous
- [x] Non-goals section defines clear boundaries
- [x] Saved to `tasks/prd-[feature-name].md`

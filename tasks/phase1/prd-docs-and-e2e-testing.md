# PRD: Documentation & Manual E2E Testing Guide

## 1. Overview

Now that the Kore MVP is implemented (US-001 through US-008), two gaps remain:

1. **Documentation is incomplete or stale.** The root README reflects a pre-MVP structure. Three packages have no README at all. The core-api README is missing the memory management endpoints and more detail on day-to-day operations.
2. **No manual E2E testing path exists.** There are unit tests, but no guide or tooling to let a developer manually validate the entire pipeline from raw ingest → queue → LLM extraction → markdown on disk → QMD indexing → memory query.

---

## 2. Goals

- **G-1:** Every workspace (root + 4 packages + 1 app) has a correct, useful README.
- **G-2:** The developer can manually exercise the full pipeline end-to-end using documented curl commands and CLI invocations — no guesswork.
- **G-3:** Optionally, a small helper script makes repetitive manual testing steps one-liners.

---

## 3. User Stories

### US-DOC-01: Update Root README

**Description:** As a developer cloning this repo for the first time, I want the root README to accurately reflect what's been built so I can understand the project without reading individual package docs.

**Acceptance Criteria:**
- [ ] Update the `## Project Structure` section to reflect the actual monorepo layout: `apps/core-api`, `packages/shared-types`, `packages/llm-extractor`, `packages/qmd-client`, `packages/an-export`.
- [ ] Add a `## How It Works` section with a brief pipeline summary: ingest → queue → LLM extract → markdown → QMD index → query.
- [ ] Add a `## Quick Start` section covering: prerequisites (Bun, Ollama, QMD), `.env` setup, `bun install`, and `bun run start` from `apps/core-api`.
- [ ] Replace or remove the single `an-export`-focused mention in the Getting Started section.
- [ ] Keep the Roadmap / progress.md reference.

---

### US-DOC-02: Write `packages/shared-types` README

**Description:** As a developer building a new package or plugin, I need to know what `shared-types` exports and how to use the schemas.

**Acceptance Criteria:**
- [ ] Describe the purpose: single source of truth for Zod schemas and TypeScript interfaces.
- [ ] Document exports: `MemoryTypeEnum`, `BaseFrontmatterSchema`, `MemoryExtractionSchema`, `IngestionContext`, `EnrichmentResult`, `MemoryEvent`.
- [ ] Include a short code snippet showing how to import and validate against `BaseFrontmatterSchema`.
- [ ] Document how to add this as a workspace dependency (`"@kore/shared-types": "workspace:*"`).

---

### US-DOC-03: Write `packages/llm-extractor` README

**Description:** As a developer integrating the LLM extraction step, I need to know how to configure and call `extract()`.

**Acceptance Criteria:**
- [ ] Document the exported `extract(rawText, source)` function signature and return type.
- [ ] Document the two required env vars: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`.
- [ ] Explain the fallback parsing behavior if `generateObject()` fails.
- [ ] Include a minimal usage example (importing and calling `extract()`).
- [ ] Note the dependency on a locally running Ollama instance.

---

### US-DOC-04: Write `packages/qmd-client` README

**Description:** As a developer triggering QMD indexing, I need to know the available methods and what CLI commands they wrap.

**Acceptance Criteria:**
- [ ] Document the three exported functions/methods: `update()`, `collectionAdd(path, name)`, `status()`.
- [ ] For each, show the underlying QMD CLI command it wraps.
- [ ] Document the typed return shape for `status()` (used by the health endpoint).
- [ ] Note graceful error handling: returns typed error result instead of throwing when the QMD binary is not found.

---

### US-DOC-05: Expand `apps/core-api` README

**Description:** As a developer running the API, I need complete endpoint documentation and operational detail.

**Acceptance Criteria:**
- [ ] Add missing endpoints to the API table: `DELETE /api/v1/memory/:id`, `PUT /api/v1/memory/:id`.
- [ ] Add a `## Architecture` section briefly explaining the three concurrent processes (API server, extraction worker, file watcher) and how they interact without direct coupling.
- [ ] Add a `## Data Storage` section: SQLite queue DB location (`kore-queue.db` in the working directory), data path structure (`$KORE_DATA_PATH/{places,media,notes,people}/`).
- [ ] Add a `## Worker Behavior` section: poll interval (5s default), retry logic (3 attempts → `failed`), stale task recovery (reset `processing` tasks older than 10 min on startup).
- [ ] Add a `## Watcher Behavior` section: debounce (2s), what triggers QMD update.

---

### US-TEST-01: Write Manual E2E Testing Guide

**Description:** As a developer, I want a step-by-step guide with exact commands to manually validate every layer of the Kore pipeline.

**Acceptance Criteria:**
- [ ] Create `docs/manual-e2e-testing.md` (not a README, a standalone guide).
- [ ] Cover the following scenarios with exact commands (curl, bun, qmd CLI):

  **Scenario 1 — Health Check**
  - Hit `GET /health`, validate `status: ok`, check `queue_length` starts at 0.

  **Scenario 2 — Raw Ingest & Queue Validation**
  - POST to `/ingest/raw` with a sample payload (place, media, and note examples provided).
  - Poll `GET /task/:id` to watch status transition from `queued` → `processing` → `completed`.
  - Provide SQLite CLI command to inspect the `tasks` table directly.

  **Scenario 3 — Verify Markdown File Generation**
  - After task completes, list files in `$KORE_DATA_PATH/<type>/`.
  - Show a `cat` of the generated `.md` file to verify frontmatter + distilled items + raw source sections.

  **Scenario 4 — Structured Ingest (no LLM)**
  - POST to `/ingest/structured` with a fully formed payload.
  - Confirm `200 OK` and the `file_path` in the response.
  - Verify file exists on disk.

  **Scenario 5 — Memory Management**
  - GET the file list, pick an `id` from a frontmatter.
  - `DELETE /api/v1/memory/:id` and confirm `200` + file is gone from disk.
  - `PUT /api/v1/memory/:id` with updated content and confirm file is overwritten.

  **Scenario 6 — QMD Indexing Validation**
  - After generating files, run `qmd status` and `qmd collection list` to confirm the data path is tracked.
  - Run a `qmd query` against a known fact from a distilled item.

  **Scenario 7 — Queue Resilience**
  - Ingest while Ollama is offline; confirm task lands in `failed` after 3 retries.
  - Use SQLite CLI to verify `retries = 3`, `status = 'failed'`, `error_log` is populated.

- [ ] Each scenario has a **"What to validate"** callout so it's clear what success looks like.
- [ ] Include a `## Prerequisites` section at the top: Bun, Ollama running + model pulled, QMD installed and initialized, `.env` configured, API running.

---

### US-TEST-02: (Optional) Add a `scripts/e2e-smoke.sh` Helper

**Description:** As a developer, I want a single script I can run to exercise the most common happy-path scenarios without copy-pasting curl commands.

**Acceptance Criteria:**
- [ ] Create `scripts/e2e-smoke.sh` (bash).
- [ ] Script reads `KORE_API_KEY` and `KORE_API_URL` (default `http://localhost:3000`) from env.
- [ ] Runs in sequence: health check, raw ingest (note), poll until `completed` (timeout 60s), verify file on disk, structured ingest, delete the structured memory.
- [ ] Prints pass/fail for each step with color output.
- [ ] Exits non-zero if any step fails.
- [ ] Script is not a replacement for the written guide — the guide remains authoritative.

---

## 4. Scope

**In scope:**
- Documentation files: root README, 3 new package READMEs, expanded core-api README, new E2E guide.
- Optional smoke test script.

**Out of scope:**
- Changing any implementation code.
- Automated integration tests (those belong in the main PRD).
- Documentation for `packages/an-export` (it already has a complete README).

---

## 5. Order of Work

1. Read the key source files first to write accurate docs:
   - `apps/core-api/src/app.ts` — all routes
   - `apps/core-api/src/queue.ts` — queue behavior
   - `apps/core-api/src/worker.ts` — worker loop + retry
   - `apps/core-api/src/watcher.ts` — watcher + debounce
   - `apps/core-api/src/config.ts` — env vars
   - `packages/llm-extractor/index.ts` — extract() signature
   - `packages/qmd-client/index.ts` — QmdClient methods
   - `packages/shared-types/index.ts` — all exports
2. Write all documentation (US-DOC-01 through US-DOC-05).
3. Write the E2E testing guide (US-TEST-01) — requires understanding the actual routes and file layout from step 1.
4. Write the smoke script (US-TEST-02) — optional, do last.

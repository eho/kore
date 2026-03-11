# PRD: QMD 2.0 SDK Migration

## Introduction

`packages/qmd-client` currently shells out to the global `qmd` CLI via `Bun.spawn`, parsing stdout/stderr to detect success or failure. QMD 2.0 ships a stable native TypeScript SDK (`@tobilu/qmd`) that replaces this approach with typed, awaitable function calls.

This refactor eliminates the global CLI dependency, gives kore strongly-typed access to QMD's full API (search, indexing, status, context management), and unlocks hybrid semantic search as a new capability. It also simplifies the Docker setup by removing the global install, the node symlink shim, and replacing the config volume mount with a model-cache volume.

See `docs/qmd-2.0/assessment.md` for the full technical analysis.

## Goals

- Replace all `Bun.spawn` / CLI subprocess usage with direct SDK calls
- Remove the requirement for a globally-installed `@tobilu/qmd` CLI
- Expose `store.getStatus()` and `store.getIndexHealth()` in the health endpoint (replacing opaque string parsing)
- Separate the `update()` (filesystem scan) and `embed()` (vector generation) steps correctly — the watcher triggers `update()` on file changes; a periodic interval triggers `embed()` independently
- Simplify the Dockerfile and docker-compose by removing the global install, BUN_INSTALL env vars, node symlink, and config volume, and adding a persistent GGUF model cache volume
- Unlock `/api/v1/search` as a new endpoint (stretch goal, separate user story)

## User Stories

### QMD2-001: Rewrite qmd-client as a native SDK wrapper

**Description:** As a developer, I want `packages/qmd-client` to use the `@tobilu/qmd` SDK directly so that all QMD operations are typed, reliable, and no longer depend on a globally-installed CLI.

**Acceptance Criteria:**
- [ ] `@tobilu/qmd` added to `packages/qmd-client/package.json` dependencies
- [ ] `QMDStore` singleton initialized via `createStore({ dbPath, config })` with inline collection config (no YAML file)
- [ ] `dbPath` read from `KORE_QMD_DB_PATH` env var, defaulting to `/app/db/qmd.sqlite` (inside the existing `KORE_DB_PATH` volume)
- [ ] Inline config registers the kore data directory (read from `KORE_NOTES_PATH` or `KORE_DATA_PATH`) as a collection named `"memories"`, covering all subdirectories (`**/*.md`)
- [ ] Exported functions: `initStore(dbPath)`, `closeStore()`, `update()`, `embed()`, `getStatus()`, `addCollection()`, `addContext()` (and a test-only `resetStore()`)
- [ ] All `Bun.spawn` code removed from `index.ts`
- [ ] `setSpawn` / `SpawnFn` test abstraction removed (no longer needed)
- [ ] `QmdStatusResult` and `QmdCommandResult` types replaced with typed SDK return types
- [ ] `bun typecheck` passes
- [ ] Unit tests in `index.test.ts` mock the `QMDStore` object (not `Bun.spawn`) and cover: `update()` success, `update()` error propagation, `getStatus()` return shape, `closeStore()` strictly nullifies the singleton
- [ ] Unit tests use `resetStore()` in `afterEach` or `beforeEach` to prevent test collisions

---

### QMD2-002: Initialize and shut down QMD store in core-api lifecycle

**Description:** As a developer, I want the QMD store to be initialized on `core-api` startup and cleanly closed on shutdown so that LLM models and SQLite connections are never leaked. I also want the index to gracefully bootstrap in the background if empty, without blocking server startup.

**Acceptance Criteria:**
- [ ] `apps/core-api/src/index.ts` calls `qmdClient.initStore(dbPath)` before starting the worker and watcher
- [ ] `process.on('SIGTERM')` and `process.on('SIGINT')` handlers call `qmdClient.closeStore()` before exiting
- [ ] If `initStore` throws (e.g. DB path not writable), the error is logged and the process exits with code 1
- [ ] After `initStore` and server port binding, if the DB is new or empty (doc count = 0), `update()` is called followed by `embed()` asynchronously in the background to bootstrap the index
- [ ] Bootstrap errors are logged but do not prevent startup or crash the server (the index will catch up on the next periodic cycle)
- [ ] The `/health` endpoint returns `status: "ok"` with `qmd: { status: "bootstrapping" }` (or similar) while the background bootstrap is running
- [ ] The `qmdStatus` function passed to `createApp` is replaced with a call to `qmdClient.getStatus()` returning the typed `IndexStatus` object
- [ ] `bun typecheck` passes
- [ ] Unit test: mock `initStore` to throw and verify the process exits with code 1
- [ ] Unit test: mock `getStatus()` returning `doc_count: 0` and verify `update()` + `embed()` are called asynchronously during bootstrap

---

### QMD2-003: Update watcher to call `store.update()` on file changes

**Description:** As a developer, I want the file watcher to call `store.update()` (filesystem scan + ingest) after detecting `.md` file changes so that the full-text index stays current without triggering the expensive embedding step on every save.

**Acceptance Criteria:**
- [ ] `apps/core-api/src/watcher.ts` calls `qmdClient.update()` (not the old `qmdClient.update` which called the full CLI)
- [ ] `qmd-client` implements a concurrency lock/mutex (e.g., an `isProcessing` boolean or promise queue) to ensure `update()` and `embed()` never run simultaneously
- [ ] `WatcherDeps.updateFn` type updated to match the new `update()` signature (returns `UpdateResult`, not `QmdCommandResult`)
- [ ] On `update()` failure, error is logged with the typed error detail (not a raw stderr string)
- [ ] Debounce behavior is unchanged (2s default)
- [ ] `bun typecheck` passes
- [ ] Existing watcher unit tests updated to mock the new `updateFn` signature; all tests pass

---

### QMD2-004: Add periodic embed interval for vector embedding generation

**Description:** As a developer, I want a background interval that calls `store.embed()` every 10 minutes so that new documents get vector embeddings without blocking the watcher's file-change response.

**Acceptance Criteria:**
- [ ] A `startEmbedInterval(intervalMs?)` function exported from `watcher.ts` (or a new `embedder.ts` file) starts a `setInterval` that calls `qmdClient.embed()`
- [ ] Default interval is 10 minutes (600,000 ms), configurable via `KORE_EMBED_INTERVAL_MS` env var
- [ ] If `embed()` fires while an `update()` (or another `embed()`) is running, it safely waits or skips the current cycle (via the concurrency lock from QMD2-003)
- [ ] Interval is started in `apps/core-api/src/index.ts` alongside the watcher
- [ ] The interval handle is cleared in the SIGTERM/SIGINT shutdown handler
- [ ] `embed()` errors are logged but do not crash the interval (caught internally)
- [ ] `bun typecheck` passes
- [ ] Unit test: verifies `embed()` is called after the interval fires and that errors are caught without stopping the interval

---

### QMD2-005: Upgrade health endpoint to use typed QMD status

**Description:** As an operator, I want the `/api/v1/health` endpoint to return structured QMD index information (document count, collection count, embedding coverage) instead of a plain `"ok"` / `"unavailable"` string so that I can monitor index health programmatically.

**Acceptance Criteria:**
- [ ] `AppDeps.qmdStatus` type changed from `() => string | Promise<string>` to `() => Promise<QmdHealthSummary>` where `QmdHealthSummary = { status: "ok" | "unavailable" | "bootstrapping"; doc_count?: number; collections?: number; needs_embedding?: number }`
- [ ] Health response shape becomes: `{ status, version, queue_length, qmd: QmdHealthSummary }`
- [ ] If `getStatus()` throws, `qmd` field returns `{ status: "unavailable" }` (never crashes the health check)
- [ ] `getIndexHealth()` is used to populate `needs_embedding` (stale embedding count)
- [ ] `bun typecheck` passes
- [ ] Unit tests for `createApp` updated to cover the new `qmdStatus` shape
- [ ] **Documentation:** Update `apps/core-api/README.md` (or equivalent) health endpoint response schema

---

### QMD2-006: Simplify Dockerfile and docker-compose for SDK-based setup

**Description:** As a developer, I want the Docker setup cleaned up to remove the CLI installation shim and add a persistent model cache volume so that container startup is reliable and doesn't re-download 2GB+ of GGUF models on every restart.

**Acceptance Criteria:**
- [ ] `Dockerfile` runner stage: `RUN bun install -g @tobilu/qmd` removed
- [ ] `Dockerfile` runner stage: `RUN ln -s /usr/local/bin/bun /usr/local/bin/node` removed
- [ ] `Dockerfile` runner stage: `ENV BUN_INSTALL`, `ENV BUN_INSTALL_BIN`, and their `PATH` additions removed
- [ ] `Dockerfile` builder stage: `build-essential` and `python3` retained (still required for `@tobilu/qmd`'s native addons: `better-sqlite3`, `sqlite-vec`, `node-llama-cpp`)
- [ ] `docker-compose.yml`: `${QMD_CONFIG_PATH:-~/.kore/qmd-config}:/home/bun/.config/qmd` volume removed from both `core-api` and `notification-worker` services
- [ ] `docker-compose.yml`: `${QMD_CACHE_PATH:-~/.kore/qmd-cache}:/home/bun/.cache/qmd` volume added to `core-api` service (model cache persistence)
- [ ] `docker-compose.yml`: `QMD_CACHE_PATH` and `KORE_EMBED_INTERVAL_MS` documented in `.env.example` (or equivalent) with a comment explaining the 2GB+ model download
- [ ] Container builds successfully: `docker build .`
- [ ] **Documentation:** `docs/qmd-2.0/assessment.md` Docker section marked as implemented

---

### QMD2-007 (Stretch): Expose `/api/v1/search` endpoint

**Description:** As a user, I want to search my kore memories via a REST endpoint using hybrid semantic search (BM25 + vector + LLM reranking) so that I can find relevant memories by meaning, not just keyword.

**Acceptance Criteria:**
- [ ] `POST /api/v1/search` added to `apps/core-api/src/app.ts`
- [ ] Request body: `{ query: string, intent?: string, limit?: number, collection?: string }` — validated with zod
- [ ] Response: array of `{ path, title, snippet, score, collection }` objects derived from `HybridQueryResult[]`
- [ ] `intent` defaults to `"personal knowledge base containing notes, contacts, and bookmarks"` if not provided
- [ ] `limit` capped at 20, defaults to 10
- [ ] Returns `503` with `{ error: "Search index not available" }` if the store is not initialized
- [ ] Endpoint protected by the existing bearer token auth (not skipped like `/health`)
- [ ] `bun typecheck` passes
- [ ] Unit tests cover: successful search response shape, missing `query` returns 400, uninitialized store returns 503
- [ ] **Documentation:** Add search endpoint to `apps/core-api/README.md` with example curl request

---

## Functional Requirements

- **FR-1:** `packages/qmd-client` must export `initStore(dbPath: string)`, `closeStore()`, `update()`, `embed()`, `getStatus()`, `addCollection()`, `addContext()` using the `@tobilu/qmd` SDK. No `Bun.spawn` calls.
- **FR-2:** The QMD store must be initialized once at process startup and closed on SIGTERM/SIGINT. If the index is empty at startup, `update()` + `embed()` must run asynchronously in the background to bootstrap it after the server begins accepting traffic.
- **FR-3:** File watcher triggers `store.update()` (filesystem scan only) after a 2s debounce on `.md` file changes.
- **FR-4:** A separate periodic interval (default 10 min) triggers `store.embed()` to generate vector embeddings for documents added since the last embed run. `update()` and `embed()` must not run concurrently.
- **FR-5:** The health endpoint at `/api/v1/health` returns a structured `qmd` object with at minimum `status`, `doc_count`, and `needs_embedding`.
- **FR-6:** QMD SQLite database stored at a path configurable via `KORE_QMD_DB_PATH`, defaulting to `/app/db/qmd.sqlite` within the existing persistent DB volume.
- **FR-7:** Global `qmd` CLI install removed from the Dockerfile runner stage.
- **FR-8:** A persistent volume for GGUF model cache (`~/.cache/qmd`) must be declared in `docker-compose.yml` to prevent re-downloading models on container restart.
- **FR-9 (Stretch):** `POST /api/v1/search` accepts `{ query, intent?, limit?, collection? }` and returns ranked results from `store.search()`.

## Non-Goals

- No YAML config file support — collections are managed programmatically via `addCollection()` (inline config mode only).
- No CLI interface to the QMD store — the SDK is internal to `core-api` only.
- No MCP server setup — the QMD 2.0 MCP server is out of scope for this refactor.
- No migration of existing QMD index data — the DB can be rebuilt by running `update()` + `embed()` on startup if the DB doesn't exist.
- No changes to the `notification-worker` service — it writes markdown files only and does not interact with the QMD store.
- No UI changes.

## Technical Considerations

- **`update()` vs `embed()` are separate:** `store.update()` scans the filesystem and ingests content hashes into SQLite. `store.embed()` generates vector embeddings using the local LLM. Both must be called for hybrid search to work. The old `qmd update` CLI ran both internally.
- **Concurrency:** `update()` and `embed()` must not run at the same time to prevent SQLite lock contention or race conditions. Implement a simple lock mechanism within `qmd-client`.
- **`better-sqlite3` vs `bun:sqlite`:** `@tobilu/qmd` uses `better-sqlite3` (a Node.js native addon) not `bun:sqlite`. Both work in the same process on Bun via Node.js compatibility. The kore queue DB continues to use `bun:sqlite` directly.
- **Native addon compilation:** `better-sqlite3`, `sqlite-vec`, and `node-llama-cpp` require `build-essential` and `python3` at build time. These must remain in the Dockerfile builder stage.
- **Model download on first use:** GGUF models (embeddings, reranker, query expansion) are ~2GB total and download automatically on first `embed()` or `search()` call. Without a persistent cache volume, every container restart triggers a re-download. The `${QMD_CACHE_PATH}:/home/bun/.cache/qmd` volume mount prevents this.
- **Store singleton in qmd-client:** `initStore()` / `closeStore()` manage a module-level singleton. Only one store instance should exist per process. Calling `initStore()` twice without `closeStore()` in between should throw or warn. Use a test-only `resetStore()` for clean unit testing isolation.
- **KORE_QMD_DB_PATH env var:** Needs to be added to `docker-compose.yml` environment blocks for `core-api` (not `notification-worker`).

## Success Metrics

- Zero `Bun.spawn` calls remain in `packages/qmd-client`
- `docker build .` succeeds without installing the global `qmd` CLI
- Health endpoint returns `qmd.doc_count > 0` after first index run
- All existing tests pass; new tests added per user story
- No GGUF model re-download on container restart (verified by checking cache volume is populated after first run)

## Open Questions

- None at this time.

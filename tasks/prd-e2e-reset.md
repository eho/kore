# PRD: E2E Test Reset Infrastructure

## Introduction

Manual and automated E2E testing of Kore requires a reliable way to wipe all state and start fresh. Currently there is no bulk-reset mechanism — the only cleanup path is `kore delete <id> --force` one memory at a time, which is unusable when the dataset has 15+ files. Additionally, the `e2e/README.md` is missing a reset workflow and contains an ambiguous note about the `--wait` flag.

This PRD covers three things:
1. A `DELETE /api/v1/memories` API endpoint that wipes all memories, the queue, and the QMD index in one call.
2. A `kore reset` CLI command that calls that endpoint.
3. Targeted updates to `e2e/README.md` to document the reset workflow and clarify `--wait` behavior.

---

## Goals

- Enable a complete, deterministic reset of all Kore state with a single CLI command.
- Make the reset safe by requiring explicit confirmation (or `--force`) before destroying data.
- Give E2E test scripts a scriptable, reliable clean-slate starting point.
- Reduce manual friction in the testing workflow documented in `e2e/README.md`.

---

## User Stories

### RESET-001: Backend — `clearAll()` + `DELETE /api/v1/memories` endpoint

**Description:** As the API server, I need a bulk-reset endpoint so that a single HTTP call wipes all memories, the task queue, and the QMD index — leaving the server in the same state as a fresh install.

**Implementation steps (in order):**
1. Add `clearAll(): number` to `QueueRepository` (`apps/core-api/src/queue.ts`) — runs `DELETE FROM tasks` and returns the row count.
2. Add `DELETE /api/v1/memories` to `createApp()` (`apps/core-api/src/app.ts`) that:
   - Needs to import `* as qmdClient` from `@kore/qmd-client` and `resolveQmdDbPath` from `./config` inside `app.ts`.
   - Deletes the `places`, `media`, `notes`, and `people` directories entirely using `fs.promises.rm(dir, { recursive: true, force: true })` and then calls the existing `ensureDataDirectories(dataPath)` function to cleanly recreate them.
   - Calls `await memoryIndex.build(dataPath)` to rebuild the in-memory index against the now-empty filesystem.
   - Calls `queue.clearAll()` and captures the count.
   - Calls `await qmdClient.closeStore()`, deletes the SQLite database (`qmdDbPath`) along with its WAL files (`${qmdDbPath}-wal` and `${qmdDbPath}-shm`), then calls `await qmdClient.initStore(qmdDbPath)`.
   - Returns `{ status: "reset", deleted_memories: N, deleted_tasks: M }`.

**Acceptance Criteria:**
- [ ] `QueueRepository.clearAll()` runs `DELETE FROM tasks` and returns the number of rows deleted.
- [ ] Unit test for `clearAll()`: after calling it, `getQueueLength()` returns `0`.
- [ ] `DELETE /api/v1/memories` responds `200` with `{ status: "reset", deleted_memories: number, deleted_tasks: number }`.
- [ ] After the call, `GET /api/v1/memories` returns an empty list.
- [ ] After the call, `GET /api/v1/health` returns `queue_length: 0`.
- [ ] After the call, the QMD index is empty (reinitialised from a blank DB file).
- [ ] If no memories exist, the endpoint still succeeds — returns `deleted_memories: 0` (idempotent).
- [ ] The endpoint is protected by the existing API key auth middleware.
- [ ] Individual `.md` file deletion errors are non-fatal: log a warning and continue; count only successfully deleted files.
- [ ] Typecheck passes.

---

### RESET-002: CLI + docs — `kore reset` command and `e2e/README.md` updates

**Description:** As a developer running E2E tests, I want a `kore reset` command and clear documentation so I can start each test session from a clean slate with a single command.

**CLI behavior:**
- By default, prompt: `"This will permanently delete all memories, tasks, and the search index. Continue? (y/N)"` before calling the API. **Use `enquirer` (e.g., `import { prompt } from "enquirer"`) to match existing CLI conventions.**
- With `--force`, skip the prompt (for scripting).
- On success, print: `✓ Reset complete. Deleted N memories and M tasks.`
- On API error or network failure, print to stderr and exit with code 1.

**README changes (`e2e/README.md`):**
1. Under `### 3. Cleanup`, add a "Resetting for a fresh test run" subsection before "Stop the server":
   ```
   To wipe all memories, the task queue, and the search index in one step:
   ```sh
   kore reset --force
   ```
   This deletes all `.md` files under `$KORE_HOME/data/`, clears all queue tasks, and reinitialises the QMD SQLite database. The server keeps running — no restart needed.

   After reset, confirm the slate is clean:
   ```sh
   kore list   # should show 0 results
   kore health # queue_length should be 0
   ```
2. Add a comment to the multi-file ingest example clarifying `--wait` is the default:
   ```sh
   # --wait is the default: blocks until each file's LLM extraction completes.
   # Use --no-wait to queue all files and return immediately.
   kore ingest e2e/dataset/*.md
   ```

**Acceptance Criteria:**
- [ ] `kore reset` is registered as a top-level command in `apps/cli/src/index.ts`.
- [ ] New command implemented in `apps/cli/src/commands/reset.ts`.
- [ ] Without `--force`, confirmation prompt is shown; answering `n` aborts with no API call made.
- [ ] With `--force`, no prompt is shown and the API is called immediately.
- [ ] On success, output shows count of deleted memories and tasks.
- [ ] On API error or network failure, exits with code 1 with a descriptive message.
- [ ] `kore --help` lists `reset` with a short description.
- [ ] `e2e/README.md` has a "Resetting for a fresh test run" subsection under `### 3. Cleanup`.
- [ ] The multi-file ingest example includes a comment clarifying `--wait` is the default.
- [ ] No other sections of the README are changed.
- [ ] Typecheck passes.

---

## Functional Requirements

- **FR-1:** `QueueRepository` must expose `clearAll(): number` that atomically deletes all task records and returns the count deleted.
- **FR-2:** `DELETE /api/v1/memories` must recursively delete and then recreate the data type subdirectories (`places`, `media`, `notes`, `people`) under `$KORE_HOME/data/`.
- **FR-3:** `DELETE /api/v1/memories` must call `queue.clearAll()` to flush all queued, processing, completed, and failed tasks.
- **FR-4:** `DELETE /api/v1/memories` must close the store, delete the QMD SQLite database file and its WAL files (`-wal`, `-shm`), and then reinitialise the store so the vector/BM25 index is fully empty.
- **FR-5:** `DELETE /api/v1/memories` must be atomic with respect to the in-memory `memoryIndex`: after the call completes, the index must reflect zero entries.
- **FR-6:** `DELETE /api/v1/memories` must be idempotent — calling it on an already-empty system must return `200` with zero counts.
- **FR-7:** `kore reset` must call `DELETE /api/v1/memories` and surface the response counts to the user.
- **FR-8:** `kore reset` must require either interactive confirmation or `--force` before making the destructive API call.
- **FR-9:** The `e2e/README.md` must document `kore reset --force` as the canonical way to start a fresh test session.

---

## Non-Goals

- **No source-label filtering.** Reset is all-or-nothing. Selective deletion by source remains `kore delete <id>`.
- **No `--dry-run` flag.** The confirmation prompt is sufficient safety.
- **No reset of `$KORE_HOME` itself** (config, logs directory, or other files outside `data/` and `db/qmd.sqlite`).
- **No automated re-ingestion after reset.** The user runs `kore ingest` manually afterwards.
- **No changes to the automated `e2e/e2e.test.ts` suite** — only the manual testing guide is in scope.

---

## Technical Considerations

- **QMD reinitialisation race:** The reset endpoint must `await qmdClient.closeStore()` before deleting the SQLite file to avoid write errors. After deletion, call `await qmdClient.initStore(qmdDbPath)` to bring the store back up. The server should be fully operational (not require a restart) after reset.
- **`qmdClient.resetStore()`** only nulls the in-memory store reference — it does **not** wipe the SQLite file. Do not use it alone; use `closeStore()` + file deletion + `initStore()`.
- **File deletion errors:** If a `.md` file cannot be deleted (permissions, already gone), log a warning but do not abort the entire reset. Count only successfully deleted files.
- **In-memory index rebuild:** After deleting all files, call `await memoryIndex.build(dataPath)` to rebuild from the (now empty) filesystem rather than manually clearing the Map, to keep the index consistent with disk.
- **Auth:** No special auth bypass — the endpoint uses the same `KORE_API_KEY` check as all other write routes in `createApp()`.
- **Implementation locations:**
  - `QueueRepository.clearAll()` → `apps/core-api/src/queue.ts`
  - Reset endpoint → `apps/core-api/src/app.ts`
  - CLI command → `apps/cli/src/commands/reset.ts` + registered in `apps/cli/src/index.ts`
  - README changes → `e2e/README.md`

---

## Success Metrics

- Running `kore reset --force && kore ingest e2e/dataset/*.md` produces a clean, reproducible test state with no leftover data from prior runs.
- `kore list` returns 0 results immediately after `kore reset`.
- `kore health` shows `queue_length: 0` immediately after `kore reset`.
- The server does not need to be restarted after a reset.

---

## Open Questions

- Should `DELETE /api/v1/memories` also appear in a future OpenAPI spec, or is it CLI-internal only? (No impact on this implementation.)
- Should the reset emit a `reset` event via `EventDispatcher` for any future subscribers? (Out of scope for now, but worth noting the hook point.)

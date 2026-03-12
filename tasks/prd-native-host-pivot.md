# PRD: Native Host Pivot

## Introduction

Pivot the Kore application architecture from a Docker-containerized setup to running natively on the host machine. This involves removing all Docker-specific configurations, introducing a single `KORE_HOME` environment variable (defaulting to `~/.kore`) that all path resolution is relative to, updating internal networking to use `localhost`, and adding a root-level `start` script that delegates to the existing single-process `core-api` entry point. The application will eventually be distributed as standalone compiled binaries.

## Goals

- Eliminate the Docker dependency for running Kore locally.
- Introduce `KORE_HOME` (default: `~/.kore`) as the single source of truth for all persistent storage paths.
- Update network configuration to route to `localhost` instead of Docker's internal DNS (`host.docker.internal`).
- Add a root-level `bun run start` convenience script (no process splitting needed — the API, worker, watcher, and embedder already run in a single Bun process).
- Implement OS-aware Spatialite extension auto-detection with a clear error if not found.
- Prepare the project for compilation into standalone executables using `bun build --compile`.
- Update documentation to reflect the new native setup and system dependency prerequisites.

## User Stories

### NHP-001: Remove Docker artifacts and set up native dev environment
**Description:** As a developer, I want to remove all Docker configuration, clean up related references across the codebase, and have a root-level `start` command that runs the full stack natively.

**Context:** The API, extraction worker, file watcher, and embedder already run as a single Bun process via `apps/core-api/src/index.ts`. No process orchestration tool is needed.

**Acceptance Criteria:**
- [ ] Delete `Dockerfile`, `docker-compose.yml`, and `.dockerignore`.
- [ ] Remove the commented-out `# OLLAMA_BASE_URL=http://host.docker.internal:11434` line from `.env.example`; confirm default is `http://localhost:11434`.
- [ ] Add `"start": "bun run apps/core-api/src/index.ts"` and `"dev": "bun --hot run apps/core-api/src/index.ts"` scripts to the root `package.json`.
- [ ] Remove Docker deployment instructions from `README.md` and audit `docs/` for remaining Docker-specific references (including `docs/architecture/`, `docs/qmd-2.0/assessment.md`, `apps/core-api/README.md`).
- [ ] Run `bun run typecheck` from the repo root and confirm exit code 0.

### NHP-002: Introduce `KORE_HOME` and standardize all paths
**Description:** As a user, I want the application to store all its data relative to a single configurable base directory (`KORE_HOME`, defaulting to `~/.kore`) instead of hardcoded container paths.

**Path layout under `KORE_HOME`:**
- `$KORE_HOME/data` — notes and file storage (replaces `/app/data`)
- `$KORE_HOME/db/qmd.sqlite` — QMD SQLite database (replaces `/app/db/qmd.sqlite`)
- `$KORE_HOME/db/kore-queue.db` — job queue database (currently defaults to relative `kore-queue.db`)

**Acceptance Criteria:**
- [ ] Add a `resolveKoreHome()` utility (using `os.homedir()`) that reads `KORE_HOME` env var and falls back to `~/.kore`.
- [ ] Replace all hardcoded `/app/` paths in `packages/qmd-client/index.ts` with paths derived from `resolveKoreHome()`.
- [ ] Update `apps/core-api/src/config.ts` so that `resolveDataPath()` and `resolveQueueDbPath()` both derive from `resolveKoreHome()`.
- [ ] On startup, auto-create `$KORE_HOME/data` and `$KORE_HOME/db` if they do not exist (before any SQLite connections are opened).
- [ ] Update `.env.example` to document `KORE_HOME=~/.kore` as the canonical config variable; remove or consolidate the separate `KORE_DATA_PATH`, `KORE_QMD_DB_PATH` entries.
- [ ] Write unit tests for `resolveKoreHome()` and derived path construction, covering: default path, custom `KORE_HOME` env var, tilde expansion.
- [ ] Run `bun run typecheck` from the repo root and confirm exit code 0.

### NHP-003: Implement OS-aware Spatialite auto-detection
**Description:** As a user, I want the application to automatically find the Spatialite extension on my host without manual configuration, and get a clear error message if it's not installed.

**Detection order (try in sequence, stop at first match):**
1. `SPATIALITE_PATH` env var (explicit override)
2. macOS Homebrew arm64: `/opt/homebrew/lib/mod_spatialite.dylib`
3. macOS Homebrew x86: `/usr/local/lib/mod_spatialite.dylib`
4. Linux system default: `/usr/lib/x86_64-linux-gnu/mod_spatialite.so`
5. Linux alternative: `/usr/lib/aarch64-linux-gnu/mod_spatialite.so`

**Acceptance Criteria:**
- [ ] Implement a `findSpatialite()` function (in `packages/qmd-client/` or a shared utility) that checks the above paths using `fs.existsSync` and returns the first match, or throws an error listing all checked paths if none found.
- [ ] The error message must name the missing paths and provide the correct install command for the detected OS (`brew install spatialite-tools` or `apt-get install libsqlite3-mod-spatialite`).
- [ ] `SPATIALITE_PATH` env var overrides auto-detection when set.
- [ ] Write unit tests for `findSpatialite()` covering: env var override, macOS path found, Linux path found, none found (expect thrown error with all paths listed).
- [ ] Run `bun run typecheck` from the repo root and confirm exit code 0.

### NHP-004: Update documentation and add compiled binary build scripts
**Description:** As a developer or user, I want clear native installation instructions and the ability to compile the API and CLI into standalone executables.

**Context:** The API and worker run as a single process (`apps/core-api/src/index.ts`). There is no separate worker binary. Compiled executables still require `mod_spatialite` on the host — it cannot be bundled.

**Acceptance Criteria:**
- [ ] Add a "Prerequisites" section to `README.md` with Spatialite install instructions for macOS (`brew install spatialite-tools`) and Linux (`apt-get install libsqlite3-mod-spatialite`).
- [ ] Update the "Getting Started" section of `README.md` to replace Docker instructions with: `bun install` → set up `.env` → `bun run start`.
- [ ] Document `KORE_HOME` in `README.md` as the primary configuration variable.
- [ ] Update `docs/manual-e2e-testing.md` and `e2e/manual-testing.md` to reference host terminal logs instead of Docker logs.
- [ ] Update `docs/architecture/` docs to reflect the native host single-process architecture.
- [ ] Add `"build:bin": "bun build --compile src/index.ts --outfile bin/kore-server"` to `apps/core-api/package.json`.
- [ ] Add `"build:bin": "bun build --compile src/index.ts --outfile bin/kore"` to `apps/cli/package.json`.
- [ ] Add a root-level `"build:bin"` script: `bun run --cwd apps/core-api build:bin && bun run --cwd apps/cli build:bin`.
- [ ] Investigate `node-llama-cpp` behavior under `bun build --compile` (it ships pre-built optional platform packages — confirm these resolve correctly or document the workaround); add findings to `README.md`.
- [ ] Run `bun run typecheck` from the repo root and confirm exit code 0.

## Functional Requirements

- FR-1: `KORE_HOME` env var (default: `~/.kore`) is the single base directory for all persistent storage.
- FR-2: The system must default data storage to `$KORE_HOME/data`.
- FR-3: The system must default database storage to `$KORE_HOME/db/qmd.sqlite` and `$KORE_HOME/db/kore-queue.db`.
- FR-4: The system must auto-create `$KORE_HOME/data` and `$KORE_HOME/db` on startup before opening any database connections.
- FR-5: The system must attempt to dynamically locate the Spatialite extension using OS-specific probing; fail with an actionable error if not found.
- FR-6: The application must start the full stack (API + worker + watcher + embedder) via `bun run start` from the repo root.
- FR-7: The codebase must compile successfully using `bun build --compile` for both `apps/core-api` and `apps/cli`.

## Non-Goals

- We are not changing the core functionality of Kore (embedding, memory indexing).
- We are not replacing Ollama; we are simply changing how Kore connects to it.
- We are not building an automated installer or GUI wrapper for the compiled binaries in this specific feature scope.
- We are not splitting the API and worker into separate processes.
- We are not implementing background daemonization (e.g., pm2, systemd, launchd); users who need this can run the compiled binary directly.

## Technical Considerations

- **`KORE_HOME` path resolution:** Use `os.homedir()` to expand `~` reliably. Centralize this in one utility function shared by `packages/qmd-client` and `apps/core-api` to avoid drift.
- **Native dependency loading (Spatialite):** The SQLite driver must invoke `loadExtension` with the resolved Spatialite path. The path differs by OS and Homebrew prefix — auto-detection handles this, but users can override with `SPATIALITE_PATH`.
- **Compilation limits:** `bun build --compile` bundles JS/TS but not native shared libraries (`.dylib`, `.so`). `mod_spatialite` must be installed on the target host. `node-llama-cpp` ships pre-built optional packages per platform — verify these are found correctly at runtime in a compiled binary.
- **Single process model:** All four subsystems (HTTP API, extraction worker, file watcher, embedder) already run concurrently within Bun's event loop in `apps/core-api/src/index.ts`. No external orchestration tool is needed.

## Success Metrics

- A developer can clone the repo, install system deps, run `bun install` + `bun run start`, and use the system without any Docker daemon running.
- `$KORE_HOME/data` and `$KORE_HOME/db` are created automatically on first run.
- `curl http://localhost:3000/health` returns 200 after `bun run start`.
- Compiled binaries (`kore-server`, `kore`) execute successfully on the host machine when Spatialite is installed.

## Open Questions

- Does `node-llama-cpp` resolve its platform-specific optional packages correctly when executed from a `bun build --compile` binary? (To be answered in NHP-004.)

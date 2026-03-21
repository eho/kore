# PRD: Codebase Cleanup — Dead Code Removal & Code Quality

## Introduction

After the successful completion of Phase 1 (MVP) and Phase 2 (Consolidation, MCP, Apple Notes), the codebase has accumulated technical debt: deprecated endpoints with duplicated inline logic, repeated utility functions across 6+ files, dead code, oversized files, silent error handling, and hardcoded configuration. This PRD addresses the cleanup identified in the [project assessment](/docs/assessment.md) and the [endpoint deprecation plan](/docs/api-endpoint-deprecation.md).

The MCP-005 integration tests are complete, which was the blocker for removing the deprecated endpoints. All 826 tests currently pass.

## Goals

- Remove 4 deprecated REST endpoints and their inline duplicate logic from `app.ts`
- Extract duplicated `parseFrontmatter()` into a single shared module used everywhere
- Remove confirmed dead code (`worker-entry.ts`, unused exports)
- Split `app.ts` (706 lines) into domain-grouped route modules
- Split `consolidation-loop.ts` (756 lines) into focused modules
- Replace silent catch blocks with proper error logging
- Make hardcoded values (port, thresholds) configurable via environment variables
- Fix easy `any` types in production code (not MCP SDK casts or test files)
- Update outdated documentation
- **All existing tests must continue to pass after every story**

## User Stories

### CLN-001: Deduplicate Utilities, Remove Deprecated Endpoints & Dead Code

**Description:** As a developer, I want a single source of truth for frontmatter parsing, the 4 superseded REST endpoints removed, and confirmed dead code deleted so that the codebase has one code path per operation and no unused artifacts.

**Reference:** [/docs/api-endpoint-deprecation.md](/docs/api-endpoint-deprecation.md)

**Acceptance Criteria:**

*Shared frontmatter module:*
- [ ] Create `apps/core-api/src/lib/frontmatter.ts` exporting: `parseFrontmatter()`, `parseTagsArray()`, `extractTitleFromMarkdown()`, `extractDistilledItems()`, `parseMemoryFile()`, `parseMemoryFileFull()`
- [ ] All consumers updated to import from `lib/frontmatter.ts`: `app.ts`, `consolidation-loop.ts`, `consolidation-event-handlers.ts`, `consolidation-writer.ts`, `delete-memory.ts`, `operations/inspect.ts`
- [ ] The copies in `operations/inspect.ts` are removed (re-exported from `lib/frontmatter.ts` if needed for external imports)
- [ ] The inline copies in `app.ts` are removed entirely
- [ ] Write unit tests for the shared module covering: valid frontmatter, missing fields, malformed YAML, empty content, insight-specific fields

*Deprecated endpoint removal:*
- [ ] Migrate CLI `kore list` command (`apps/cli/src/commands/list.ts`) to call `POST /api/v1/recall` with no query instead of `GET /api/v1/memories`. **Note:** `recall` returns a paginated object `{ results: Memory[], ... }` rather than a flat array, so update the CLI parsing logic to extract `.results`.
- [ ] Remove these 4 endpoints from `apps/core-api/src/app.ts`:
  - `POST /api/v1/search`
  - `POST /api/v1/ingest/raw`
  - `GET /api/v1/memory/:id`
  - `GET /api/v1/memories`
- [ ] `DELETE /api/v1/memories` (full reset) is **kept** — it has no operations-layer replacement
- [ ] Remove unused request/response types from `app.ts` (`SearchRequestPayload`, `RawIngestPayload`, etc.) if they become orphaned. Reused schemas (e.g. `StructuredIngestPayload`) should be moved to their respective route modules.
- [ ] Remove or migrate tests in `app.test.ts` that hit the old endpoints
- [ ] CLI `kore list` tests updated to reflect new API call

*Dead code removal:*
- [ ] Delete `apps/core-api/src/worker-entry.ts` (no references in scripts, Docker, or imports)
- [ ] Remove unused exports from `packages/qmd-client/index.ts`: `addCollection()`, `addContext()`
- [ ] Remove unused interfaces from `packages/shared-types/index.ts`: `IngestionContext`, `EnrichmentResult` (these are defined in the `KorePlugin` interface for `onIngestEnrichment` which is not implemented — remove the hook from the interface too)
- [ ] Remove the duplicate `fallbackParse()` from `apps/core-api/src/consolidation-synthesizer.ts` — import from `@kore/llm-extractor` instead
- [ ] Verify no other code references the removed items (grep confirmation)

*Gate:*
- [ ] `bun test` passes with no regressions
- [ ] Typecheck passes

### CLN-002: Split Large Files into Focused Modules

**Description:** As a developer, I want `app.ts` (706 lines) and `consolidation-loop.ts` (756 lines) split into focused, domain-grouped modules so each file has a single responsibility and is easy to navigate.

**Depends on:** CLN-001 (inline helpers and deprecated endpoints already removed)

**Acceptance Criteria:**

*Split app.ts into route modules:*
- [ ] Create route modules in `apps/core-api/src/routes/`:
  - `memory.ts` — `DELETE /api/v1/memory/:id`, `PUT /api/v1/memory/:id`, `DELETE /api/v1/memories` (full reset)
  - `ingestion.ts` — `POST /api/v1/ingest/structured`, `GET /api/v1/task/:id`
  - `consolidation.ts` — `POST /api/v1/consolidate`, `DELETE /api/v1/consolidation`
  - `operations.ts` — `POST /api/v1/recall`, `POST /api/v1/remember`, `GET /api/v1/inspect/:id`, `GET /api/v1/insights`
  - `system.ts` — `GET /api/v1/health`
- [ ] Each route module exports a function that takes deps and returns an Elysia plugin/group
- [ ] Extract `TYPE_DIRS`, `ensureDataDirectories()`, and `resolveFilePath()` into a shared module (e.g., `apps/core-api/src/lib/file-utils.ts`) so they can be consumed by multiple route modules
- [ ] `app.ts` reduced to: app creation, middleware (CORS, bearer auth), and mounting route modules

*Split consolidation-loop.ts:*
- [ ] Create `apps/core-api/src/consolidation-loaders.ts` — extract seed/cluster file-loading helpers: `loadSeedFromDisk()`, `loadClusterMemberFiles()`, `enrichCandidatesWithFiles()`, and any supporting `parseFrontmatter` calls (which now import from `lib/frontmatter.ts`)
- [ ] Create `apps/core-api/src/consolidation-cycle.ts` — extract `runConsolidationCycle()` and `runConsolidationDryRun()`
- [ ] `consolidation-loop.ts` retains: `startConsolidationLoop()`, `buildConsolidationDeps()`, `reconcileOnStartup()`, and the interval/pause/resume orchestration

*Gate:*
- [ ] All existing tests (app.test.ts, consolidation-*.test.ts) continue to pass without modification — these are internal refactors
- [ ] `bun test` passes with no regressions
- [ ] Typecheck passes

### CLN-003: Error Handling, Configuration & Code Quality

**Description:** As a developer and operator, I want silent catch blocks replaced with proper logging, hardcoded values made configurable, easy `any` types fixed, and outdated documentation updated.

**Acceptance Criteria:**

*Fix silent error handling:*
- [ ] Replace all silent `catch {}` and `catch { return null; }` blocks in consolidation files (`consolidation-loop.ts` / `consolidation-loaders.ts` / `consolidation-cycle.ts`) with `catch (err) { console.warn(...) }` including the file path or context
- [ ] Audit route modules for inconsistent error patterns — ensure every catch block that returns an error response also logs the error via `console.error()`
- [ ] Write a test that verifies a consolidation cycle with a corrupt seed file logs a warning and continues (doesn't crash the loop)

*Make hardcoded values configurable:*
- [ ] Server port configurable via `KORE_PORT` env var (default: 3000) in `apps/core-api/src/index.ts`
- [ ] Consolidation thresholds configurable via env vars in `buildConsolidationDeps()`:
  - `CONSOLIDATION_MIN_CLUSTER_SIZE` (default: 3)
  - `CONSOLIDATION_MAX_CLUSTER_SIZE` (default: 8)
  - `CONSOLIDATION_MIN_SIMILARITY` (default: 0.45)
  - `CONSOLIDATION_RELEVANCE_THRESHOLD` (default: 0.5)
- [ ] **Crucial:** Ensure these environment variables are explicitly parsed into numbers (e.g., using `parseFloat`, `parseInt`, or `Number()`) rather than being passed as strings
- [ ] Update `.env.example` with the new variables and their defaults

*Fix easy `any` types:*
- [ ] Replace `Record<string, any>` in `parseFrontmatter()` return type (now in `lib/frontmatter.ts`) with a `FrontmatterFields` interface using `[key: string]: unknown` for extensible fields
- [ ] Fix `(body as any)?.reset_failed` in route module — use a proper Zod schema or typed body
- [ ] Fix `plugin.routes(app as any)` in `index.ts` — type the plugin routes signature properly in `@kore/shared-types`
- [ ] **Do NOT touch** `as any` casts in `mcp.ts` tool registrations (see inline comment at line 204 — causes TypeScript OOM)
- [ ] **Do NOT touch** `as any` casts in test files (`.test.ts`) — test mocking pragmatically requires them

*Update outdated documentation:*
- [ ] Update `apps/core-api/README.md` health endpoint response structure to match actual output (memories/queue/index/sync objects)
- [ ] Update `/docs/api-endpoint-deprecation.md` — mark status as complete, update migration steps as done
- [ ] Update `/docs/architecture/api_design.md` if it references removed endpoints
- [ ] Review `/docs/phase2/apple_notes_integration_design.md` — mark the `listExternalKeys()` gap as resolved (it's wired)

*Gate:*
- [ ] `bun test` passes with no regressions
- [ ] Typecheck passes

## Functional Requirements

- FR-1: A single `lib/frontmatter.ts` module must be the only place frontmatter parsing logic exists in `apps/core-api/`
- FR-2: After CLN-001, no endpoint in `app.ts` duplicates logic available in the `operations/` module
- FR-3: Route modules must receive dependencies via function parameters (same DI pattern as the rest of the codebase)
- FR-4: All new environment variables must have sensible defaults so the system works without configuration changes
- FR-5: Error logs in catch blocks must include enough context to identify the failing operation (file path, memory ID, or step name)
- FR-6: The `DELETE /api/v1/memories` reset endpoint must be preserved — it is not superseded

## Non-Goals

- No new features or functionality added
- No changes to the MCP server tool definitions or behavior
- No changes to the consolidation algorithm or synthesis logic
- No changes to the Apple Notes plugin
- No refactoring of test files (test `any` casts are acceptable)
- No fixing the MCP SDK `as any` casts (documented TypeScript OOM issue)
- No changes to `packages/an-export/`

## Technical Considerations

- **Dependency order:** CLN-001 must be done before CLN-002, since the route split depends on deprecated endpoints and inline helpers being removed first. CLN-003 is independent and can be done in any order.
- **Route module pattern:** Use Elysia's `.group()` or plugin pattern so each route file returns a composable unit. Check existing patterns in `plugin-apple-notes` routes for reference.
- **Consolidation split:** The existing test files (`consolidation-loop.test.ts`, `consolidation-candidate-finder.test.ts`, etc.) should continue to work. New modules may need updated import paths in tests.
- **`@kore/shared-types` changes (CLN-001, CLN-003):** Removing `IngestionContext`/`EnrichmentResult` and updating `KorePlugin` interface may require bumping shared-types consumers. Run full test suite to catch breakage.

## Success Metrics

- `app.ts` reduced from ~706 lines to under 150 lines
- `consolidation-loop.ts` reduced from ~756 lines to under 300 lines
- Zero duplicate `parseFrontmatter()` implementations (down from 6+)
- Zero deprecated endpoints remaining
- Zero silent catch blocks in production code
- All 826+ tests continue to pass
- Typecheck passes cleanly

## Open Questions

- Should we add a deprecation warning log to the old endpoints for a transition period, or just remove them immediately? **Answered: Remove immediately — no external callers.**
- Should `worker-entry.ts` be kept for future Docker Compose support? **Answered: Remove it — can be recreated if needed.**

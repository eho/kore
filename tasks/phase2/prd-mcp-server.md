# PRD: Kore MCP Server

## Introduction

Kore needs a native MCP (Model Context Protocol) server to expose its personal memory system to AI agents in a structured, semantically-aware way. Today, agents can only access Kore through QMD's generic MCP server, which returns raw Markdown, has no write path, no structured filtering, and no lifecycle awareness.

This PRD covers the full implementation: a shared operations module (business logic reusable by both MCP and CLI), an MCP server embedded in core-api with 6 tools, CLI alignment, a stdio proxy for MCP-compatible agents, and setup documentation applicable to any MCP client.

The result: agents can search, save, inspect, and synthesize the user's personal knowledge without needing to parse YAML, understand Kore's internal structure, or manage a separate process.

Reference design: `docs/phase2/mcp_server_design.md`

---

## Goals

- Expose 6 MCP tools (`recall`, `remember`, `inspect`, `insights`, `health`, `consolidate`) to AI agents
- Return structured JSON with pre-parsed metadata — agents never need to parse YAML or Markdown
- Enable agents to write new memories via `remember`
- Filter retired/degraded insights so agents receive only active, authoritative knowledge
- Share all business logic between MCP tools and CLI commands via a shared `operations/` module — no divergence
- Provide a stdio proxy entry point (`kore mcp`) for any MCP-compatible agent configuration
- Ship setup documentation usable by any MCP-compatible AI agent (Claude Desktop used as concrete example)

---

## User Stories

### MCP-001: Shared Operations Module

**Description:** As a developer, I want all core business logic for MCP tools to live in a shared `apps/core-api/src/operations/` module so that both MCP tools and CLI commands call the same code and never diverge.

**Acceptance Criteria:**
- [ ] Create `apps/core-api/src/operations/` with the following exported functions matching the input/output schemas in the design doc §4:
  - `recall(params, deps): Promise<RecallOutput>`
  - `remember(params, deps): Promise<RememberOutput>`
  - `inspect(id, deps): Promise<InspectOutput | null>`
  - `insights(params, deps): Promise<InsightsOutput>`
  - `health(deps): Promise<HealthOutput>`
  - `consolidate(params, deps): Promise<ConsolidateOutput>`
- [ ] Each function accepts injected dependencies (`qmdClient`, `memoryIndex`, `queue`, `dataPath`) rather than importing globals — required for unit testing with mocks
- [ ] `recall()` implements: QMD over-fetch using `Math.max(100, offset + limit * 2)`, enrichment via `parseMemoryFileFull`, filters (type, intent, tags, min_confidence, created_after, created_before, retired insight exclusion), and pagination (`offset` / `has_more`)
- [ ] `inspect()` parses the `## Distilled Memory Items` Markdown section into `distilled_items: string[]`; returns `content` as the full raw file content (frontmatter + body)
- [ ] A shared `extractDistilledItems(fileContent: string): string[]` helper is exported and used by both `inspect()` and `recall()`
- [ ] `insights()` no-query path scans `$KORE_DATA_PATH/insights/` directly; query path searches QMD filtered to `type === "insight"` and the requested `status` (default: `"active"`)
- [ ] `health()` returns memory counts by type, queue state (pending/processing/failed), index state (documents/embedded/status), and sync state — superseding the existing `/api/v1/health` response; the existing REST health endpoint is refactored to call `health()` for consistency
- [ ] `parseMemoryFileFull` is extracted from `apps/core-api/src/app.ts` into `operations/inspect.ts` and exported
- [ ] Unit tests for each operation: happy path, empty results, key filter edge cases, error/not-found scenarios
- [ ] `bun test` passes
- [ ] Typecheck passes

---

### MCP-002: Embedded MCP Server in core-api

**Description:** As an AI agent, I want to connect to Kore's MCP server and use structured tools to search, save, and synthesize memories so that I can surface personal knowledge without parsing raw files.

**Acceptance Criteria:**
- [ ] Add `@modelcontextprotocol/sdk` to `apps/core-api/package.json`
- [ ] Create `apps/core-api/src/mcp.ts` that registers all 6 tools using the MCP SDK; each tool calls the corresponding shared operation from MCP-001
- [ ] Input schema for each tool matches the design doc §4 exactly (all optional fields, correct types, documented descriptions)
- [ ] Tool descriptions embedded in the server match §5 of the design doc verbatim — including `WHEN TO USE`, `WHEN NOT TO USE`, and `RESULT INTERPRETATION` sections
- [ ] Server-level instructions match §6 of the design doc
- [ ] MCP server mounts a Streamable HTTP transport at `/mcp` on the existing Bun.serve() instance in core-api (port 3000) — no separate listener or port
- [ ] `startMcpServer(deps)` exported from `mcp.ts` and called in `apps/core-api/src/index.ts` as the final startup step (after `startConsolidationLoop()`)
- [ ] `KORE_MCP_ENABLED` env var (default: `true`) gates `startMcpServer()` — if `false`, MCP server does not start and a log message explains why
- [ ] All 6 tools return structured MCP error responses (`isError: true`, human-readable `text`) for all error scenarios in the design doc §9 — no unhandled exceptions reach the agent
- [ ] Unit tests: each tool handler tested with mocked operations — verify schema validation, structured error responses, and result passthrough to MCP response format
- [ ] `bun test` passes
- [ ] Typecheck passes

---

### MCP-003: CLI Alignment

**Description:** As a developer or CLI-using agent, I want CLI commands to share the same logic and output format as MCP tools so that scripting and agent use via CLI produces results identical to MCP.

**Acceptance Criteria:**
- [ ] `kore search` refactored to call shared `recall()` operation; new flags added: `--type`, `--intent`, `--tags`, `--min-confidence`, `--min-score`, `--include-insights`, `--created-after`, `--created-before`, `--offset`, `--json`
- [ ] `kore show <id>` refactored to call shared `inspect()` operation; `--json` flag added; JSON output matches `InspectOutput` schema
- [ ] `kore ingest` refactored to call shared `remember()` operation; `--json` flag added
- [ ] `kore health` extended to call shared `health()` operation; `--json` flag added; output now includes memory counts by type, index state, and sync state — superseding the old basic API ping behavior and absorbing `kore sync --status` functionality
- [ ] New command `kore insights [query]` added, calling shared `insights()` operation; flags: `--type`, `--status`, `--limit`, `--json`
- [ ] `kore consolidate` enhanced with `--dry-run`, `--no-wait`, and `--json` flags, calling shared `consolidate()` operation
  - Default (no flags): blocks until the consolidation cycle completes, then prints the result — the API already awaits `runConsolidationCycle()` synchronously, so this works today; add a "Consolidating…" spinner while waiting
  - `--no-wait`: triggers the cycle in the background (server fire-and-forget, guarded by tracker to prevent double-firing with the background loop) and returns immediately with `{ status: "triggered" }`
- [ ] `kore status <task-id>` renamed to `kore task <id>` — clean break, no backward-compatibility alias
- [ ] All `--json` outputs: single JSON object to stdout, no color codes, exit 0 on success; non-zero on error with a JSON error object on stderr
- [ ] Human-readable (non-`--json`) output is preserved and unchanged for all existing commands
- [ ] Unit tests for each updated/new command: `--json` output format, new filter flags, renamed `kore task` command
- [ ] `bun test` passes
- [ ] Typecheck passes

---

### MCP-004: stdio Proxy + Agent Setup Documentation

**Description:** As an agent operator, I want to configure any MCP-compatible AI agent to connect to Kore via stdio so that agents can use Kore tools without additional network configuration, and I want clear documentation on how to do it.

**Acceptance Criteria:**
- [ ] `apps/mcp-server/index.ts` implements a lightweight stdio-to-HTTP proxy:
  - On startup: fetch `KORE_API_URL/health` (default: `http://localhost:3000`); if unreachable, write a clear error to stderr ("Kore daemon is not running. Start it with `kore start`.") and exit with code 1
  - If healthy: bridge MCP JSON-RPC over stdio to `KORE_API_URL/mcp` using the MCP SDK's stdio transport
- [ ] `apps/mcp-server/package.json` lists only `@modelcontextprotocol/sdk` as a dependency — no tool logic, no imports from core-api
- [ ] `kore mcp` CLI command added, executing the stdio proxy (`bun run apps/mcp-server/index.ts`)
- [ ] `KORE_MCP_ENABLED`, `KORE_MCP_PATH`, `KORE_MCP_DEFAULT_RECALL_LIMIT`, `KORE_MCP_MIN_SCORE` added to `.env.example` with inline descriptions
- [ ] `docs/mcp-setup.md` created covering:
  - Architecture overview: daemon-required model, stdio proxy pattern, why two components
  - Generic MCP client configuration: `command` + `args` pattern with `kore mcp` as the command
  - Claude Desktop `claude_desktop_config.json` example (concrete reference)
  - Claude Code `.mcp.json` example (concrete reference)
  - Available tools: name, one-line purpose, key parameters for each of the 6 tools
  - Environment variables reference
  - Troubleshooting: daemon not running, `/mcp` unreachable, no results from `recall`
- [ ] Documentation makes clear the setup works for any MCP-compatible agent; Claude Desktop/Code are examples, not the only targets
- [ ] Typecheck passes

---

### MCP-005: Integration Tests

**Description:** As a developer, I want end-to-end integration tests that connect an MCP client to the running embedded server and verify each tool's full behavior so that regressions are caught before shipping.

**Acceptance Criteria:**
- [ ] Integration test file (e.g., `apps/core-api/src/mcp.integration.test.ts`) connects to the MCP server over HTTP at `/mcp` using the MCP SDK client against a real test environment (real QMD index, real SQLite queue, real memory files)
- [ ] Test coverage:
  - `recall`: returns structured results matching `RecallOutput` schema; pagination (`offset`/`has_more`) works correctly; type and intent filters return only matching results; `min_confidence` filter works
  - `remember`: returns `{ status: "queued", task_id }` with a valid task ID
  - `inspect`: returns full memory with `content` (full file) and `distilled_items` (parsed list)
  - `insights`: returns only `status: "active"` insights by default; `insight_type` filter works
  - `health`: returns `memories.total`, `queue`, `index` fields with correct types
  - `consolidate --dry_run=true`: returns `{ status: "dry_run", message }` without writing files
- [ ] Retired insight exclusion: create a memory file with `type: insight` and `status: retired`, verify `recall` does not return it
- [ ] `remember` → `recall` round-trip: enqueue content, wait for worker processing, verify memory appears in `recall` results
- [ ] Error handling: `inspect` with unknown ID returns `isError: true`; `recall` with empty query returns `isError: true`
- [ ] `bun test` passes
- [ ] Typecheck passes

---

## Functional Requirements

- **FR-1:** The MCP server MUST run embedded in the core-api process — no separate process, port, or listener. HTTP transport is mounted at `/mcp` on port 3000.
- **FR-2:** The stdio entry point MUST be a lightweight proxy to the running daemon's `/mcp` endpoint. It MUST NOT instantiate its own MemoryIndex, QMD connection, or SQLite connections.
- **FR-3:** The stdio entry point MUST exit with a human-readable error if the core-api daemon is not reachable at startup.
- **FR-4:** All 6 MCP tools MUST return structured JSON exactly matching the schemas in design doc §4.
- **FR-5:** `recall` MUST exclude memories with `type: "insight"` and `status: "retired"` from results by default.
- **FR-6:** `recall` MUST support pagination via `offset`; the response MUST include `has_more: boolean`.
- **FR-7:** `inspect` MUST return `distilled_items` parsed from the `## Distilled Memory Items` Markdown section, and `content` as the full raw file content.
- **FR-8:** `remember` MUST pass `suggested_tags` and `suggested_category` as hints to the ingestion queue.
- **FR-9:** `health` MUST return: memory counts by type, queue state (pending/processing/failed), index state (documents/embedded/status), and sync state.
- **FR-10:** All MCP tool business logic MUST live in `apps/core-api/src/operations/` and be callable by both MCP tools and CLI commands.
- **FR-11:** Every CLI command MUST support a `--json` flag whose output matches the corresponding MCP tool's output schema exactly.
- **FR-12:** `kore status <task-id>` MUST be renamed to `kore task <id>` with no backward-compatibility alias.
- **FR-13:** MCP server startup MUST be gated by `KORE_MCP_ENABLED` (default: `true`).
- **FR-14:** All MCP tool errors MUST be returned as structured MCP error responses (`isError: true`) — no unhandled exceptions.
- **FR-15:** Agents MUST NOT be able to delete or overwrite memories via MCP. There is no delete, update, or overwrite tool.

---

## Non-Goals

- **MCP Resources** (`kore://memory/{id}` URI scheme) — deferred until agent support matures
- **MCP Prompts** (predefined prompt templates like "summarize my knowledge about X") — deferred until tools are proven
- **Streaming responses** for large `recall` result sets — deferred
- **`append_to_id`** or any tool to update/amend an existing memory — excluded by design; consolidation handles knowledge merging
- **Destructive tools** (delete, forget, clear) — excluded by design (§2.5 of design doc)
- **Agent usage analytics** (logging tool_name + query + agent_id for calibration) — Phase 5, not in this PRD
- **QMD MCP server changes** — QMD's existing MCP server is unchanged; both servers coexist

---

## Technical Considerations

- **MCP SDK**: `@modelcontextprotocol/sdk` added to `apps/core-api/package.json`; `apps/mcp-server/package.json` depends on it separately (no shared workspace dep needed)
- **`parseMemoryFileFull` extraction**: currently a private function in `apps/core-api/src/app.ts:146`; must be extracted to `operations/inspect.ts` and exported — verify no other callers break
- **`extractDistilledItems` implementation**: parse the `## Distilled Memory Items` section by finding the heading and collecting subsequent `- ` bullet lines until the next heading or EOF
- **QMD over-fetch ceiling**: use `Math.max(100, offset + limit * 2)` to avoid runaway fetches on large offsets while maintaining enough headroom for post-filtering
- **Bun.serve() `/mcp` route**: mount using the MCP SDK's Streamable HTTP transport handler on the existing server; confirm SDK compatibility with Bun's fetch-based routing
- **`health()` and existing REST endpoint**: `/api/v1/health` currently returns `{ status, version, qmd, queue_length }`; after refactor it should call `health()` and merge/extend the response — avoid breaking the existing response shape for any current consumers
- **Consolidation system is complete**: Phase 3 (insight tools) is not blocked; `insights()` and `consolidate()` operations can be implemented alongside the rest

---

## Success Metrics

- All 6 MCP tools return correctly structured JSON when called from any MCP-compatible client
- `bun test` passes across all new and updated test files (unit + integration)
- `kore mcp` starts the stdio proxy cleanly when the daemon is running; exits with a helpful error when not
- `recall` called before a topic-relevant question correctly surfaces memories from the user's knowledge base
- `kore search --json` output is byte-for-byte compatible with the `recall` MCP tool output schema

---

## Open Questions

None — all questions resolved during PRD review:

- **`/api/v1/health` backward compat**: No backward compatibility required. The endpoint is updated to return the full `HealthOutput` schema (memory counts, index state, sync state).
- **`kore consolidate` wait behavior**: Default blocks until the cycle completes (already the case — the API awaits `runConsolidationCycle()` synchronously). `--no-wait` triggers in the background and returns `{ status: "triggered" }` immediately. No streaming protocol needed.

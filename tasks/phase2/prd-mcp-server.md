# PRD: Kore MCP Server

## Introduction

Kore needs a native MCP (Model Context Protocol) server to expose its personal memory system to AI agents in a structured, semantically-aware way. Today, agents can only access Kore through QMD's generic MCP server, which returns raw Markdown, has no write path, no structured filtering, and no lifecycle awareness.

This PRD covers the full implementation: a shared operations module (business logic reusable by both MCP and CLI), an MCP server embedded in core-api with 6 tools, CLI alignment, a stdio proxy for MCP-compatible agents, and setup documentation applicable to any MCP client.

The result: agents can search, save, inspect, and synthesize the user's personal knowledge without needing to parse YAML, understand Kore's internal structure, or manage a separate process.

Reference design: `docs/design/mcp_server_design.md`

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
  - `consolidate(params, deps): Promise<ConsolidateOutput>` — ensure output fields are serialized to `snake_case` (e.g., `insight_id`, `cluster_size`, `proposed_insight_type`) for consistency with other tools
- [ ] Each function accepts injected dependencies (`qmdClient`, `memoryIndex`, `queue`, `dataPath`) rather than importing globals — required for unit testing with mocks
- [ ] `recall()` accepts `query` as **optional**. When omitted, scans the memory index directly, applies filters, and returns paginated results sorted by `date_saved` descending (no QMD search). When provided, uses an **iterative batch loop** (batch size 50) — fetches from QMD in batches, enriches via `parseMemoryFileFull`, applies Kore-level filters (type, intent, tags, min_confidence, min_score, created_after, created_before, include_insights, retired insight exclusion), and accumulates results until `offset + limit` filtered matches are found or QMD is exhausted. Shared filter logic is extracted into an `applyKoreFilters()` helper used by both paths. Pagination via `offset` / `has_more`
- [ ] `inspect()` parses the `## Distilled Memory Items` Markdown section into `distilled_items: string[]`; returns `content` as the full raw file content (frontmatter + body), **truncated at 20,000 characters** to prevent agent context overflow — `distilled_items` always contains the key facts regardless of truncation
- [ ] A shared `extractDistilledItems(fileContent: string): string[]` helper is exported and used by both `inspect()` and `recall()`
- [ ] `insights()` no-query path scans `$KORE_DATA_PATH/insights/` directly; query path searches QMD filtered to `type === "insight"` and the requested `status` (default: `"active"`)
- [ ] `health()` returns `version` (core-api version string), memory counts by type, queue state (pending/processing/failed), index state (documents/embedded/status), and sync state — superseding the existing `/api/v1/health` response; the existing REST health endpoint is refactored to call `health()` for consistency
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
- [ ] MCP server mounts a Streamable HTTP transport at `/mcp` on the existing Bun.serve() instance in core-api (port 3000) — no separate listener or port. **CRITICAL: The `/mcp` route MUST be protected by the same `KORE_API_KEY` bearer token authentication as the REST API.**
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
- [ ] `kore consolidate` enhanced with `--dry-run` and `--json` flags, calling shared `consolidate()` operation
  - Default (no flags): blocks until the consolidation cycle completes, then prints the result — the API already awaits `runConsolidationCycle()` synchronously; add a "Consolidating…" spinner while waiting
  - Result status is one of: `consolidated`, `no_seed`, `cluster_too_small`, `retired_reeval`, `synthesis_failed`
  - Dry-run returns either `{ status: "dry_run", seed, candidates, ... }` (candidates found) or `{ status: "no_seed" }` (nothing to consolidate)
- [ ] `kore status <task-id>` renamed to `kore task <id>` — clean break, no backward-compatibility alias
- [ ] All `--json` outputs: single JSON object to stdout, no color codes, exit 0 on success; non-zero on error with a JSON error object on stderr
- [ ] Human-readable (non-`--json`) output is preserved for commands where the underlying data is unchanged; `kore health` output is extended with new sections (memory counts, index state, sync state)
- [ ] Unit tests for each updated/new command: `--json` output format, new filter flags, renamed `kore task` command
- [ ] `bun test` passes
- [ ] Typecheck passes

---

### MCP-004: stdio Proxy + Agent Setup Documentation

**Description:** As an agent operator, I want to configure any MCP-compatible AI agent to connect to Kore via stdio so that agents can use Kore tools without additional network configuration, and I want clear documentation on how to do it.

**Acceptance Criteria:**
- [ ] `apps/mcp-server/index.ts` implements a lightweight stdio-to-HTTP proxy:
  - On startup: fetch `KORE_API_URL/health` (default: `http://localhost:3000`); if unreachable, write a clear error to stderr ("Kore daemon is not running. Start it with `kore start`.") and exit with code 1
  - If healthy: bridge MCP JSON-RPC over stdio to `KORE_API_URL/mcp` using the MCP SDK's client with a `StreamableHTTPClientTransport`.
  - **CRITICAL**: The proxy MUST read `KORE_API_KEY` from the environment and include it as an `Authorization: Bearer <token>` header in both the `health` fetch check and the `StreamableHTTPClientTransport` configuration.
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
  - `consolidate --dry_run=true`: returns `{ status: "dry_run" }` with candidates or `{ status: "no_seed" }` without writing files
- [ ] Retired insight exclusion: create a memory file with `type: insight` and `status: retired`, verify `recall` does not return it
- [ ] `remember` → `recall` round-trip: enqueue content, wait for worker processing, verify memory appears in `recall` results
- [ ] `recall` with no query and type filter: returns matching memories sorted by `date_saved` descending
- [ ] Error handling: `inspect` with unknown ID returns `isError: true`
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
- **FR-7:** `inspect` MUST return `distilled_items` parsed from the `## Distilled Memory Items` Markdown section, and `content` as the full raw file content truncated at 20,000 characters.
- **FR-7a:** `recall` MUST accept `query` as optional. When omitted, it returns memories sorted by `date_saved` descending without a QMD search.
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
- **QMD iterative batch fetching**: QMD does not support pre-filtering by frontmatter fields (type, intent, tags). `recall()` fetches from QMD in fixed batches of 50, applies Kore-level filters post-search, and keeps fetching until enough filtered results are accumulated or QMD is exhausted. This avoids the pagination trap where a fixed over-fetch multiplier returns zero matches when filters are highly selective
- **Elysia Framework Integration (`/mcp` route)**: `apps/core-api/src/app.ts` uses Elysia, which uses Web Standard `Request`/`Response` under Bun. Use `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp` — it is purpose-built for this (Bun, Deno, Cloudflare Workers, Hono). The Elysia route is a direct drop-in with no framework bypassing needed:
  ```typescript
  app.all('/mcp', async (ctx) => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    await mcpServer.connect(transport);
    return transport.handleRequest(ctx.request); // ctx.request is a standard Web API Request
  });
  ```
  Do NOT use `SSEServerTransport` — that is the older Node.js HTTP-based approach and is incompatible with Elysia's request model.
- **stdio-to-HTTP Proxy Implementation Strategy**: The MCP SDK has no built-in "proxy" utility. `apps/mcp-server/index.ts` should use the MCP Client + Server bridge pattern (Option 1): instantiate an MCP `Server` with `StdioServerTransport` (facing Claude/the agent) and an MCP `Client` with `StreamableHTTPClientTransport` (pointing at `KORE_API_URL/mcp`), then forward tool call requests from the Server to the Client and relay responses back. Use `StreamableHTTPClientTransport` (not `SSEClientTransport`) — the daemon uses `WebStandardStreamableHTTPServerTransport` which speaks the Streamable HTTP protocol. The SDK's example at `examples/server/` shows the server-side patterns; the client-side transport is in `client/streamableHttp`.
- **`health()` and existing REST endpoint**: `/api/v1/health` currently returns `{ status, version, qmd, queue_length }`; after refactor it should call `health()` and return the full `HealthOutput` schema. No backward compatibility required — the CLI is in the same repo and gets updated together
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
- **`kore consolidate` wait behavior**: Default blocks until the cycle completes (already the case — the API awaits `runConsolidationCycle()` synchronously, typically <5s). No `--no-wait` flag — the background consolidation loop already handles async synthesis every 30 minutes.

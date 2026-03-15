# PRD: Kore CLI

## Introduction

Kore needs a command-line interface so users can interact with the memory system without crafting raw HTTP requests. The CLI will be a standalone app (`apps/cli`) that communicates with a running `core-api` instance over HTTP. It supports ingesting files and stdin, checking task status, listing and viewing memories, and basic system health checks. The CLI is independently installable via `bun install -g` and does not require the rest of the monorepo to function.

## Goals

- Provide a friendly, unix-composable CLI for all common Kore operations (ingest, list, show, delete, status, health).
- Support stdin piping and file glob patterns for ingestion.
- Show real-time progress when waiting for ingestion tasks to complete.
- Work against any running Kore API instance (local, Docker, remote).
- Be installable globally (`bun install -g`) or runnable from the monorepo (`bun run`).
- Support machine-readable (JSON) output across all commands for automation.

## User Stories

### US-001: Scaffold CLI with health, config, and global install

**Description:** As a developer, I need the CLI project scaffolded with a command parser, shared HTTP client, and foundational commands (`health`, `config`) so that the CLI is immediately installable and useful for verifying connectivity.

**Acceptance Criteria:**

#### Scaffolding
- [ ] Create `apps/cli/` with `package.json` (`name: "@kore/cli"`, `bin: { "kore": "./src/index.ts" }`, `type: "module"`).
- [ ] Add a `src/index.ts` entry point that parses subcommands and flags using `commander`.
- [ ] Running `kore` with no arguments prints a usage summary listing all available commands.
- [ ] Running `kore --help` prints the same usage summary.
- [ ] Running `kore --version` prints the package version from `package.json`.
- [ ] Running an unknown subcommand prints an error message and the usage summary, then exits with code 1.
- [ ] The CLI reads `KORE_API_URL` (default `http://localhost:3000`) and `KORE_API_KEY` from environment variables. Bun auto-loads `.env` from the working directory.
- [ ] Create a shared HTTP client module (`src/api.ts`) that wraps `fetch` with the base URL and `Authorization: Bearer <key>` header. All subsequent commands use this module.
- [ ] If `KORE_API_KEY` is not set, the CLI prints a warning to stderr: `Warning: KORE_API_KEY not set. Authenticated endpoints will fail.`

#### `kore health` command
- [ ] `kore health` sends `GET /api/v1/health` and prints the response in a human-readable format: API status, version, QMD status, and queue length.
- [ ] Support `--json` flag to print raw JSON response to stdout.
- [ ] If the API is unreachable (connection refused, timeout), print a clear error message to stderr: `Error: Cannot reach Kore API at <url>. Is the server running?` and exit with code 1.
- [ ] Exit code 0 on success, 1 on failure.

#### `kore config` command
- [ ] `kore config` prints the current configuration: `KORE_API_URL`, whether `KORE_API_KEY` is set (masked, e.g., `kore_***...***key`), and the resolved `.env` file path (if one was loaded).
- [ ] No API call is made — this is purely local.
- [ ] Support `--json` flag.

#### Global installation
- [ ] `bun install -g .` from `apps/cli/` installs the `kore` binary globally.
- [ ] `kore --version` works from any directory after global install.
- [ ] The CLI works without the rest of the monorepo present (no workspace dependency imports — only `@kore/cli`'s own `node_modules`).
- [ ] `apps/cli/package.json` lists all runtime dependencies explicitly (no reliance on hoisted workspace deps).
- [ ] Add `apps/cli/` to the root `package.json` workspaces array.

#### Quality
- [ ] Typecheck/lint passes.
- [ ] **[Logic/Backend]** Write unit tests for: argument parsing (unknown command exits 1, `--help` prints usage, `--version` prints version), health command (mock fetch for success and connection failure), and config display with key masking logic.
- [ ] **[Documentation]** Add a `README.md` in `apps/cli/` documenting installation and basic usage. Update root `README.md` to document global CLI installation (`bun install -g ./apps/cli`) and add the CLI to the package documentation table.

---

### US-002: Ingest and status commands

**Description:** As a user, I want to submit text content for extraction and check task progress so that the LLM processes it into a structured memory and I can monitor the result.

**Acceptance Criteria:**

#### `kore ingest` command
- [ ] `kore ingest <file>` reads the file and sends its contents to `POST /api/v1/ingest/raw` with `source` set to the filename.
- [ ] `kore ingest <file1> <file2> ...` and `kore ingest ./notes/*.md` (shell glob) ingests multiple files sequentially, printing status for each.
- [ ] `echo "some text" | kore ingest` reads from stdin when no file argument is provided. The `source` defaults to `"stdin"`.
- [ ] `--source <name>` overrides the source label (e.g., `kore ingest article.md --source "Hacker News"`).
- [ ] `--url <url>` attaches an `original_url` to the ingestion payload.
- [ ] `--priority <low|normal|high>` sets the queue priority (default: `normal`).
- [ ] **Default behavior (wait mode):** After submitting, the CLI polls `GET /api/v1/task/:id` every 2 seconds and displays a progress line using `nanospinner`. When the task completes, print: `✓ Ingested "<source>" → task <id> completed`. If the task fails, print the error from `error_log` and exit with code 1.
- [ ] `--no-wait` flag skips polling and immediately prints: `Queued task <id> (source: "<source>"). Check status: kore status <id>` then exits with code 0.
- [ ] Support `--json` flag (with `--no-wait`) to output `{ "task_id": "...", "source": "..." }`.
- [ ] For multi-file ingestion, each file is submitted and awaited sequentially. A summary line is printed at the end: `✓ 3/3 files ingested successfully` or `⚠ 2/3 files ingested, 1 failed`.
- [ ] If the file does not exist, print an error and skip it (do not exit — continue with remaining files).

#### `kore status` command
- [ ] `kore status <task-id>` sends `GET /api/v1/task/:id` and prints the task status, creation time, last update time, and error log (if any) in a human-readable format.
- [ ] Support `--json` flag to print raw JSON task object.
- [ ] If the task is not found (404), print `Error: Task <id> not found.` and exit with code 1.
- [ ] Exit code 0 on success, 1 on failure.

#### Quality
- [ ] Typecheck/lint passes.
- [ ] **[Logic/Backend]** Write unit tests: mock fetch to test single file ingest, stdin ingest, `--no-wait` output, multi-file summary, task failure handling, status found/not-found, and API connection failure.
- [ ] **[Documentation]** Update `apps/cli/README.md` with `ingest` and `status` usage and examples.

---

### US-003: Memory management — list, show, delete + API endpoints

**Description:** As a user, I want to browse, view, and delete my stored memories so I can manage what has been ingested.

**Acceptance Criteria:**

#### New API endpoints (in `core-api`)
- [ ] **New API endpoint** `GET /api/v1/memories` added to `core-api`.
    - **Query params:** `type` (optional), `limit` (default 20, max 100).
    - **Response:** `Array<{ id: string, type: string, title: string, source: string, date_saved: string, tags: string[] }>`.
- [ ] **New API endpoint** `GET /api/v1/memory/:id` added to `core-api`.
    - **Response:** `{ id, type, category, date_saved, source, tags, url, title, content }`. `content` is the full raw Markdown.

#### `kore list` command
- [ ] `kore list` calls `GET /api/v1/memories` and prints a table using `cli-table3` with columns: `ID` (first 8 chars), `Type`, `Title`, `Source`, `Date Saved`.
- [ ] `kore list --type <type>` filters by memory type.
- [ ] `kore list --limit <n>` limits the number of results.
- [ ] `kore list --json` prints the raw array of memory objects.
- [ ] If no memories are found, `kore list` prints `No memories found.`.

#### `kore show` command
- [ ] `kore show <id>` calls `GET /api/v1/memory/:id` and prints the full Markdown content.
- [ ] `kore show <id> --json` prints the JSON representation of the memory.
- [ ] If the memory is not found (404), `kore show` prints `Error: Memory <id> not found.` and exit with code 1.

#### `kore delete` command
- [ ] `kore delete <id>` sends `DELETE /api/v1/memory/:id`.
- [ ] On success, prints `✓ Deleted memory <id>.`.
- [ ] If the memory is not found (404), print `Error: Memory <id> not found.` and exit with code 1.
- [ ] `--force` flag skips confirmation. Without it, the CLI prompts: `Delete memory <id>? [y/N]` using `enquirer` or manual readline.
- [ ] Exit code 0 on success, 1 on failure.

#### Quality
- [ ] Typecheck/lint passes.
- [ ] **[Logic/Backend]** Write unit tests for both the new API endpoints (in `core-api`) and the CLI commands (mock fetch). Test filtering by type, limit, empty results, 404 cases, delete success/not-found, and confirmation prompt behavior.
- [ ] **[Documentation]** Update `apps/cli/README.md` with `list`, `show`, and `delete` usage.

## Functional Requirements

- FR-1: The CLI must communicate with `core-api` exclusively over HTTP. No direct database or filesystem access.
- FR-2: All authenticated API calls must include the `Authorization: Bearer <KORE_API_KEY>` header.
- FR-3: The `ingest` command must support reading from both file paths and stdin.
- FR-4: The `ingest` command must poll for task completion by default, with a `--no-wait` flag to skip polling.
- FR-5: Multi-file ingestion must process files sequentially and report a summary with success/failure counts.
- FR-6: All commands must exit with code 0 on success and code 1 on any error.
- FR-7: The `list` command requires a new `GET /api/v1/memories` endpoint on `core-api` that returns memory summaries with optional type filtering and limit.
- FR-8: The `show` command requires a new `GET /api/v1/memory/:id` endpoint on `core-api` that returns the full memory content.
- FR-9: The `delete` command must prompt for confirmation unless `--force` is passed.
- FR-10: The CLI must be installable globally via `bun install -g` and function independently of the monorepo.
- FR-11: All commands must support a `--json` flag for machine-readable output.

## Technical Specification

### Project Structure (apps/cli)
- `src/index.ts`: Entry point, command registration using `commander`.
- `src/api.ts`: API client wrapper using `fetch`.
- `src/commands/`: Individual command implementation modules.
- `src/utils/`: Formatting, spinner, and environment helpers.
- `tests/`: Unit and integration tests using `bun test`.

### Dependencies (Keep minimal)
- `commander`: Argument parsing.
- `nanospinner`: Progress indicators.
- `cli-table3`: Table formatting for `list`.
- `enquirer`: Interactive prompts for `delete`.
- `chalk` or `picocolors`: ANSI colors.

### API Contract Details

**GET /api/v1/memories**
```json
[
  {
    "id": "e4a1f...",
    "type": "note",
    "title": "Meeting with Bob",
    "source": "stdin",
    "date_saved": "2024-03-20T10:00:00Z",
    "tags": ["work", "meeting"]
  }
]
```

**GET /api/v1/memory/:id**
```json
{
  "id": "e4a1f...",
  "type": "note",
  "category": "qmd://work/meetings",
  "date_saved": "2024-03-20T10:00:00Z",
  "source": "stdin",
  "tags": ["work", "meeting"],
  "url": "https://example.com/notes/1",
  "title": "Meeting with Bob",
  "content": "# Meeting with Bob\n\n## Distilled Memory Items\n- Fact 1\n- Fact 2\n\n---\n## Raw Source\nFull original text..."
}
```

## Non-Goals

- No search command — QMD CLI already provides `qmd search`, `qmd query`, and `qmd vsearch`.
- No interactive/TUI mode (e.g., `fzf`-style memory browser).
- No `edit` or `update` command — users can edit markdown files directly in `$KORE_DATA_PATH`.
- No shell completions (can be added later).
- No configuration file (`~/.korerc`) — environment variables are sufficient.
- No authentication management (login/logout) — the API key is set via environment variable.

## Technical Considerations

- **Arg parsing:** Use `commander`. It's robust and well-documented.
- **Spinner/progress:** Use `nanospinner`. Disable when stdout is not a TTY or `--json` is set.
- **Stdin detection:** Use `process.stdin.isTTY` to detect whether input is being piped. If stdin is a TTY and no file arguments are provided, show usage help instead of hanging.
- **HTTP client:** A thin wrapper around `fetch` (built into Bun).
- **Independent installability:** `apps/cli/package.json` must not reference `@kore/*` workspace packages in `dependencies`. Use types only in `devDependencies` if needed, but the final build must be self-contained.
- **Error output:** All errors and warnings go to `stderr`. Only command output goes to `stdout`.

## Success Metrics

- A user can ingest a file and see the completed result in under 30 seconds (including LLM processing time).
- All common operations (ingest, list, show, delete) are achievable in a single CLI command.
- The CLI is installable and functional on a machine that does not have the Kore monorepo cloned.

## Open Questions

- Should `kore ingest` support a `--type` flag to force a memory type, bypassing LLM classification?
- Should there be a `kore ingest --dry-run` that shows what would be sent without actually queuing?

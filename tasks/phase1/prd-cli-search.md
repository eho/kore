# PRD: CLI Search Command

## Introduction

The Kore core API now supports a `/api/v1/search` endpoint that performs hybrid semantic search (BM25 + vector + LLM reranking) against the QMD index. Currently, users have no way to access this search capability from the command line.

This feature will add a new `search` command to the `kore` CLI (`apps/cli`), allowing users to query their memories directly from the terminal.

## Goals

- Add a `kore search <query>` command to the CLI.
- Support all query parameters available in the search API (`intent`, `limit`, `collection`).
- Provide human-readable output by default, highlighting the title, path, and best snippet for each result.
- Support a `--json` flag for machine-readable output.
- Integrate seamlessly with the existing CLI structure (Commander.js).

## User Stories

### CLI-SEARCH-001: Implement `kore search` command

**Description:** As a user, I want to use `kore search <query>` in my terminal so that I can quickly find relevant memories using semantic search without needing to hit the API manually.

**Acceptance Criteria:**
- [ ] Add `search` command in `apps/cli/src/index.ts`.
- [ ] Create `apps/cli/src/commands/search.ts` with the command implementation.
- [ ] The command accepts `<query>` as a positional argument. If omitted, prompt the user interactively to type a query.
- [ ] The command accepts `--intent <string>` to provide a hint to the reranker.
- [ ] The command accepts `--limit <number>` to restrict the number of results (defaults to 10).
- [ ] The command accepts `--collection <string>` to filter by a specific collection.
- [ ] The command accepts `--json` to bypass formatting and output the results wrapped in a JSON structure with metadata (e.g., `{ "query": "...", "results": [...] }`).
- [ ] The command uses `apiFetch` to POST to `/api/v1/search` with the parsed arguments.
- [ ] If the API returns an error (e.g., 503 "Search index not available"), the CLI outputs the error gracefully and exits with code 1.
- [ ] Typecheck/lint passes
- [ ] **[Documentation]** Update CLI usage guide to include the new `search` command.

### CLI-SEARCH-002: Format search results for terminal reading

**Description:** As a user, I want the default output of `kore search` to be formatted cleanly so that I can easily read the titles, paths, and snippets of the matched memories.

**Acceptance Criteria:**
- [ ] If `--json` is false, iterate through the returned results array.
- [ ] Print each result with a clear separation (e.g., a divider or newline).
- [ ] Display the `title` and `path` prominently.
- [ ] Display the `snippet` to provide context on why this item matched. Truncate snippets to a maximum of 200 characters with "...".
- [ ] If 0 results are returned, inform the user "No results found for '<query>'".
- [ ] Typecheck/lint passes

### CLI-SEARCH-003: Add unit tests for the search command

**Description:** As a developer, I want the `search` command to have test coverage so that future refactors do not break CLI functionality.

**Acceptance Criteria:**
- [ ] Create or update a test file (e.g., `apps/cli/tests/search.test.ts` or add to `cli.test.ts`).
- [ ] Mock the `apiFetch` call to return a fixed array of search results.
- [ ] Verify that `kore search "my query"` outputs the expected formatted results.
- [ ] Verify that `kore search "my query" --json` outputs raw JSON.
- [ ] Verify that API errors are handled properly.
- [ ] Typecheck/lint passes
- [ ] **[Logic/Backend]** Write unit tests covering core logic.

## Functional Requirements

- FR-1: The CLI must implement a `search` command accepting a `<query>` argument. If the `<query>` is not provided, the CLI must prompt the user interactively.
- FR-2: The CLI must accept optional flags: `--intent`, `--limit`, `--collection`, `--json`.
- FR-3: The CLI must make a POST request to `/api/v1/search` with the parsed arguments.
- FR-4: The CLI must output formatted results by default, highlighting the title, path, and snippet.
- FR-5: The CLI must output results wrapped in JSON metadata if the `--json` flag is provided.
- FR-6: The CLI must handle API errors gracefully and exit with code 1.

## Non-Goals (Out of Scope)

- Interactive search UI (e.g., using curses or similar terminal UI frameworks).
- Updating or deleting documents from the search results.
- Implementing the backend search API (already implemented).

## Technical Considerations

- **API Endpoint:** `POST /api/v1/search`
- **Request Payload:** `{ query: string, intent?: string, limit?: number, collection?: string }`
- **Response Format:** Array of `{ path: string, title: string, snippet: string, score: number, collection: string | null }`
- **Formatting:** Consider using a library like `chalk` or `kleur` (if already in dependencies, or native console formatting) to highlight titles or paths for readability.

## Success Metrics

- `kore search "test"` returns valid matching documents.
- `kore search --help` accurately lists all options.
- Existing and new CLI tests pass.

## Open Questions

- Should the CLI support pagination or "next page" for search results in future iterations, or is the `limit` sufficient for now?

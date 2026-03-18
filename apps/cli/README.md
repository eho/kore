# @kore/cli

The official command-line interface for Kore — a context-aware personal memory engine.

## Installation

### Global install (recommended)

```sh
# From the monorepo root:
cd apps/cli && bun link

# To uninstall:
bun unlink

# Verify:
kore --version
```

### Run from the monorepo (no install required)

```sh
bun run apps/cli/src/index.ts <command>
# or
bun run --filter @kore/cli start
```

## Configuration

The CLI reads configuration from environment variables. Bun auto-loads `.env` from the working directory.

| Variable       | Default                   | Description                    |
| -------------- | ------------------------- | ------------------------------ |
| `KORE_API_URL` | `http://localhost:3000`   | Base URL of the Kore API       |
| `KORE_API_KEY` | _(none)_                  | API key for authenticated calls |

Example `.env`:

```
KORE_API_URL=http://localhost:3000
KORE_API_KEY=your-secret-key-here
```

## Commands

### `kore health`

Check the health of the Kore API server.

```sh
kore health
kore health --json   # machine-readable JSON output
```

Example output:

```
API Status:   ok
Version:      1.0.0
QMD Status:   ok
Queue Length: 0
```

Exits with code `1` if the API is unreachable.

---

### `kore config`

Show the current CLI configuration (no API call made).

```sh
kore config
kore config --json   # machine-readable JSON output
```

Example output:

```
KORE_API_URL:  http://localhost:3000
KORE_API_KEY:  kore_***...***key
Env file:      /Users/you/project/.env
```

---

### `kore ingest`

Submit text content for memory extraction. Reads from files or stdin.

```sh
# Ingest a single file (waits for completion by default)
kore ingest notes.md

# Ingest multiple files
kore ingest file1.md file2.md ./notes/*.md

# Pipe from stdin
echo "Some important text" | kore ingest

# Override source label
kore ingest article.md --source "Hacker News"

# Attach original URL
kore ingest article.md --url "https://example.com/article"

# Set queue priority
kore ingest large-doc.md --priority high

# Skip waiting for completion
kore ingest notes.md --no-wait

# JSON output (with --no-wait)
kore ingest notes.md --no-wait --json
```

Options:

| Flag               | Description                                  |
| ------------------ | -------------------------------------------- |
| `--source <name>`  | Override the source label                    |
| `--url <url>`      | Attach an original URL to the payload        |
| `--priority <lvl>` | Queue priority: `low`, `normal`, `high`      |
| `--no-wait`        | Skip polling, return immediately             |
| `--json`           | Output JSON (use with `--no-wait`)           |

---

### `kore list`

List stored memories in a table view.

```sh
kore list
kore list --type note         # filter by type (place, media, note, person, insight)
kore list --limit 50          # set max results (default 20, max 100)
kore list --json              # output raw JSON array
```

Example output:

```
┌──────────┬───────┬────────────────────┬─────────────┬────────────┐
│ ID       │ Type  │ Title              │ Source      │ Date Saved │
├──────────┼───────┼────────────────────┼─────────────┼────────────┤
│ aaaaaaaa │ note  │ My First Note      │ apple_notes │ 3/7/2026   │
│ bbbbbbbb │ place │ Tokyo Ramen Shop   │ manual      │ 3/8/2026   │
└──────────┴───────┴────────────────────┴─────────────┴────────────┘
```

When listing insights (`--type insight`), the table shows insight-specific columns:

```
┌──────────────┬────────────────────┬─────────────────┬────────┬────────────┬─────────┬──────┬────────────┐
│ ID           │ Title              │ Insight Type    │ Status │ Confidence │ Sources │ Tags │ Date Saved │
├──────────────┼────────────────────┼─────────────────┼────────┼────────────┼─────────┼──────┼────────────┤
│ ins-a1b2c3d4 │ React Patterns     │ cluster_summary │ active │ 0.72       │ 4       │ ...  │ 3/18/2026  │
└──────────────┴────────────────────┴─────────────────┴────────┴────────────┴─────────┴──────┴────────────┘
```

Prints `No memories found.` if the result set is empty.

Options:

| Flag            | Description                                          |
| --------------- | ---------------------------------------------------- |
| `--type <type>` | Filter by type: `place`, `media`, `note`, `person`, `insight` |
| `--limit <n>`   | Max number of results (default `20`, max `100`)      |
| `--json`        | Output raw JSON array                                |

---

### `kore show`

Show the full content of a stored memory.

```sh
kore show <id>
kore show <id> --json   # output JSON representation
```

Prints the full raw Markdown content of the memory. Exits with code `1` if not found.

---

### `kore delete`

Delete a stored memory.

```sh
kore delete <id>           # prompts for confirmation
kore delete <id> --force   # skip confirmation
```

Example output:

```
✓ Deleted memory aaaaaaaa-1234-5678-abcd-000000000001.
```

Options:

| Flag      | Description                |
| --------- | -------------------------- |
| `--force` | Skip confirmation prompt   |

Exits with code `0` on success, `1` on failure or if not found.

---

### `kore reset`

Delete all memories, tasks, and the search index in one step. Useful for starting a fresh test session.

```sh
kore reset           # prompts for confirmation before proceeding
kore reset --force   # skip confirmation (for scripting)
```

Example output:

```
✓ Reset complete. Deleted 12 memories and 3 tasks.
```

Options:

| Flag      | Description                |
| --------- | -------------------------- |
| `--force` | Skip confirmation prompt   |

Exits with code `1` on API error or network failure.

---

### `kore search`

Search memories using hybrid semantic search (BM25 + vector + LLM reranking).

```sh
kore search "tokyo ramen"
kore search "meeting notes" --limit 5
kore search "project ideas" --collection work
kore search "debugging tips" --intent "programming reference" --json

# Interactive mode (prompts for query)
kore search
```

Example output (formatted):

```
Tokyo Ramen Shop
data/places/tokyo-ramen.md
Amazing ramen spot in Shinjuku with rich tonkotsu broth...
───
Travel Notes: Japan Trip
data/notes/japan-trip.md
Visited several ramen shops including the famous one in...
```

Example output (`--json`):

```json
{
  "query": "tokyo ramen",
  "results": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "path": "/home/user/kore-data/places/tokyo-ramen.md",
      "title": "Tokyo Ramen Shop",
      "snippet": "Amazing ramen spot in Shinjuku with rich tonkotsu broth...",
      "score": 0.94,
      "collection": "places"
    }
  ]
}
```

The `id` field can be passed directly to `kore show <id>` to fetch the full memory content.

Options:

| Flag                    | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `--intent <string>`     | Hint for the LLM reranker                        |
| `--limit <number>`      | Max results to return (default `10`)             |
| `--collection <string>` | Filter by a specific collection                  |
| `--json`                | Output `{ query, results }` JSON envelope (each result includes `id`) |

Insights appear alongside regular memories in search results. Retired insights are automatically filtered out.

Exits with code `1` on API errors (e.g., search index unavailable).

---

### `kore consolidate`

Trigger a consolidation cycle to synthesize related memories into insights.

```sh
kore consolidate                # run one consolidation cycle
kore consolidate --dry-run      # preview without LLM synthesis
kore consolidate --reset-failed # retry failed consolidations
kore consolidate --json         # machine-readable JSON output
```

Example output:

```
Consolidation complete!
Seed:         "React Hooks Guide" (abc-123)
Cluster Size: 5
Insight ID:   ins-a1b2c3d4
```

Example dry-run output:

```
Seed: "React Hooks Guide" (abc-123)
Candidates (4):
  - "useState Best Practices" (score: 0.72)
  - "Custom Hooks Patterns" (score: 0.68)
  - "React State Management" (score: 0.61)
  - "Hook Testing Strategies" (score: 0.55)
Proposed type: cluster_summary
Estimated confidence: 0.68
```

Options:

| Flag               | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `--dry-run`        | Preview seed, candidates, and type without synthesis  |
| `--reset-failed`   | Reset failed tracker entries before running           |
| `--json`           | Output raw JSON                                      |

---

### `kore status`

Check the status of an ingestion task.

```sh
kore status <task-id>
kore status <task-id> --json   # machine-readable JSON output
```

Example output:

```
Task ID:      abc-123-def
Status:       completed
Source:       notes.md
Created:      2026-03-10T00:00:00Z
Updated:      2026-03-10T00:00:01Z
```

Exits with code `1` if the task is not found.

---

## Global Flags

| Flag        | Description                    |
| ----------- | ------------------------------ |
| `--version` | Print the CLI version          |
| `--help`    | Print usage information        |

## Development

```sh
# Install dependencies
bun install

# Run tests
bun test

# Type check
bunx tsc --noEmit
```

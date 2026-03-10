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

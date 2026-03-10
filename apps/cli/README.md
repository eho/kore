# @kore/cli

The official command-line interface for Kore — a context-aware personal memory engine.

## Installation

### Global install (recommended)

```sh
# From the monorepo root:
bun install -g ./apps/cli

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

# Kore MCP Setup Guide

Connect any MCP-compatible AI agent to your personal knowledge base via Kore's MCP server.

## Architecture

Kore uses a **daemon-required model** with a **stdio proxy** pattern:

```
┌──────────────────────┐         stdio          ┌──────────────────┐
│  MCP Client          │ ◄────────────────────► │  kore mcp        │
│  (Claude, etc.)      │                         │  (stdio proxy)   │
└──────────────────────┘                         └────────┬─────────┘
                                                          │ HTTP
                                                          ▼
                                                 ┌──────────────────┐
                                                 │  Kore Daemon     │
                                                 │  localhost:3000  │
                                                 │  /mcp endpoint   │
                                                 └──────────────────┘
```

**Two components:**

1. **Kore Daemon** — the core-api server that runs continuously, managing memories, the search index, and the ingestion queue. The MCP server is embedded in this process at the `/mcp` HTTP endpoint. Start it with `bun run apps/core-api/src/index.ts`.

2. **stdio Proxy** (`kore mcp`) — a lightweight bridge that translates MCP JSON-RPC over stdio into HTTP requests to the daemon's `/mcp` endpoint. It contains no business logic — all tool execution happens in the daemon.

**Why two components?** MCP clients like Claude Desktop expect to launch a process that speaks MCP over stdio. But Kore's memory system requires a long-running daemon (for the search index, queue worker, consolidation loop, etc.). The stdio proxy bridges these models: the client launches `kore mcp`, which connects to the already-running daemon.

## Prerequisites

1. **Kore daemon running**: Start it with `bun run apps/core-api/src/index.ts`
2. **API key set**: `KORE_API_KEY` must be set in the environment for both the daemon and the proxy

## Generic MCP Client Configuration

Any MCP-compatible client can connect to Kore using the `command` + `args` pattern:

- **Command**: `kore`
- **Args**: `["mcp"]`

The proxy reads these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `KORE_API_URL` | `http://localhost:3000` | Daemon URL |
| `KORE_API_KEY` | _(required)_ | Bearer token for authentication |
| `KORE_MCP_PATH` | `/mcp` | HTTP route path on the daemon |

## Claude Desktop

Add to `claude_desktop_config.json` (located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "kore": {
      "command": "kore",
      "args": ["mcp"],
      "env": {
        "KORE_API_KEY": "your-api-key-here",
        "KORE_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

If `kore` is not on your PATH, use the full path to the binary (e.g., `/usr/local/bin/kore`) or use `bun` directly:

```json
{
  "mcpServers": {
    "kore": {
      "command": "bun",
      "args": ["run", "/path/to/kore/apps/mcp-server/index.ts"],
      "env": {
        "KORE_API_KEY": "your-api-key-here",
        "KORE_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

## Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "kore": {
      "command": "kore",
      "args": ["mcp"],
      "env": {
        "KORE_API_KEY": "your-api-key-here",
        "KORE_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

Or add it globally via Claude Code's settings.

## Available Tools

Once connected, the agent has access to 6 tools:

### recall

Search the user's personal knowledge base. Returns structured results with metadata (type, intent, confidence, tags).

**Key parameters:**
- `query` _(string, optional)_ — Semantic search query. If omitted, returns recent memories sorted by date.
- `type` _(string)_ — Filter: `"place"`, `"media"`, `"note"`, `"person"`
- `intent` _(string)_ — Filter: `"recommendation"`, `"reference"`, `"personal-experience"`, `"aspiration"`, `"how-to"`
- `tags` _(string[])_ — Filter to memories matching ALL tags
- `limit` _(number)_ — Max results (default: 10, max: 50)
- `offset` _(number)_ — Pagination offset
- `min_confidence` _(number)_ — Minimum extraction confidence (0.0–1.0)
- `created_after` / `created_before` _(string)_ — ISO 8601 date filters

### remember

Save noteworthy information to the knowledge base. Content is processed by an LLM to extract key facts.

**Key parameters:**
- `content` _(string, required)_ — The raw content to save
- `source` _(string)_ — Where it came from (default: `"agent"`)
- `suggested_tags` _(string[])_ — Hints for the extraction pipeline
- `suggested_category` _(string)_ — Category hint (e.g., `"travel/food/ramen"`)

### inspect

Get complete details of a specific memory by ID, including full content and distilled facts.

**Key parameters:**
- `id` _(string, required)_ — Memory UUID

### insights

Query the synthesized knowledge layer — higher-order documents combining multiple memories.

**Key parameters:**
- `query` _(string, optional)_ — Semantic search query
- `insight_type` _(string)_ — Filter: `"cluster_summary"`, `"evolution"`, `"contradiction"`, `"connection"`
- `status` _(string)_ — Filter: `"active"`, `"evolving"`, `"degraded"` (default: `"active"`)
- `limit` _(number)_ — Max results (default: 5, max: 20)

### health

Check system health: memory counts, queue status, search index state, sync status.

_No parameters._

### consolidate

Trigger knowledge synthesis — clusters related memories into insight documents.

**Key parameters:**
- `dry_run` _(boolean)_ — Preview only, don't write files (default: false)

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `KORE_API_URL` | `http://localhost:3000` | Base URL of the Kore daemon |
| `KORE_API_KEY` | _(required)_ | Bearer token for API authentication |
| `KORE_MCP_ENABLED` | `true` | Enable/disable the embedded MCP server on core-api |
| `KORE_MCP_PATH` | `/mcp` | HTTP route path for the MCP endpoint |
| `KORE_MCP_DEFAULT_RECALL_LIMIT` | `10` | Default limit for recall results |
| `KORE_MCP_MIN_SCORE` | `0.0` | Minimum QMD relevance score threshold |

## Troubleshooting

### "Kore daemon is not running"

The stdio proxy checks the daemon's health endpoint on startup. If it can't reach the daemon, it exits with this error.

**Fix:** Start the daemon first:
```bash
bun run apps/core-api/src/index.ts
```

### `/mcp` endpoint unreachable (HTTP errors)

If the daemon is running but `/mcp` returns errors:

1. **Check `KORE_MCP_ENABLED`** — ensure it's not set to `false` in the daemon's environment
2. **Check `KORE_API_KEY`** — the proxy and daemon must use the same key
3. **Check `KORE_API_URL`** — ensure the proxy is pointing to the correct host/port

### No results from `recall`

1. **Memories exist?** Run `kore health` to check memory counts
2. **Index ready?** Check if `index.status` is `"ok"` and `index.embedded` > 0
3. **Filters too narrow?** Try broadening: remove `type`/`intent` filters, lower `min_confidence`
4. **Query too specific?** Try shorter, broader search terms

### Agent not seeing tools

Ensure the MCP client configuration is correct:
- `command` points to a valid `kore` binary or `bun` with the correct path
- `env` includes `KORE_API_KEY`
- The daemon is running and healthy

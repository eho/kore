# Kore

**A context-aware personal memory bank.**

Kore solves the "Recall Disconnect" — the gap between saving high-value inspiration and actually remembering it when it matters. It passively ingests content from your existing tools (Apple Notes, bookmarks, etc.), uses an LLM to distill it into structured memories, and surfaces it automatically — through an AI agent via MCP, the CLI, or proactive push nudges based on location and time.

**What makes it different:**

- **Passive ingestion** — you don't change how you work; Kore watches your existing tools
- **LLM-powered understanding** — content is extracted into structured memories with intent, tags, and confidence, not just stored as text
- **Consolidation** — a background loop synthesizes clusters of related memories into higher-order insights over time
- **Agentic-first** — your AI assistant (Claude, OpenClaw, etc.) has direct access to your memory via MCP, and uses it proactively without being asked
- **File-system native** — every memory is a plain `.md` file; no proprietary database lock-in
- **Privacy-first** — runs fully locally with Ollama, or with a cloud LLM if you prefer

### What does "Kore" mean?

- **Greek:** Meaning "the core" or "the heart" — fitting for a personal memory bank.
- **Japanese:** *Kore* (これ) is the demonstrative pronoun for "this" — a literal pointer to the memory being surfaced right now.

### Learn More

See the [Vision Document](docs/vision/vision.md) for the full strategic vision, design principles, and real-world scenarios.

---

## How It Works

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                       INGESTION SOURCES                          │
  │     Apple Notes  ·  Bookmarks  ·  Web Clips  ·  Manual API     │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │      POST /api/v1/remember     │
                  │   ─────────────────────────   │
                  │       SQLite Task Queue        │
                  └───────────────┬───────────────┘
                                  │  worker polls every 5s
                                  ▼
                  ┌───────────────────────────────┐
                  │      LLM  (cloud or local)     │
                  │   ─────────────────────────   │
                  │      structured extraction     │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │      $KORE_HOME/data/*.md      │
                  │   ─────────────────────────   │
                  │    YAML frontmatter + body     │
                  └──────────────┬────────────────┘
                                 │                │
                      file watcher│                │ consolidation loop
                                 ▼                ▼
                  ┌──────────────────┐  ┌─────────────────────┐
                  │    QMD Index     │◄─│    Insight .md       │
                  │  BM25 + vectors  │  │  synthesized from    │
                  │   + reranking    │  │   related clusters   │
                  └────────┬─────────┘  └─────────────────────┘
                           │
              ┌────────────┼─────────────────┐
              ▼            ▼                 ▼
      ┌──────────────┐  ┌──────────┐  ┌──────────────┐
      │  MCP Server  │  │   CLI    │  │ Push Nudges  │
      │  any agent   │  │  & API   │  │  (roadmap)   │
      └──────────────┘  └──────────┘  └──────────────┘
```

1. **Ingest** — raw text arrives via REST API, Apple Notes plugin, or other source
2. **Queue** — task is stored in a local SQLite database and processed asynchronously
3. **Extract** — a background worker calls an LLM (cloud or local via Ollama) to produce structured metadata
4. **Write** — a `.md` file with YAML frontmatter is written to `$KORE_HOME/data/`
5. **Index** — a file watcher detects the new file and triggers `qmd update`
6. **Consolidate** — a background loop clusters related memories and synthesizes higher-order **insight** files
7. **Retrieve** — QMD serves the indexed memories to MCP agents, the CLI, or the REST API

---

## Project Structure

This project is a **Bun monorepo**.

```
kore/
├── apps/
│   ├── core-api/          # REST API server + extraction worker + file watcher + consolidation loop
│   ├── cli/               # Command-line interface for Kore
│   └── mcp-server/        # Stdio-to-HTTP proxy for Claude Desktop, Claude Code, OpenClaw, etc.
├── packages/
│   ├── shared-types/          # Zod schemas and TypeScript interfaces (single source of truth)
│   ├── llm-extractor/         # Vercel AI SDK + Ollama integration
│   ├── qmd-client/            # Typed wrapper around the QMD CLI
│   ├── an-export/             # Apple Notes → Markdown exporter
│   └── plugin-apple-notes/    # Apple Notes sync plugin (passive ingestion)
├── docs/                  # Architecture docs and guides
│   ├── design/            # Feature-level design specs
│   ├── planning/          # Assessments and roadmap
│   └── testing/           # QA and testing guides
└── tasks/                 # PRDs and design docs
```

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- [Ollama](https://ollama.ai/) — install, then pull a model (e.g. `ollama pull qwen2.5:7b`) *(or configure a cloud LLM — see below)*

### 1. Install dependencies

```sh
bun install
```

### 2. Configure environment

```sh
cp .env.example .env
```

Edit `.env`. The primary configuration variable is `KORE_HOME`, which sets the base directory for all Kore data (database files, notes storage). It defaults to `~/.kore` if not set.

```
KORE_HOME=~/.kore
KORE_API_KEY=your-secret-key-here
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
```

| Variable | Default | Description |
|---|---|---|
| `KORE_HOME` | `~/.kore` | Base directory for all Kore data (SQLite queue, notes, QMD cache) |
| `KORE_API_KEY` | *(required)* | Bearer token for API authentication |
| `LLM_PROVIDER` | `ollama` | LLM backend: `ollama` (local) or `gemini` (cloud) |
| `LLM_MODEL` | *(provider default)* | Override the model name for the chosen provider |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL *(when `LLM_PROVIDER=ollama`)* |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Legacy alias for `LLM_MODEL` when using Ollama |
| `GEMINI_API_KEY` | *(required for Gemini)* | Google Gemini API key *(when `LLM_PROVIDER=gemini`)* |
| `XDG_CACHE_HOME` | `~/.cache` | Base cache dir; QMD embedding models stored at `$XDG_CACHE_HOME/qmd` |
| `KORE_SYNTHESIS_MODEL` | *(uses LLM_MODEL)* | Optional model override specifically for insight synthesis |
| `CONSOLIDATION_INTERVAL_MS` | `1800000` (30 min) | How often the consolidation loop runs |
| `CONSOLIDATION_COOLDOWN_DAYS` | `7` | Days before a memory can be re-consolidated |
| `CONSOLIDATION_MAX_ATTEMPTS` | `3` | Max synthesis attempts before marking as failed |

### 3. Start the API

```sh
bun run start
```

The API is now running at `http://localhost:3000`. Logs appear directly in your terminal.

### 4. Install and use the CLI

```sh
# Install globally
bun install -g ./apps/cli

# Check connectivity
kore health

# Send your first memory
kore ingest note.md
```

Or send a memory directly via curl:

```sh
curl -X POST http://localhost:3000/api/v1/remember \
  -H "Authorization: Bearer your-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"source": "manual", "content": "Mutekiya in Ikebukuro — best tsukemen, cash only, 30 min wait."}'
```

### 5. Connect your AI agent

Kore exposes its memory via MCP so any compatible agent (Claude Desktop, Claude Code, etc.) can recall and save memories directly in conversation.

Kore uses a **stdio proxy** pattern — you register the `kore mcp` command with your agent, and it spawns the proxy automatically at session start. The proxy connects to the running daemon at `localhost:3000`.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

**Claude Code** — add to your project's `.mcp.json`:

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

Once connected, your agent has access to 6 tools: `recall`, `remember`, `inspect`, `insights`, `health`, and `consolidate`.

See [`apps/mcp-server/README.md`](apps/mcp-server/README.md) for the full MCP setup guide, tool reference, and troubleshooting.

---

## Plugins

Kore supports plugins for passive ingestion from external sources. Plugins run as background processes within the Kore server and are enabled via environment variables.

### Apple Notes

Automatically syncs your Apple Notes into Kore's memory store. Notes are incrementally exported, transformed with folder context, and processed by the LLM extraction pipeline. Deletions in Apple Notes are reflected in Kore on the next sync cycle.

**Quick start:**

1. Grant **Full Disk Access** to your terminal (System Settings > Privacy & Security)
2. Add to your `.env`:
   ```bash
   KORE_APPLE_NOTES_ENABLED=true
   ```
3. Restart Kore — the first sync runs 10 seconds after startup

**CLI commands:**

```sh
kore sync            # trigger a manual sync
kore sync --status   # check sync status
```

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `KORE_APPLE_NOTES_ENABLED` | `false` | Enable the plugin |
| `KORE_AN_SYNC_INTERVAL_MS` | `900000` (15 min) | Sync interval |
| `KORE_AN_FOLDER_ALLOWLIST` | *(all)* | Comma-separated folders to include |
| `KORE_AN_FOLDER_BLOCKLIST` | *(none)* | Comma-separated folders to exclude |
| `KORE_AN_INCLUDE_HANDWRITING` | `false` | Include handwriting OCR text |

See [`packages/plugin-apple-notes/README.md`](packages/plugin-apple-notes/README.md) for the full configuration reference, API endpoints, content transformation details, and troubleshooting.

---

## Consolidation (Insights)

Kore automatically synthesizes clusters of related memories into higher-order **insight** files. A background consolidation loop runs every 30 minutes, identifying groups of semantically similar memories via QMD hybrid search, classifying the cluster type, and generating a structured synthesis via LLM.

### How it works

1. A **seed memory** is selected from the consolidation tracker (prioritizing re-evaluation of existing insights over new seeds)
2. **QMD hybrid search** finds 3-8 related candidate memories
3. The cluster is **classified** deterministically: `cluster_summary`, `evolution` (>30 day span), or `connection` (cross-category)
4. An **LLM synthesizes** the cluster into a structured insight with title, synthesis paragraph, connections, and distilled items. The LLM may override the type to `contradiction` if conflicting facts are detected.
5. The insight is written to `$KORE_DATA_PATH/insights/` as a standard `.md` file and indexed by QMD
6. Source memories receive `consolidated_at` and `insight_refs` frontmatter back-references

### Reactive lifecycle

- When a **new memory is indexed**, the system checks for related existing insights and flags them for re-evaluation
- When a **source memory is deleted**, insights are transitioned based on remaining source integrity: `evolving` (>=50%), `degraded` (<50%), or `retired` (0%)
- Insights can be **superseded** when re-synthesis produces a better version (old insight is `retired`, new one links via `supersedes`)

### CLI commands

```sh
kore consolidate              # trigger one consolidation cycle
kore consolidate --dry-run    # preview without LLM synthesis
kore consolidate --reset-failed  # retry failed consolidations
kore consolidation reset      # delete all insights and restore source memories to unconsolidated state (preserves ingested memories)
kore list --type insight      # list all insights
kore show <insight-id>        # view full insight content
kore delete <insight-id>      # delete an insight; source memories are automatically restored to the consolidation pool
kore search "topic"           # insights appear in search results (retired insights are filtered out)
```

See [`apps/core-api/README.md`](apps/core-api/README.md) for API endpoint details and the [Consolidation System Design](docs/design/consolidation_system_design.md) for the full specification.

---

## Development

```sh
# Run all unit tests (excludes E2E)
bun test

# Type check all packages
bun run typecheck

# Run tests for a specific package
bun test packages/shared-types
bun test packages/llm-extractor
bun test packages/qmd-client
bun test apps/core-api

# Run E2E tests (requires the API to be running: bun run start)
bun run test:e2e

# Add a dependency to a specific workspace
bun add <package> --filter @kore/core-api
```

---

## Running Natively

Kore runs as a single Bun process — no Docker or process orchestration required. The API server, extraction worker, file watcher, and embedder all run together via `apps/core-api/src/index.ts`.

```sh
# Production
bun run start

# Development (with hot-reload)
bun run dev
```

The API is available at `http://localhost:3000`. All log output (startup, worker activity, watcher events) appears directly in your terminal.

## Building Standalone Binaries

You can compile the API server and CLI into self-contained executables using Bun's `--compile` flag:

```sh
# Build both binaries
bun run build:bin

# Or build individually
bun run --cwd apps/core-api build:bin   # → apps/core-api/bin/kore-server
bun run --cwd apps/cli build:bin        # → apps/cli/bin/kore
```

> **Note on `node-llama-cpp`:** QMD depends on `node-llama-cpp`, which ships pre-built native `.node` binaries for each platform (e.g., `@node-llama-cpp/mac-arm64-metal`). These native addons are **not bundleable** into a single `bun build --compile` executable. The compiled `kore-server` binary falls back gracefully — QMD's embedding features will be unavailable unless you run via `bun run start` (which resolves the native addons through `node_modules`). For production deployments, `bun run start` is the recommended approach. **Spatialite (`mod_spatialite`) must also be installed on the host — it cannot be bundled.**

---

## Package Documentation

| Package | Description |
|---|---|
| [`apps/core-api`](apps/core-api/README.md) | API server, worker, watcher — the main service to run |
| [`apps/cli`](apps/cli/README.md) | Command-line interface — install globally with `bun install -g ./apps/cli` |
| [`packages/shared-types`](packages/shared-types/README.md) | Zod schemas and TypeScript interfaces |
| [`packages/llm-extractor`](packages/llm-extractor/README.md) | LLM extraction via Vercel AI SDK + Ollama |
| [`packages/qmd-client`](packages/qmd-client/README.md) | Typed QMD CLI wrapper |
| [`packages/an-export`](packages/an-export/README.md) | Apple Notes → Markdown exporter |
| [`packages/plugin-apple-notes`](packages/plugin-apple-notes/README.md) | Apple Notes sync plugin — passive ingestion |

## Design & Architecture

See [`docs/README.md`](docs/README.md) for the full documentation index. Key documents:

| Document | Description |
|---|---|
| [Vision](docs/vision/vision.md) | Strategic vision, design principles, real-world scenarios |
| [System Architecture](docs/architecture/architecture.md) | High-level layers, technology stack, data flows |
| [Data Schema](docs/architecture/data_schema.md) | Zod schemas, directory layout, frontmatter format |
| [Consolidation System Design](docs/design/consolidation_system_design.md) | Background consolidation loop, insight lifecycle, synthesis |
| [MCP Server Design](docs/design/mcp_server_design.md) | Agent-facing interface with 6 core tools |

## Roadmap

See [`docs/planning/roadmap.md`](docs/planning/roadmap.md) for the full roadmap — upcoming features, ideas queue, and prioritization framework.

---

## Status

Kore is a personal project in active development. Phase 1 (ingestion pipeline + MCP) and Phase 2 (consolidation + Apple Notes) are complete with a full test suite. The push channel (location/temporal nudges) and additional ingestion sources are on the roadmap.

Issues and pull requests are welcome. For significant changes, open an issue first to discuss the approach.

---

## License

MIT

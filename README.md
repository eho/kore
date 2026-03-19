# Kore

**A context-aware personal memory engine.**

Kore solves the "Recall Disconnect" — the gap between saving high-value inspiration (travel spots, reading recommendations, hobby ideas) and actually remembering to use it. It passively ingests explicitly saved content, distills it into atomic memory items using a local LLM, and indexes them for agentic retrieval via QMD and MCP.

By seamlessly ingesting explicitly saved content from your fragmented digital landscape (Apple Notes, X bookmarks, Safari, etc.), Kore builds a long-term, searchable, and intelligent memory bank. It completely removes the burden of "remembering to remember" by autonomously surfacing the right information exactly when and where you need it—either through seamless conversational AI or proactive, location and context-aware nudges.

### Why "Kore"?

- **Greek:** Meaning "the core" or "the heart." Tied to the Eleusinian Mysteries (memory and cycles) — fitting for a memory engine at the center of the Cronus system.
- **Japanese:** *Kore* (これ) is the demonstrative pronoun for "this." A literal pointer — the piece of memory being surfaced right now.

### Learn More

See the [Vision Document](docs/vision/vision.md) for the full strategic vision, design principles, and real-world scenarios.

---

## How It Works

```
Raw text (Apple Notes, bookmarks, etc.)
        │
        ▼
POST /api/v1/ingest/raw
        │
        ▼
SQLite Queue  ──── worker polls every 5s ────►  Ollama (local LLM)
        │                                              │
        │                                    extract structured data
        │                                              │
        └──────────────────────────────────────────────►
                                                       │
                                              write .md to $KORE_DATA_PATH
                                                       │
                                                 fs.watch fires
                                                       │
                                                  qmd update
                                                       │
                                              indexed for agentic query
```

1. **Ingest** — send raw text to the REST API
2. **Queue** — task is stored in a local SQLite database
3. **Extract** — a background worker picks up the task and calls Ollama via Vercel AI SDK
4. **Write** — a structured `.md` file with YAML frontmatter is written to `$KORE_DATA_PATH`
5. **Index** — a file watcher detects the new file and triggers `qmd update`
6. **Query** — QMD serves the indexed memories to any MCP-compatible agent
7. **Consolidate** — a background loop synthesizes clusters of related memories into higher-order **insight** files via LLM

---

## Project Structure

This project is a **Bun monorepo**.

```
kore/
├── apps/
│   ├── core-api/          # REST API server + extraction worker + file watcher + consolidation loop
│   └── cli/               # Command-line interface for Kore
├── packages/
│   ├── shared-types/          # Zod schemas and TypeScript interfaces (single source of truth)
│   ├── llm-extractor/         # Vercel AI SDK + Ollama integration
│   ├── qmd-client/            # Typed wrapper around the QMD CLI
│   ├── an-export/             # Apple Notes → Markdown exporter
│   └── plugin-apple-notes/    # Apple Notes sync plugin (passive ingestion)
├── docs/                  # Architecture docs and guides
│   ├── phase2/            # Phase 2 design docs (consolidation, MCP)
│   └── manual-e2e-testing.md
├── tasks/                 # PRDs and design docs
└── progress.md            # Project-wide progress tracker
```

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- [Ollama](https://ollama.ai/) — install, then `ollama pull qwen2.5:7b`
- [QMD](https://github.com/tobilu/qmd) — installed and on `$PATH`
- **Spatialite** (required for geospatial memory features):
  - macOS: `brew install spatialite-tools`
  - Linux (Debian/Ubuntu): `apt-get install libsqlite3-mod-spatialite`

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
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model used for LLM extraction |
| `XDG_CACHE_HOME` | `~/.cache` | Base cache dir; QMD models stored at `$XDG_CACHE_HOME/qmd` |
| `KORE_SYNTHESIS_MODEL` | *(uses LLM_MODEL)* | Optional override model for insight synthesis |
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
curl -X POST http://localhost:3000/api/v1/ingest/raw \
  -H "Authorization: Bearer your-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"source": "manual", "content": "Mutekiya in Ikebukuro — best tsukemen, cash only, 30 min wait."}'
```

See `docs/manual-e2e-testing.md` for a complete walkthrough of all scenarios.

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
kore list --type insight      # list all insights
kore show <insight-id>        # view full insight content
kore delete <insight-id>      # delete an insight (cleans up source refs)
kore search "topic"           # insights appear in search results (retired insights are filtered out)
```

See [`apps/core-api/README.md`](apps/core-api/README.md) for API endpoint details and the [Consolidation System Design](docs/phase2/consolidation_system_design.md) for the full specification.

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
| [Consolidation System Design](docs/phase2/consolidation_system_design.md) | Background consolidation loop, insight lifecycle, synthesis |
| [MCP Server Design](docs/phase2/mcp_server_design.md) | Agent-facing interface with 6 core tools |

## Roadmap

See [progress.md](progress.md) for current status and upcoming features.

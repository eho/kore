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

---

## Project Structure

This project is a **Bun monorepo**.

```
kore/
├── apps/
│   └── core-api/          # REST API server + extraction worker + file watcher
├── packages/
│   ├── shared-types/      # Zod schemas and TypeScript interfaces (single source of truth)
│   ├── llm-extractor/     # Vercel AI SDK + Ollama integration
│   ├── qmd-client/        # Typed wrapper around the QMD CLI
│   └── an-export/         # Apple Notes → Markdown exporter
├── docs/                  # Architecture docs and guides
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

### 1. Install dependencies

```sh
bun install
```

### 2. Configure environment

```sh
cp .env.example .env
```

Edit `.env`:

```
KORE_DATA_PATH=~/kore-data
KORE_API_KEY=your-secret-key-here
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
```

### 3. Register your data directory with QMD (one-time)

```sh
qmd collection add ~/kore-data --name kore-memory
```

### 4. Start the API

```sh
bun run --filter @kore/core-api start
```

The API is now running at `http://localhost:3000`. Send your first memory:

```sh
curl -X POST http://localhost:3000/api/v1/ingest/raw \
  -H "Authorization: Bearer your-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"source": "manual", "content": "Mutekiya in Ikebukuro — best tsukemen, cash only, 30 min wait."}'
```

See `docs/manual-e2e-testing.md` for a complete walkthrough of all scenarios.

---

## Development

```sh
# Run all tests
bun test

# Type check all packages
bun run typecheck

# Run tests for a specific package
bun test packages/shared-types
bun test packages/llm-extractor
bun test packages/qmd-client
bun test apps/core-api

# Add a dependency to a specific workspace
bun add <package> --filter @kore/core-api
```

---

## Docker Setup

Kore includes a multi-stage `Dockerfile` and a `docker-compose.yml` at the project root for containerized deployment.

### Prerequisites

- Docker and Docker Compose installed
- Ollama running on the host machine with a model pulled (e.g., `ollama pull qwen2.5:7b`)

### Production Deployment

1. Copy `.env.example` to `.env` and configure your values:

```sh
cp .env.example .env
# Edit .env — set KORE_API_KEY and KORE_DATA_PATH at minimum
```

2. Start all services:

```sh
docker compose up -d
```

This launches two services:

| Service | Description | Port |
|---|---|---|
| `core-api` | HTTP API server (Pull channel) | 3000 |
| `notification-worker` | Background extraction worker + file watcher (Push channel) | — |

Both containers share the same image (`oven/bun:debian`, non-root `bun` user) and volumes:

- **`$KORE_DATA_PATH`** → `/app/data` — Markdown memory files (bind mount to host)
- **`queue-db`** → `/app/db` — Shared SQLite task queue (Docker named volume)

3. Verify the API is running:

```sh
curl http://localhost:3000/api/v1/health
```

### Ollama Connectivity

The containers connect to the host's Ollama instance via `host.docker.internal`. This works automatically on macOS and Windows. On Linux, the `extra_hosts` directive in `docker-compose.yml` maps `host.docker.internal` to the host gateway.

Override the Ollama URL in `.env` if needed:

```sh
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

### Stopping Services

```sh
docker compose down        # stop containers, keep volumes
docker compose down -v     # stop containers and remove volumes
```

---

## Package Documentation

| Package | Description |
|---|---|
| [`apps/core-api`](apps/core-api/README.md) | API server, worker, watcher — the main service to run |
| [`packages/shared-types`](packages/shared-types/README.md) | Zod schemas and TypeScript interfaces |
| [`packages/llm-extractor`](packages/llm-extractor/README.md) | LLM extraction via Vercel AI SDK + Ollama |
| [`packages/qmd-client`](packages/qmd-client/README.md) | Typed QMD CLI wrapper |
| [`packages/an-export`](packages/an-export/README.md) | Apple Notes → Markdown exporter |

## Roadmap

See [progress.md](progress.md) for current status and upcoming features.

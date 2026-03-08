# Kore Core API

REST API server, background extraction worker, and file watcher for the Kore memory engine.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Ollama](https://ollama.ai) running locally (for LLM extraction)
- [QMD](https://github.com/tobilu/qmd) installed (for memory indexing)

## Setup

1. Copy `.env.example` to `.env` at the project root and fill in the values:
   ```
   KORE_DATA_PATH=~/kore-data
   KORE_API_KEY=your-secret-key
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=qwen2.5:7b
   ```

2. Install dependencies from the workspace root:
   ```sh
   bun install
   ```

## Running

Start the API server, extraction worker, and file watcher concurrently:

```sh
bun run start
```

For development with hot reload:

```sh
bun run dev
```

This single command starts all three components:
- **API Server** on `http://localhost:3000` — handles REST endpoints for ingestion and memory management
- **Extraction Worker** — polls the SQLite queue every 5s, processes tasks via local LLM
- **File Watcher** — watches `$KORE_DATA_PATH` for `.md` changes and triggers QMD re-indexing (debounced 2s)

## Testing

```sh
bun test
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check (no auth required) |
| `POST` | `/api/v1/ingest/raw` | Queue raw text for LLM extraction (202) |
| `POST` | `/api/v1/ingest/structured` | Direct structured memory ingestion (200) |
| `GET` | `/api/v1/task/:id` | Check extraction task status |

All endpoints except `/health` require a Bearer token matching `KORE_API_KEY`.

# Kore: System Architecture & Technical Design

Based on the guiding principles in the `vision.md`, this document fleshes out the system architecture, component boundaries, data flows, and the technical stack required to realize the "Context-Aware Personal Memory Engine."

## 1. High-Level Architecture

The Kore system is composed of four primary layers: **Ingestion**, **Core Processing**, **Storage**, and **Delivery Interfaces (Push/Pull)**.

### 1.1. Ingestion Layer (The Collectors)
These are lightweight, specialized workers responsible for extracting raw data from various silos and forwarding it to the Core Engine.
*   **Apple Notes Exporter (`packages/an-export`):** A local TypeScript/Bun script that reads the local Apple Notes SQlite database, extracts text and attachments, and pushes to the backend.
*   **Web Clippers / Browser Extensions:** For Safari/Chrome to capture passive reading and bookmarks natively.
*   **API Integrations (X/Reddit/Pocket):** Scheduled cron jobs polling public APIs for newly saved items.

### 1.2. Core Processing Engine (The Brain)
The central intelligence layer responsible for cleaning, understanding, and formatting incoming data.
*   **API Gateway:** A REST API (ElysiaJS) receiving raw unstructured data from collectors.
*   **Asynchronous Processing Pipeline (The Core Extractor):** Background workers (Bun native queue) that pick up raw data, pass it to a local Ollama LLM via Vercel AI SDK to extract base structured metadata (Title, Summary, Base Categories).
*   **The Plugin Ingestion Hooks:** An extensible hook system where registered plugins (e.g., `kore-plugin-spatialite`) can run their own specialized extraction logic (using smaller, targeted LLMs or Zod schemas) to inject new "Memory Items" and metadata into the pipeline.
*   **Formatting:** Saving the fully enriched note as a standardized Markdown file to the file system.

### 1.3. Storage Layer (The Memory Bank)
A privacy-first, self-hosted data layer strictly adhering to a "File System First" philosophy.
*   **File System (Markdown):** The absolute source of truth. All ingested notes are saved as flat `.md` files in categorized directories (e.g., `~/kore-data/apple-notes`).
*   **QMD Index (The Pull Index):** QMD automatically creates BM25, vector embeddings, and chunked indexes of the `.md` files in its local `index.sqlite`.
*   *(Optional)* **Plugin Managed Storage:** Plugins can manage their own isolated state (like a Spatialite DB for locations) by listening to `memory.indexed` and `memory.deleted` hooks, completely decoupled from the core engine.

### 1.4. Delivery Interfaces (The Outputs)
*   **The Pull Channel (QMD MCP Server):** QMD natively exposes a Model Context Protocol server. AI assistants (Claude, Cursor, OpenClaw) connect directly to `http://localhost:8181/mcp` to run hybrid semantic searches and retrieve formatted memory context.
*   **The Push Channel (Proactive Nudges):** A distinct background service. It acts on real-time triggers (like a geographic ping from an iOS app or OS service), intersects it with spatial data in the Spatialite database, and fires a push notification via webhook (e.g., Telegram Bot API or native iOS push).

---

## 2. Technology Stack

Following the established project constraints (Strict TypeScript, Bun, native-first):

*   **Monorepo Tooling:** Bun workspaces (`packages/`, `apps/`, `services/`).
*   **Ingestion & Scrapers:** TypeScript (Strict mode) utilizing `bun`.
*   **Core API & Processing Backend:** Bun/TypeScript using **ElysiaJS** or **Hono**. Strictly typed end-to-end.
*   **Data Validation & LLM Output:** **Zod** schema validation mapping directly to LLM `response_format` for perfect MemU-style extraction.
*   **Background Jobs:** A lightweight SQLite-backed task queue native to Bun, or BullMQ if Redis is available.
*   **Storage Services:** 
    *   **File System:** For raw markdown files.
    *   **QMD (`@tobilu/qmd`):** For agentic hybrid search (BM25 + Vector + Reranking) running cleanly within the Node/Bun ecosystem.
*   **LLM Integration:** **Vercel AI SDK** with `createOpenAI()` provider defaulting to a local **Ollama** instance (`http://localhost:11434/v1`, model `qwen2.5:7b`) for cost-efficient, privacy-first extraction. Cloud providers (OpenAI, Anthropic) can be configured as alternatives. QMD handles local GGUF embedding via Node LLAMA CPP. Plugins can run their own specialized LLM calls.
*   **Infrastructure:** Native Bun single-process. The API server, extraction worker, file watcher, and QMD embedder all run together in a single `bun run start` (`apps/core-api/src/index.ts`) process — no Docker, containers, or process orchestration required. `KORE_HOME` (default: `~/.kore`) is the single environment variable controlling where all data is stored.

---

## 3. Data Flows

### 3.1. Ingestion & Enrichment Flow
1.  **Extract:** The Apple Notes Exporter (`an-export`) extracts a note about a ramen shop and posts it to the Core API `POST /api/v1/memory/ingest`.
2.  **Queue:** The Elysia backend validates the payload via Zod and pushes an `enrichment_task` to the Bun background queue.
3.  **Core Process:** An async Bun worker picks up the task and extracts the base metadata.
4.  **Plugin Hooks:** The worker passes the context to registered plugins. `kore-plugin-spatialite` hooks into the pipeline, uses an LLM to recognize the Tokyo location, and injects GPS coordinates into the YAML frontmatter.
5.  **Save Output:** The worker writes the finalized note to the file system as `~/kore-data/apple-notes/ramen_shop.md` and emits a `memory.indexed` event.
6.  **Index Output:** 
    *   QMD updates its index programmatically.
    *   `kore-plugin-spatialite` hears the `memory.indexed` event and saves the GPS coordinates to its own isolated database.

### 3.2. Agentic Retrieval Flow (Pull)
1.  **Query:** User asks OpenClaw/Claude: *"Where should I eat in Tokyo?"*
2.  **MCP Interaction:** The AI's routing decides to use the `qmd_deep_search` MCP Tool.
3.  **Search:** QMD executes a hybrid vector/BM25 search and LLM reranking locally.
4.  **Context Return:** The exact notes/bookmarks are returned to the AI, which formulates the final conversational response.

### 3.3. Proactive Nudge Flow (Push via Plugin)
*Note: This flow relies on the optional `kore-plugin-spatialite` being installed.*
1.  **Trigger:** User enters Shibuya, Tokyo. Their phone sends a lightweight GPS ping to the plugin's dedicated API: `POST /plugins/spatialite/ping`.
2.  **Geo-Spatial Query:** The plugin queries its isolated Spatialite database (`ST_Distance`) for any memories tagged with geographic coordinates within a 500m radius of the ping.
3.  **Action:** A match is found for "Mutekiya Ramen" originating from `ramen_shop.md`.
4.  **Notify:** The plugin formats a message and pushes it to the configured notification service (e.g., Telegram Bot).

---

## 4. Next Steps for Implementation

1.  **Storage Foundation:** Set up the basic directory structure (`~/kore-data/`). *(Note: Spatialite DB initialization is handled by the plugin, not core).*
2.  **QMD Integration:** Verify QMD installation, configure collections pointing to `~/kore-data/`, and start the QMD MCP Server.
3.  **Core API Foundation:** Boot up the Bun/ElysiaJS service with Zod schemas reflecting the ingestion API.
4.  **LLM Pipeline Setup:** Integrate the Bun native background worker queue for semantic enrichment, spatial indexing, and `zodResponseFormat` extraction.

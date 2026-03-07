# Storage and Indexing Strategy for Kore

To realize the vision of an autonomous, context-aware memory engine, the choice of storage and indexing is the most critical technical decision. It dictates how well "Agentic Retrieval" (the pull channel) and "Context Proactivity" (the push channel) can perform.

## 1. The Core Indexing Engine: QMD (Query Markup Documents)

Instead of building a complex Vector Database + LLM embedding pipeline from scratch, Kore will adopt **QMD** as its foundational indexing and retrieval engine. QMD is an on-device search engine built specifically for markdown notes and knowledge bases, offering an end-to-end local AI retrieval pipeline.

### Why QMD perfectly solves the "Pull Channel" (Agentic Retrieval):
*   **Ready-made MCP Server:** QMD already exposes a Model Context Protocol (MCP) server with `qmd_deep_search`, `qmd_search`, and `qmd_get`. This means conversational AI (Claude, Cursor, OpenClaw) can instantly query the ingested memories with zero extra backend code.
*   **State-of-the-art Hybrid Search Pipeline:** QMD natively handles the exact complex retrieval strategy Kore needs:
    *   **Vector Embeddings:** Automatically chunks and embeds text using local `embeddinggemma`.
    *   **Keyword Search:** Uses SQLite FTS5 (BM25) for exact text matching.
    *   **LLM Query Expansion & Re-ranking:** Uses local GGUF models (`qwen3-reranker` and a fine-tuned query expander) combined with Reciprocal Rank Fusion (RRF) to guarantee top-tier relevance.
*   **Privacy First:** QMD runs entirely locally using `node-llama-cpp`, avoiding any cloud APIs for memory retrieval.
*   **Contextual Trees:** QMD allows assigning semantic contexts to directories (`qmd context add qmd://notes "Personal notes"`), giving the LLM heavy contextual hints during retrieval.

## 2. The Overall Storage Architecture

With QMD acting as the read-heavy **Pull Engine**, the storage architecture is vastly simplified.

### Layer A: The File System (The Source of Truth)
Because QMD natively indexes Markdown files, the raw storage layer will simply be the local file system.
*   Ingestion workers (like `an-export` for Apple Notes) will write clean `.md` files to categorized directories (e.g., `~/kore-data/apple-notes`, `~/kore-data/bookmarks`).
*   QMD will be configured to track these directories as "collections" (`qmd collection add ~/kore-data/apple-notes --name apple-notes`).
*   A cron job or file watcher will trigger `qmd update` to ensure the index is always fresh.

### Layer B: QMD SQLite Cache (The Pull Index)
QMD maintains its own internal SQLite database (`~/.cache/qmd/index.sqlite`) housing the BM25 tokens, vector embeddings, and LLM query caches. Kore does not need to manage this directly; we just interact with it via the QMD CLI or MCP.

### Layer C: Extensible Plugin Storage (Optional)
While QMD perfectly handles semantic searching for AI agents, it does not do real-time geographic proximity queries (e.g., "Alert me when I am 500m from this saved restaurant").
Instead of bloating the core engine, Kore supports isolated plugin storage. 
*   **The Spatialite Plugin:** For the **Push Channel**, users can install `kore-plugin-spatialite`. This plugin maintains a secondary, lightweight SQLite database.
*   **The Synthesis Plugin:** For **Consolidation**, a plugin like `kore-plugin-synthesis` can run scheduled sweeps over un-consolidated `.md` files to generate higher-order insights, solving QMD's graph traversal weaknesses.
*   **Event Hooks:** When the core engine writes a `.md` file, it broadcasts a `memory.indexed` event. The spatial plugin listens, reads the YAML coordinates, and updates its own DB.
*   **The Push API:** The iOS companion app hits a plugin-specific API route with GPS coordinates to trigger push notifications, completely bypassing the core QMD/File System retrieval logic.

---

## 3. Summary of the Architecture Update

1.  **File System First:** All ingestion targets output flat `.md` files to a centralized data folder. This is the absolute master source of truth.
2.  **Pull Channel:** QMD runs as a background service (`qmd mcp --http --daemon`) and handles all agentic memory retrieval instantly via its MCP tools.
3.  **Push / Metadata Channels:** Optional plugins (like Spatialite) hook into the ingestion pipeline to inject metadata, and listen to file system events to build specialized, secondary indexes for features like geofencing.

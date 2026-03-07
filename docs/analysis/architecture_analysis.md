# Architectural Analysis: QMD vs. MemU for Kore

To build Kore as the ultimate "Context-Aware Personal Memory Engine," we must select an architecture that supports continuous, low-friction *ingestion* alongside highly relevant, proactive *retrieval*. 

We evaluated two leading local/open-source memory frameworks: **QMD** and **MemU**. This document provides a comprehensive review of their designs, pros and cons, and alignment with Kore's requirements, concluding with a proposed unified solution.

---

## 1. Evaluation of QMD (Query Markup Documents)

**Core Philosophy:** "Uncompromising local search for Agentic workflows."
QMD is an advanced, strictly on-device search engine tailored for markdown knowledge bases. It orchestrates a multi-step, hybrid retrieval pipeline.

### The Technique
QMD ingests flat `.md` files natively. Upon ingestion, it uses local, small-parameter GGUF models via `node-llama-cpp` to generate embeddings and index text via SQLite FTS5 (BM25). 
For retrieval, QMD performs a highly sophisticated operation called "Hybrid Search with Reciprocal Rank Fusion (RRF) and Re-ranking." It parses a query, asks an LLM for alternative variations (query expansion), fetches the top vector and keyword matches for all variations, and then passes the top 30 candidates through a dedicated Cross-Encoder "Reranker" LLM for final scoring.

### Pros
*   **Zero-Setup MCP Integration:** The Model Context Protocol (MCP) server is built-in (`qmd_deep_search`). Agents like OpenClaw, Claude Desktop, and Cursor can instantly search memories out-of-the-box.
*   **State-of-the-Art Retrieval Quality:** The hybrid search + RRF + Reranker pipeline guarantees exceptionally high precision. It prevents the common pitfall of vector databases returning loosely related, unhelpful context.
*   **File-System Native:** It treats the filesystem as the source of truth, aligning perfectly with standard PKM (Personal Knowledge Management) workflows.
*   **Fully Local/Private:** Heavy emphasis on local GGUF models.

### Cons
*   **Retrieval Latency:** Running local LLMs for query expansion and reranking, even small ones, introduces non-trivial latency (seconds rather than milliseconds).
*   **No Proactive "Push" Architecture:** QMD is strictly a "Pull" engine. It waits for a query. It has no mechanism for continuous background monitoring or real-time spatial (GPS) triggers.
*   **Unstructured Storage:** QMD stores massive markdown chunks. It doesn't natively "extract" atomic facts or summarize relationships; it relies on the querying LLM to make sense of the returned raw text snippets.

---

## 2. Evaluation of MemU

**Core Philosophy:** "Memory as a File System for 24/7 Proactive Agents."
MemU is an enterprise-grade memory framework designed specifically to lower the token cost of keeping agents "always online" and capable of proactive actions.

### The Technique
MemU introduces a strict three-layer hierarchy:
1.  **Resource:** The raw document or conversation log.
2.  **Memory Item:** Distilled, atomic facts extracted from the Resource (e.g., "User prefers 70/30 equity split").
3.  **Category:** Auto-generated topics that group related Memory Items.

MemU continuously processes inputs "in the background" (Continuous Sync Loop). When new data arrives, an LLM parses it into atomic Memory Items and mounts them in the structured "File System." For retrieval, MemU offers two paths: a lightning-fast "RAG-based" embedding lookup (milliseconds) for background monitoring, and a slower "LLM-based" lookup for complex reasoning.

### Pros
*   **Structured Intelligence:** By extracting atomic "Memory Items" at ingestion, MemU vastly reduces the token load during retrieval. Instead of reading a 3-page article to find an answer, the agent reads a 1-sentence extracted fact.
*   **Proactive Native:** The architecture is explicitly designed for continuous background monitoring and anticipation of user intent.
*   **Cost & Context Efficiency:** Surfacing only relevant atomic facts keeps the context window lean and cheap.

### Cons
*   **Complex Dependencies:** Managing MemU requires setting up PostgreSQL with `pgvector`, maintaining a separate relational tracking database alongside the vector mappings.
*   **Integration Overhead:** It lacks a native, universal MCP server out of the box, requiring custom wrappers to expose the memory to external LLM clients.
*   **Potential for Context Loss:** Extracting everything into atomic facts risks stripping away the original, nuanced context of the source document if not careful.

---

## 3. Kore Requirements Alignment

Kore has two foundational pillars that map perfectly to the strengths (and weaknesses) of these two frameworks:

1.  **The Pull Channel (Agentic Retrieval):** Kore requires agents (Claude, OpenClaw) to flawlessly query fragmented notes. **QMD** is the undeniable winner here due to its native MCP server and unbeatable hybrid reranking pipeline.
2.  **The Push Channel (Proactive Context & Location):** Kore requires background processing to extract spatial data (GPS) and atomic intents for real-time mobile nudges. **MemU** is the clear conceptual winner here with its Continuous Sync extraction and dual-mode (fast vs. slow) retrieval.

---

## 4. The Proposed Solution: The "Hybrid File-System" Architecture

Instead of choosing one framework, Kore will implement a fused architecture: **using MemU's extraction philosophies to feed QMD's pure indexing engine, supported by an Extensible Plugin System for features like Spatial Tracking.**

### The Workflow

#### Phase 1: Ingestion & MemU-Style Extraction (Continuous Sync)
When a scrap of data is saved (e.g., an Apple Note via `an-export`):
1.  **Extract:** A Bun background worker (acting like MemU's continuous loop) passes the raw text to an LLM.
2.  **Distill:** The LLM applies MemU's concept: it distills the raw text into **Memory Items** (atomic facts, intents, category). It specifically looks for spatial data (GPS).
3.  **Mount:** Instead of writing to Postgres, the worker formats a single `.md` file to the disk. 
    *   The file contains YAML Frontmatter (for the extracted "Memory Items", Categories, and GPS coords).
    *   The body contains the raw resource.

#### Phase 2: Indexing & Agentic Pull (QMD)
1.  **Index:** The Bun worker triggers `qmd update`. QMD reads the new `.md` files and executes its local embedding and BM25 indexing.
2.  **Retrieve:** AI Agents connect to Kore via QMD's standard MCP server. Because the files now contain MemU-style pre-extracted atomic facts in the Frontmatter, QMD's Hybrid Search returns hyper-relevant, token-efficient context.

#### Phase 3: The Geographic Push (via Spatialite Plugin)
1.  **Extract & Store:** During Phase 1, the `kore-plugin-spatialite` hooks into the LLM extraction pipeline to pull out Latitude/Longitude. When the core `.md` file is saved, the plugin hears the `memory.indexed` event and writes the coordinates to its own isolated `Spatialite` database.
2.  **Trigger:** As the user walks their city, their phone pings the plugin's API route on the backend. The plugin executes a lightning-fast SQL proximity query (`ST_Distance`) against Spatialite. It avoids invoking QMD entirely. If a match hits, it issues a push notification.

### Why this is the optimal path:
*   We eliminate the need to run Postgres + `pgvector`. The core stack is purely `File System + QMD`.
*   We get the unparalleled search capabilities and zero-setup MCP server of QMD.
*   We get the token-efficiency and proactive extraction of MemU's atomic Memory Items.
*   Geographic calculations are isolated to an optional Plugin, ensuring the core engine remains focused, while battery-efficient, millisecond push triggers remain possible for those who install it.

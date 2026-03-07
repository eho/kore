# Architecture Comparison: Always-On Memory Agent vs. Kore

This document analyzes the design of the `always-on-memory-agent` (built with Google ADK and Gemini 3.1 Flash-Lite) and compares it against the established architecture and design analysis of Kore.

## 1. Core Architectural Philosophies

### Always-On Memory Agent
*   **Philosophy:** "Persistent, evolving memory that runs 24/7 as a lightweight background process, continuously processing, consolidating, and connecting information."
*   **Storage:** Direct relational DB (SQLite). No vector database.
*   **Intelligence:** Relies heavily on Gemini's processing capabilities to extract structure at ingestion and synthesize relationships during downtime.

### Kore (Hybrid File-System)
*   **Philosophy:** "Memory as a File System for 24/7 Proactive Agents" combined with "Uncompromising local search for Agentic workflows."
*   **Storage:** Flat `.md` files (with YAML frontmatter) indexed by QMD (Vector Embeddings + BM25), paired with a Spatialite database for geographic coordinates.
*   **Intelligence:** Distills raw text to atomic "Memory Items" at ingestion (MemU style). Uses local GGUF models (via QMD) for RRF and reranking during retrieval.

---

## 2. Feature-by-Feature Comparison

### A. Ingestion & Extraction
Both systems recognize that raw data is messy and token-heavy. They both enforce an **Extraction Phase** at ingestion.
*   **Always-On Agent:** Uses Gemini to extract a `summary`, `entities` (people, companies), `topics`, and an `importance` score from any multiformat file.
*   **Kore:** Uses a Bun/TypeScript LLM worker to distill raw text into structured `Memory Items` and `Categories`, injecting them into the `.md` frontmatter, while also explicitly extracting GPS coordinates for the Spatialite sidecar.
*   *Verdict:* Functionally identical intents, but Kore's approach is specialized for localized, proactive spatial triggers.

### B. Retrieval (The "Pull" Channel)
*   **Always-On Agent:** The `QueryAgent` reads *all* memories and stored insights, synthesizing an answer with citations. Relying on an LLM to read the entire SQLite history scales poorly as the DB grows.
*   **Kore:** Uses QMD's Hybrid Search (Vector + Keyword + Reranker). This is far more robust for large datasets. It guarantees high precision across thousands of files without blowing up the context window.
*   *Verdict:* Kore's retrieval (via QMD) is more mature and scalable for long-term Personal Knowledge Management (PKM) than dumping SQLite contents into a prompt.

### C. Proactive Nudges (The "Push" Channel)
*   **Always-On Agent:** Missing. It only responds to explicit API queries (`/query`). It has no concept of ambient context (time/location) triggering a memory.
*   **Kore:** A foundational pillar. The independent Spatialite database allows millisecond proximity pings (`ST_Distance`) to push notifications to the user's phone based on their physical location.
*   *Verdict:* Kore's architecture is uniquely tailored for real-world contextual activation.

---

## 3. The Crucial Missing Piece: The "Consolidation" Loop

The most significant divergence between the two systems is the `always-on-memory-agent`'s **Consolidate** feature, which perfectly addresses one of Kore's documented architectural weaknesses.

### Kore's Weakness: "Concept Drift & Cross-Referencing Failure"
As documented in [architecture_weaknesses.md](./architecture_weaknesses.md), QMD indexes flat files and does not build a Knowledge Graph. If you ask Kore to synthesize a hypothesis across 40 tangentially related notes saved over five years, QMD relies entirely on vector similarity. If the embedding distance isn't perfectly aligned, QMD misses the connections. 

### The Always-On Agent's Solution: The Sleep Cycle
The `always-on-memory-agent` runs a `ConsolidateAgent` on a timer (e.g., every 30 minutes). Like a human brain during sleep, it:
1. Reviews newly ingested, "unconsolidated" memories.
2. Cross-references them with existing memories.
3. Generates **Connections** (Memory A ↔ Memory B).
4. Generates **Insights** (Higher-level synthesis of multiple memories).

Because it does this *in the background*, the connections are pre-computed. When the user queries the agent, the agent doesn't have to reason across 40 disparate notes; it reads the pre-computed "Insight" that linked them together weeks ago.

## 4. Applying Consolidation to Kore via Plugins

Kore can dramatically improve its spatial/graph weakness by adopting the "Consolidation" loop. With Kore's new **Extensible Plugin Architecture**, this loop can be implemented elegantly without bloating the Core Processing Engine.

### The Proposed Plugin Pipeline

1.  **The Unconsolidated State:** When the core ingestion worker creates a new `.md` file, it adds a flag to the frontmatter: `consolidated: false`.
2.  **The Background Sweep:** A specialized plugin (e.g., `kore-plugin-synthesis`) runs on a background cron schedule. It sweeps the file system for any un-consolidated files.

From here, two different types of Consolidation Plugins could process the memory:

#### Plugin Type A: The "Insight" Generator (File-System Native)
This plugin acts exactly like the Always-On Memory Agent.
*   **Action:** It takes the un-consolidated file and asks QMD for 5-10 semantically related historical files.
*   **Synthesis:** It feeds the cluster to a reasoning LLM to find cross-cutting connections, contradictions, or evolving themes.
*   **Output:** It generates a *new* `.md` file in a dedicated `~/kore-data/insights/` folder (e.g., `Insight: Evolving backend framework preferences.md`).
*   **Update:** It marks the source files as `consolidated: true` and triggers a `qmd update`.
*   **How the Agent uses it:** The AI agent simply queries QMD. Because the "Insight" file is pure Markdown, it gets indexed. When the agent asks a complex, multi-hop question, QMD effortlessly returns the pre-computed Insight file, solving the limitation of vector similarity.

#### Plugin Type B: The Knowledge Graph Builder (MCP Native)
For users who require strict relationship mapping (Entities and Nodes) rather than Markdown narratives.
*   **Action:** The plugin extracts Names, Organizations, and Concepts from the un-consolidated file.
*   **Output:** It builds nodes and edges in an isolated graph database (like Neo4j or a specific SQLite table) owned entirely by the plugin.
*   **Update:** It marks the source files as `consolidated: true`.
*   **How the Agent uses it:** Because this data is not in a `.md` file, QMD cannot natively index it. Therefore, this plugin must expose its own **Model Context Protocol (MCP) Tool**. 
    *   The plugin registers a tool like `kore_graph_query(entity="React")`.
    *   When the user asks Claude a question, Claude sees both QMD's tools (`qmd_deep_search`) and the plugin's tools (`kore_graph_query`). 
    *   Claude can autonomously choose to invoke the Graph Tool to retrieve structured relationships, and then invoke QMD to pull the raw text of specific files connected to those relationships.

### Conclusion

The `always-on-memory-agent` validates Kore's decision to extract atomic facts at ingestion, but it exposes a critical gap in Kore's backend: **passive similarity search (QMD) is not a replacement for active memory synthesis.** 

By incorporating a background "Consolidation Plugin" that generates interconnected "Insight" Markdown files (or MCP-accessible Graph databases), Kore can achieve high-order reasoning capabilities while maintaining the simplicity and interoperability of its pure File-System + QMD core architecture.

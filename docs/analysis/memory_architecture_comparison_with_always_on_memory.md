# Architecture Comparison: Always-On Memory Agent vs. Kore

This document analyzes the design of the `always-on-memory-agent` (built with Google ADK and Gemini 3.1 Flash-Lite) and compares it against the established architecture and design analysis of Kore.

## 1. Core Architectural Philosophies

### Always-On Memory Agent
*   **Philosophy:** "Persistent, evolving memory that runs 24/7 as a lightweight background process, continuously processing, consolidating, and connecting information."
*   **Storage:** Direct relational DB (SQLite). No vector database.
*   **Intelligence:** Relies heavily on Gemini's processing capabilities to extract structure at ingestion and synthesize relationships during downtime.

### Kore (Hybrid File-System)
*   **Philosophy:** "Memory as a File System for 24/7 Proactive Agents" combined with "Uncompromising local search for Agentic workflows."
*   **Storage:** Flat [.md](file:///Users/eho/dev/kore/docs/vision.md) files (with YAML frontmatter) indexed by QMD (Vector Embeddings + BM25), paired with a Spatialite database for geographic coordinates.
*   **Intelligence:** Distills raw text to atomic "Memory Items" at ingestion (MemU style). Uses local GGUF models (via QMD) for RRF and reranking during retrieval.

---

## 2. Feature-by-Feature Comparison

### A. Ingestion & Extraction
Both systems recognize that raw data is messy and token-heavy. They both enforce an **Extraction Phase** at ingestion.
*   **Always-On Agent:** Uses Gemini to extract a `summary`, `entities` (people, companies), `topics`, and an `importance` score from any multiformat file.
*   **Kore:** Uses a Bun/TypeScript LLM worker to distill raw text into structured `Memory Items` and `Categories`, injecting them into the [.md](file:///Users/eho/dev/kore/docs/vision.md) frontmatter, while also explicitly extracting GPS coordinates for the Spatialite sidecar.
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
As documented in [architecture_weaknesses.md](file:///Users/eho/dev/kore/docs/architecture_weaknesses.md), QMD indexes flat files and does not build a Knowledge Graph. If you ask Kore to synthesize a hypothesis across 40 tangentially related notes saved over five years, QMD relies entirely on vector similarity. If the embedding distance isn't perfectly aligned, QMD misses the connections. 

### The Always-On Agent's Solution: The Sleep Cycle
The `always-on-memory-agent` runs a `ConsolidateAgent` on a timer (e.g., every 30 minutes). Like a human brain during sleep, it:
1. Reviews newly ingested, "unconsolidated" memories.
2. Cross-references them with existing memories.
3. Generates **Connections** (Memory A ↔ Memory B).
4. Generates **Insights** (Higher-level synthesis of multiple memories).

Because it does this *in the background*, the connections are pre-computed. When the user queries the agent, the agent doesn't have to reason across 40 disparate notes; it reads the pre-computed "Insight" that linked them together weeks ago.

## 4. Applying Consolidation to Kore

Kore can dramatically improve its spatial/graph weakness by adopting the "Consolidation" loop without abandoning its [.md](file:///Users/eho/dev/kore/docs/vision.md) + QMD architecture.

**Proposed Kore Consolidation Workflow:**
1.  **The Flag:** When the Bun ingestion worker creates a new [.md](file:///Users/eho/dev/kore/docs/vision.md) file, it adds a frontmatter tag: `consolidated: false`.
2.  **The Background Worker (Downtime):** Nightly, or during idle periods, a Bun worker sweeps for all `consolidated: false` files.
3.  **The Synthesis:** The worker queries QMD for documents semantically similar to the un-consolidated files. It passes the cluster of files to an LLM to generate new, cross-cutting insights.
4.  **The Output:** Instead of modifying a relational database, the worker generates a **new** [.md](file:///Users/eho/dev/kore/docs/vision.md) file in a dedicated `/insights/` directory (e.g., `Insight: Evolving backend framework preferences.md`).
5.  **The Update:** The worker marks the source files as `consolidated: true` and runs `qmd update` to index the new Insight file.

### Conclusion

The `always-on-memory-agent` validates Kore's decision to extract atomic facts at ingestion, but it exposes a critical gap in Kore's backend: **passive similarity search (QMD) is not a replacement for active memory synthesis.** 

By incorporating a background "Consolidation Loop" that generates interconnected "Insight" Markdown files, Kore can achieve Graph-like reasoning capabilities while maintaining the simplicity and interoperability of its pure File-System + QMD architecture.

# memU Learnings & Application to Kore

After reviewing the architecture of [memU](https://github.com/NevaMind-AI/memU), several core concepts stand out as highly applicable to Kore, specifically bridging the gap between raw data storage and proactive, agentic retrieval.

## 1. The Hierarchical Memory System

memU treats memory like a file system with a strict 3-layer architecture:
1.  **Resource (The Mount Point):** The raw original data (e.g., a conversation transcript, an ingested markdown note, a web article).
2.  **Memory Item (The File):** An atomic, extracted fact, preference, or skill (e.g., "User likes spicy food," "Mutekiya is a recommended ramen shop").
3.  **Category (The Folder):** Auto-organized topics grouping related Memory Items.

### Applying to Kore
Kore can adopt this exact hierarchy, adapting it to fit the **QMD** indexing engine:
*   **The Resource:** The raw Apple Note or X Bookmark scraped by the ingestion worker.
*   **The Memory Item:** Instead of managing a separate database of items like memU does, Kore's Bun/TypeScript LLM worker will extract these atomic "Memory Items" (facts, entities, locations) via structured Zod schemas and **inject them as structured Markdown Frontmatter or specific sections** into the raw Resource file.
*   **The Category:** Kore will map these directly to QMD's `qmd context add` feature, organizing files into virtual contextual folders.

## 2. Dual-Mode Retrieval (Continuous vs. Agentic)

memU defines two distinct retrieval methods:
1.  **RAG-based Retrieval (Fast Context):** Sub-second surfacing of relevant memories using embeddings. Used for continuous background monitoring.
2.  **LLM-based Retrieval (Deep Reasoning):** Slower, anticipatory reasoning where the LLM infers intent and refines searches.

### Applying to Kore
This perfectly validates Kore's Dual-Channel design:
*   **The Push Channel (Continuous/Proactive):** Maps to memU's Fast Context. As the user moves around the world, lightweight GPS pings hit the Spatialite DB to trigger instant, low-cost location nudges without invoking an LLM.
*   **The Pull Channel (Agentic/Deep Reasoning):** Maps to memU's LLM-based Retrieval. When an agent queries via QMD's MCP server (`qmd_deep_search`), it uses the heavy Hybrid RRF + LLM reranking pipeline to return highly synthesized, reasoned context for conversational use.

## 3. Continuous Sync Loop

memU utilizes a "Continuous Sync Loop" where an agent monitors interactions and extracts memories continuously in the background.

### Applying to Kore
Kore's ingestion workers must be fully decoupled from the retrieval engine. When a new Safari bookmark is saved, the Bun LLM worker must instantly run the extraction (creating the "Memory Items" and geographic metadata), update the `.md` file, and trigger a `qmd update` so the memory is available *immediately*, zero-delay.

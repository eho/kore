# Kore Documentation

Welcome to the Kore documentation directory. This folder contains all the architectural and design documents for Kore, the Context-Aware Personal Memory Bank.

To make navigation easier, the documentation is organized into the following areas:

## 1. Vision
* **[Vision Document](vision/vision.md):** The high-level goals, problems solved, and core pillars of the Kore system, including real-world scenarios for the Push and Pull channels.

## 2. Architecture
* **[System Architecture & Technical Design](architecture/architecture.md):** The high-level architecture layers (Ingestion, Core Processing, Storage, Delivery), technology stack, and data flows.
* **[Plugin System Contract](architecture/plugin_system.md):** The formal contract, lifecycle events, and registration for Kore extensions.
* **[Data Schema & Markdown Format](architecture/data_schema.md):** The canonical Zod schemas, directory layout, and Frontmatter requirements for memory files.
* **[Core API Design](architecture/api_design.md):** The ElysiaJS REST API endpoints for ingestion and memory management.
* **[Monorepo Structure](architecture/monorepo_structure.md):** Workspaces architecture defining apps, packages, and plugins.
* **[Storage and Indexing Strategy](architecture/storage_and_indexing.md):** Details on QMD (for agentic pull) and Spatialite (for proactive push) usage.
* **[TypeScript Backend Design](architecture/typescript_backend_design.md):** Implementation details for the Bun/TypeScript/ElysiaJS backend and internal queue.
* **[Hybrid Architecture Examples](architecture/hybrid_architecture_examples.md):** Concrete examples of how data flows through ingestion, extraction, storage, and retrieval.

## 3. Phase 2 — Consolidation & Integrations
* **[Consolidation System Design](design/consolidation_system_design.md):** Full architecture for the background consolidation loop — seed selection, QMD-driven candidate finding, LLM synthesis, insight lifecycle, dedup/supersession, and reactive re-evaluation.
* **[Consolidation Design Review](analysis/consolidation_design_review.md):** Critical assessment against competitors (Graphiti, LangMem, etc.), identified weaknesses, and V1/V2 improvement roadmap.
* **[Design Effectiveness Review](analysis/design_effectiveness_review.md):** Honest gap analysis of the overall Kore architecture — extraction quality, consolidation, plugin system, retrieval weighting.
* **[Apple Notes Integration Design](design/apple_notes_integration_design.md):** Plugin-based passive ingestion from Apple Notes — staging, manifest diffing, folder-aware context, content pipeline.
* **[MCP Server Design](design/mcp_server_design.md):** Agent-facing MCP interface — 6 core tools (recall, remember, inspect, insights, status, consolidate), behavior-encoding descriptions, structured output.

## 4. Blog
* **[Building Kore — My Experience](blogs/building-kore-my-experience.md):** How I built Kore using AI across the full dev cycle — from vision and architecture to PRDs, implementation, and review.

## 5. Analysis & Learnings
* **[Architectural Analysis (QMD vs. MemU)](analysis/architecture_analysis.md):** An evaluation of QMD and MemU architectures and why Kore uses a hybrid approach.
* **[Architecture Stress Test & Weaknesses](analysis/architecture_weaknesses.md):** Identification of edge cases and limitations of the hybrid model (e.g., State Synchronization, Concept Drift).
* **[memU Learnings & Application](analysis/memu_learnings.md):** Specific takeaways from the memU architecture (Hierarchical Memory, Dual-Mode Retrieval) applied to Kore.
* **[Memory Architecture Comparison with Always-On Memory Agent](analysis/memory_architecture_comparison_with_always_on_memory.md):** An analysis comparing the Google ADK always-on agent's architecture with Kore, highlighting the benefits of a background "Consolidation Loop."
* **[macOS Local Ingestion Sources](analysis/macos_local_ingestion_sources.md):** Brainstorming of potential high-signal local data sources on macOS.

# Kore Memory System: Design Effectiveness Review

_2026-03-14 · Updated 2026-03-14_

An honest assessment of how effectively Kore's current design and architecture achieve its vision. This document serves as the **authoritative gap analysis** — it identifies what to preserve, what to fix, and in what order. Companion design documents provide detailed architecture for the two largest gaps:

- [Consolidation System Design](./consolidation_system_design.md) — addresses Weakness #2
- [Apple Notes Integration Design](./apple_notes_integration_design.md) — addresses Weakness #4

---

## Vision Recap

Kore aims to solve the **"Recall Disconnect"** — the gap between saving information and remembering it when relevant. It passively ingests content, distills it via local LLM into atomic facts, indexes it with QMD's hybrid search, and aspires to proactively surface memories based on context (location, time, task).

---

## What Works Well (Don't Change)

### 1. File-System-as-Database Architecture

The decision to store memories as markdown files with YAML frontmatter is excellent. It gives you:

- **Debuggability**: `cat` any memory to understand what the system produced
- **Portability**: No vendor lock-in; files are the source of truth
- **Composability**: QMD indexes files generically — Kore doesn't need special hooks into QMD's internals
- **Durability**: Survives any code change; you can rewrite the entire app and the data still works

This is the single best architectural decision in the project. Don't abstract it away.

### 2. QMD as the Retrieval Layer

QMD is genuinely strong infrastructure for this use case. The hybrid search pipeline (BM25 + vector + reranker + query expansion) with RRF fusion is state-of-the-art for local retrieval. The fact that Kore delegates all retrieval complexity to QMD and focuses on **ingestion quality** is a correct division of responsibility. Kore's thin `qmd-client` wrapper with operation locks is the right level of coupling.

### 3. Async Queue + Worker Pattern

The SQLite task queue with priority, retry logic, and stale recovery is well-designed for a local system. The separation of "accept the request" (202) from "do the work" (worker poll) means the API never blocks on LLM inference. The 3-retry limit with failure recording is pragmatic.

### 4. The Extraction Schema Design

The `MemoryExtraction` schema — title, 1-7 distilled items, hierarchical category, type, tags — is well-scoped. Constraining to 4 types and 7 category roots prevents ontological sprawl. The distilled items as "atomic, standalone sentences" is the right unit of knowledge.

### 5. Local-First, Privacy-Preserving

Everything runs on-device (Ollama + QMD's GGUF models). This isn't just a feature — it's a trust prerequisite for a system that ingests personal notes, messages, and bookmarks. Don't compromise this.

---

## Architectural Strengths to Preserve

| Decision | Why It's Right |
|----------|---------------|
| Markdown files as source of truth | Debuggable, portable, survives rewrites |
| QMD for retrieval, not storage | Clean separation; QMD is a cache/index, not the authority |
| Async worker with SQLite queue | Simple, reliable, no external dependencies |
| Monorepo with clean package boundaries | `shared-types`, `llm-extractor`, `qmd-client` are well-scoped |
| Bearer token auth on all mutating endpoints | Simple security for a local system |
| Bun-native, no Docker | Right call for a local-first tool; eliminates deployment friction |

---

## Weaknesses & Where to Improve

### 1. The Extraction Layer is the Weakest Link (High Priority)

**Problem**: The entire system's value depends on extraction quality, but it's running on a 7B model (qwen2.5:7b) with a generic system prompt. This is where most information loss occurs.

**This weakness has a cascading effect.** The consolidation system (Weakness #2) operates exclusively on distilled items — not raw source text. If extraction is poor, consolidation amplifies the error by synthesizing bad facts into bad insights. Extraction quality is the foundation that every downstream feature depends on.

Specific issues:

- **Distilled items lose relational context.** "The ramen shop uses 48-hour pork bone broth" is an atomic fact, but loses _why you saved it_ — was it a recommendation? A place you visited? Something you want to replicate? **The `shared-types` schema currently lacks an `intent` or `disposition` field**, which is a critical signal for personal relevance.
- **The category taxonomy is static and shallow.** `qmd://travel/restaurants` doesn't distinguish between "places I loved," "places someone recommended," and "places I want to try." The category captures _topic_ but not _disposition_.
- **7B models hallucinate categories and tags.** The fallback parsing robustness (commit a9c3140) is evidence this is an ongoing problem. You're fighting the model's inconsistency rather than reducing the model's degrees of freedom.
- **No extraction quality feedback loop.** There's no mechanism to detect or correct bad extractions. A poorly extracted memory is silently indexed and will pollute search results forever.

**Recommendations**:

- **Update `MemoryExtractionSchema`**: Add an **intent/disposition field** as a constrained enum (e.g., `"recommendation" | "reference" | "personal-experience" | "aspiration" | "how-to"`). This is high signal for retrieval relevance and for the consolidation system's connection detection.
- Consider **constrained decoding** (structured output with enum constraints) rather than relying on fallback parsing. Vercel AI SDK's `Output.object` should handle this, but test whether the model actually respects the Zod constraints or just generates JSON that happens to parse.
- Add a **confidence score** to extraction output. Low-confidence extractions could be flagged for review rather than silently indexed.
- Long-term: fine-tune a small model on your extraction task. The schema is simple enough that a 1-3B model fine-tuned on 500 examples would likely outperform a generic 7B.

### 2. No Consolidation / Synthesis Layer (High Priority)

> Detailed design: [consolidation_system_design.md](./consolidation_system_design.md)

**Problem**: Individual memories are indexed in isolation. Over time this causes fragmentation (40 notes on one topic, no single summary), contradiction persistence (old and new opinions co-exist with equal weight), and latent connection blindness (related memories in different categories never linked).

**Current status**: The consolidation system has a detailed architecture design but **no implementation**. The `MemoryTypeEnum` in `shared-types` has not been extended to include the `"insight"` type, and there is no `insights/` directory in `TYPE_DIRS`.

**Design decisions captured in the companion doc:**

- **Core service, not a plugin.** Consolidation is fundamental to every user's experience — it starts alongside the worker, watcher, and embedder. Unlike Apple Notes (platform-specific, optional), consolidation is universal. It needs direct access to QMD search and the file system.
- **QMD-driven candidate selection.** Uses QMD hybrid search to find topically coherent clusters, rather than batch-processing random recent memories (the always-on-memory-agent's approach, which produces incoherent insights).
- **Four insight types**: `cluster_summary`, `evolution`, `contradiction`, `connection` — classified deterministically from cluster properties, not by the LLM.
- **Append-only.** Source memories are never modified or deleted. Insight files use `supersedes` to chain updates.
- **Confidence scoring** derived from QMD similarity scores and cluster size — not from LLM self-assessment.

**Key dependency**: Consolidation quality is bounded by extraction quality (Weakness #1). The synthesis LLM receives only distilled items, not raw text. Poor extraction → poor insights. These two workstreams should be developed in parallel, with extraction improvements deployed first so that newly extracted memories are higher quality before they are consolidated.

### 3. Plugin System is "Design-Only" (Medium Priority)

**Problem**: Architectural documents describe a plugin system with enrichment hooks, lifecycle events, and plugin-specific storage. The codebase only has a basic `EventDispatcher` that emits `memory.indexed` and `memory.deleted` events. There is no mechanism to register plugins, start background work, track external identity mappings, or mount plugin routes.

Specific gaps vs. what the Apple Notes integration requires:

| Required Capability | Current State | Needed For |
|---------------------|--------------|------------|
| `KorePlugin.start()` / `stop()` lifecycle | Not implemented | Apple Notes sync loop, future source plugins |
| `PluginStartDeps.enqueue()` | Not wired | Plugins submitting content to the extraction queue |
| `PluginStartDeps.deleteMemory()` | Not wired | Plugins removing memories when source content is deleted |
| Plugin Identity Registry (SQLite table) | Not implemented | Mapping external IDs (Apple Notes Z_PK) → Kore UUIDs |
| `registerPlugin()` in core-api startup | Not implemented | Loading plugins into the event dispatcher |
| `task_id` in `MemoryEvent` payload | Not emitted | Plugins matching queued tasks to created memories |

**Recommendation**: Build the plugin infrastructure as a prerequisite to Apple Notes integration. The required additions are:

1. Extend `KorePlugin` interface with `start(deps)` / `stop()` — defined in `shared-types`
2. Define `PluginStartDeps` with `enqueue`, `deleteMemory`, and identity registry methods
3. Add `plugin_key_registry` table to `kore-queue.db` (or a new `PluginRegistry` class)
4. Add `task_id` to the `MemoryEvent` payload emitted by the worker after writing a memory file
5. Update `core-api/src/index.ts` to call `plugin.start()` at startup and `plugin.stop()` at shutdown

Note: The consolidation system does **not** depend on the plugin system. It is a core service with direct access to QMD and the file system.

### 4. Ingestion Surface is Too Narrow & Manual (Medium Priority)

> Detailed design: [apple_notes_integration_design.md](./apple_notes_integration_design.md)

**Problem**: The system currently supports one ingestion path: manual POST of raw text via API. The vision of "passive ingestion" is not yet realized. The `an-export` package for Apple Notes exists as a standalone tool but is not wired into the core pipeline.

**Design decisions captured in the companion doc:**

- **Plugin-based integration** (not inline in core-api). Apple Notes is macOS-specific and optional — it belongs in a `packages/plugin-apple-notes` package, activated by `KORE_APPLE_NOTES_ENABLED=true`.
- **Staging directory** at `$KORE_HOME/staging/apple-notes/`. `an-export` writes here; the plugin reads from it and enqueues content to the extraction pipeline. The staging directory is not indexed by QMD.
- **Manifest-based delta detection.** The plugin diffs `an-export`'s manifest against its own state to identify new, updated, and deleted notes per sync cycle.
- **Folder path as LLM context.** The Apple Notes folder hierarchy (e.g., `Work / Projects`) is prepended to the content sent to the LLM extractor, providing high-value categorization signal.
- **V1 attachment strategy**: text-only. Images stripped and replaced with `[Attachment: filename]`. Tables and URL cards preserved as Markdown.

**Key dependency**: This feature depends on the plugin infrastructure (Weakness #3). Specifically: `KorePlugin.start()`, `PluginStartDeps.enqueue()`, and the Plugin Identity Registry for Z_PK → koreId tracking.

**Known design debt in the companion doc**: The `onMemoryIndexed` handler for resolving pending `task_id → koreId` mappings uses time-window matching — acknowledged as fragile. The fix is adding `task_id` to `MemoryEvent` (listed as prerequisite in Weakness #3).

**Content deduplication**: Re-ingesting the same text creates duplicate memories. A content hash check at ingestion time (hash the raw content, check against existing memories before queueing) would eliminate exact duplicates cheaply. This applies to all ingestion paths, not just Apple Notes.

### 5. Retrieval Weighting Imbalance (Low Priority)

**Problem**: QMD indexes both the `Raw Source` and the `Distilled Items`. Without specific weighting, the index may prioritize generic summaries over the original nuance.

**Recommendation**: Configure QMD (or the search intent) to place higher weight on the `Distilled Items` for semantic similarity while retaining the `Raw Source` for exact-match "deep retrieval."

### 6. Update Path: Source/Metadata Desync (Low Priority)

**Problem**: `PUT /api/v1/memory/:id` allows updating the raw content but **does not re-trigger LLM extraction**.

- If a user corrects a note, the "Atomic Facts" in the frontmatter become stale.
- The system continues to rely on (now incorrect) distilled items for high-relevance search.

**Recommendation**: Add a `re-extract: true` flag to the update endpoint that re-queues the memory for the extraction worker.

### 7. Explicit Architectural Limitations

- **Frozen Context**: Kore remembers what was true _at the time of ingestion_. It does not actively re-verify facts (like restaurant hours or stock prices) against the live web.
- **Recall over Reasoning**: The system is optimized for high-signal recall ("Where was that ramen shop?") rather than complex, multi-hop reasoning ("Analyze my health patterns over five years to find a correlation"). The latter is deferred to a future Knowledge Graph plugin.
- **Not a Data Dump**: Kore is designed for high-signal, explicit saves. Dumping thousands of unorganized PDFs will likely hit the "LLM extraction bottleneck" and is considered out of scope.

---

## Effectiveness at Achieving the Vision

| Vision Pillar | Status | Assessment |
|--------------|--------|------------|
| **Passive Ingestion** | Partial | API works, but `an-export` is not yet wired as a background service. Detailed design exists. |
| **LLM Distillation** | Working but fragile | Functional pipeline, but missing `intent` field and prone to extraction loss. |
| **Agentic Retrieval (Pull)** | Strong | QMD hybrid search is genuinely good. This is the most realized pillar. |
| **Proactive Nudges (Push)** | Not started | Plugin architecture is currently just an internal event dispatcher. |
| **Consolidation/Synthesis** | Design only | Detailed architecture exists. No code. `insight` type missing from schema. |

---

## Implementation Roadmap

The weaknesses form three parallel tracks with explicit dependencies:

```
Track A: Extraction Quality               Track B: Consolidation           Track C: Plugin Infra → Apple Notes
─────────────────────────                  ─────────────────────            ──────────────────────────────────

A1. Add intent/disposition                 B1. Extend MemoryTypeEnum        C1. KorePlugin start()/stop()
    field to MemoryExtractionSchema            to include "insight"         C2. PluginStartDeps interface
                                           B2. Add insights/ to TYPE_DIRS   C3. Plugin Identity Registry table
A2. Add confidence score                   B3. Implement seed selection      C4. task_id in MemoryEvent
    to extraction output                   B4. QMD candidate finder              ─── prerequisite gate ───
                                           B5. Insight type classifier       C5. plugin-apple-notes package
A3. Test constrained decoding              B6. Synthesis LLM prompts         C6. Content builder + tests
    vs fallback parsing                    B7. Insight file writer            C7. Sync loop + manifest diffing
                                           B8. Source frontmatter updater    C8. CLI: kore sync
A4. Prompt engineering:                    B9. Wire into startup sequence    C9. E2E validation
    improve category accuracy              B10. CLI: kore consolidate
                                           B11. Tuning & calibration
         │                                          │
         │                                          │
         ▼                                          ▼
    Extraction improvements              Consolidation produces better
    make newly extracted                 insights because source
    memories higher quality              memories have better facts
```

### Track Dependencies

- **A → B**: Consolidation quality is bounded by extraction quality. Better distilled items produce better insights. Deploy extraction improvements (A1–A4) before or alongside consolidation (B1–B11). Consolidation can start on infrastructure (B1–B2) immediately, but synthesis quality (B6) benefits from A1 being done first.
- **C1–C4 → C5–C9**: Apple Notes integration cannot start until the plugin infrastructure is built. C1–C4 are small, scoped changes to core-api and shared-types.
- **A, B, C are independent of each other** at the infrastructure level. They can be developed in parallel by different efforts or sequentially by one.

### Recommended Sequence (Solo Developer)

If working sequentially, the highest-value order is:

1. **A1 + B1–B2**: Schema changes (intent field, insight type). Small, unlock everything downstream.
2. **A2–A4**: Extraction quality. Immediate improvement to every new memory.
3. **B3–B11**: Consolidation system. Biggest new capability.
4. **C1–C4**: Plugin infrastructure. Small core changes.
5. **C5–C9**: Apple Notes integration. First passive source.

### Deferred

- **Push/proactive nudges**: No implementation until the pull channel is mature (consolidation working, extraction quality acceptable, at least one passive source active).
- **Knowledge Graph**: Deferred. The consolidation system's `connection` insight type covers 80% of the cross-referencing need. Revisit if it proves insufficient.
- **Content deduplication (hashing)**: Useful but not blocking. Can be added to the ingestion endpoint independently at any time.
- **Retrieval weighting**: QMD configuration change. Independent of all tracks.

---

## Bottom Line

The architecture is sound and the infrastructure choices (file-system storage, QMD retrieval, async worker) are correct. The system's ceiling is determined by **extraction quality** — everything downstream (search relevance, consolidation, proactive nudges) depends on how well the LLM distills raw content into structured, retrievable memory items.

The consolidation system is the largest missing capability. Its design is complete and architecturally consistent with the existing system (file-system native, QMD-indexed, append-only). Building it will transform Kore from a search engine over isolated notes into a system that synthesizes evolving personal knowledge.

The Apple Notes integration is the proof of concept for passive ingestion — the first source that runs without user action. It requires a small but real investment in plugin infrastructure that will pay dividends for every future source integration.

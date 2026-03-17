# Consolidation System: Detailed Architecture & Design

_2026-03-14 · Updated 2026-03-17_

This document specifies the design of Kore's background memory consolidation system — the mechanism by which isolated memories are connected, synthesized, and elevated into higher-order knowledge over time. It takes the conceptual insight from the always-on-memory-agent's "sleep cycle" and re-architects it for Kore's file-system-native, QMD-indexed, local-first environment.

---

## 1. Why Consolidation Matters

### The Problem Without It

Kore's current pipeline is: **ingest → extract → write .md → index → search**. Each memory is processed in isolation. This creates three failure modes that worsen with scale:

1. **Fragmentation.** Over months, a user accumulates 40 notes about React patterns from articles, conversations, and project learnings. QMD can find any individual note, but no single document captures the user's accumulated understanding. A query like "what's my current view on React state management?" returns 15 partial results instead of one synthesized answer.

2. **Contradiction Persistence.** A 2024 note says "prefer Redux for complex state." A 2025 note says "Zustand has replaced Redux in my workflow." Both exist with equal weight. QMD has no temporal awareness — it returns whichever has better lexical/semantic overlap with the query. The user's actual current position is never recorded.

3. **Latent Connection Blindness.** A user saves a restaurant recommendation in Tokyo (type: place) and separately saves a travel article about Ikebukuro (type: note). These are semantically related but filed in different directories with different types. Without explicit connection, a query about "planning a Tokyo trip" may surface one but not the other, depending on query terms.

### What Consolidation Provides

A background process that periodically:
- **Clusters** semantically related memories using QMD's hybrid search
- **Synthesizes** each cluster into a new insight document that captures the combined knowledge
- **Connects** memories by recording explicit relationships in frontmatter
- **Supersedes** outdated information by marking temporal evolution

The output is always a `.md` file with standard frontmatter — fully indexable by QMD, queryable via MCP, no special handling required.

---

## 2. Design Principles

### 2.1 File-System Native

Consolidation outputs are standard Kore memory files. They live in `$KORE_DATA_PATH/insights/`, follow the same frontmatter schema (with extensions), and are indexed by QMD automatically via the existing file watcher. No secondary database, no graph store, no special query path.

**Rationale:** The always-on-memory-agent stores consolidations in a separate SQLite table with a separate query tool. This creates two retrieval paths that the query agent must coordinate. Kore avoids this by making insights first-class memories — QMD handles them identically to any other document.

### 2.2 QMD-Driven Candidate Selection

The always-on-memory-agent grabs the 10 most recent unconsolidated memories regardless of topic. This produces incoherent clusters (a recipe, a meeting note, and a travel bookmark analyzed together). Kore uses QMD's hybrid search to find topically coherent clusters before sending anything to the LLM.

**Rationale:** QMD already solves the "find related documents" problem with BM25 + vectors + reranking. Consolidation should leverage this rather than reimplmenting relevance.

### 2.3 Quality is Bounded by Extraction

Consolidation primarily operates on distilled items and metadata, but includes a **truncated raw source excerpt** (first 300 chars) per memory to ground synthesis in original content and preserve qualifiers that may have been lost during extraction (see §5.3). This keeps context manageable while reducing the risk of synthesizing overly generic claims from lossy extracted facts.

Despite this grounding, if the extraction layer produces poor distilled items, consolidation can amplify the error. The [Design Effectiveness Review](./design_effectiveness_review.md) identifies extraction quality as Weakness #1 and the highest priority improvement. Extraction improvements (intent field, confidence scoring, constrained decoding) have been deployed (Track A complete) to ensure source memories have higher-quality facts.

See also: [Consolidation Design Review](./consolidation_design_review.md) — Weakness #2 (Lossy Foundation) for detailed analysis of this tradeoff and future improvements (synthesis depth tracking, re-grounding from original sources).

### 2.4 Incremental, Not Batch

Each consolidation run processes one seed memory and its related cluster. It does not attempt to consolidate the entire memory store at once. This keeps LLM calls small, focused, and fast.

**Rationale:** A 7B local model produces better output when given 3-8 focused documents than when given 15 loosely related ones. Smaller context = better synthesis.

### 2.5 Append-Only, Non-Destructive

Consolidation never modifies or deletes source memories. It creates new insight files and updates source frontmatter with metadata (`consolidated_at`, `insight_refs`). Source memories remain the authoritative record of what was originally captured.

**Rationale:** Destructive consolidation (merging/deleting originals) loses provenance and makes the system's behavior opaque. If consolidation produces bad output, the originals are unaffected.

---

## 3. Extended Schema

### 3.1 Source Memory Frontmatter Extensions

When a memory participates in a consolidation, its frontmatter gains:

```yaml
---
id: "abc-123"
type: note
category: qmd://tech/programming/react
date_saved: "2025-11-20T10:00:00Z"
source: apple_notes
tags: [react, state-management]
# ── Consolidation metadata (added by synthesis plugin) ──
consolidated_at: "2026-03-14T02:00:00Z"     # When last consolidated
insight_refs: ["ins-789", "ins-456"]          # IDs of insight files that reference this memory
---
```

These fields are **additive** — existing frontmatter is never removed or modified. The synthesis plugin writes them via a targeted frontmatter update (read → parse → merge → write).

### 3.2 Insight File Schema

Insight files use the existing `BaseFrontmatter` schema with a new type and additional fields:

```yaml
---
id: "ins-789"
type: insight                                  # New memory type
category: qmd://tech/programming/react         # Inherited from cluster's dominant category
date_saved: "2026-03-14T02:00:00Z"
source: kore_synthesis                         # Always "kore_synthesis"
tags: [react, state-management, zustand]       # Union of source tags, deduplicated
# ── Insight-specific fields ──
insight_type: evolution                        # cluster_summary | evolution | contradiction | connection
source_ids: ["abc-123", "def-456", "ghi-789"] # IDs of source memories
supersedes: ["ins-432"]                        # Previous insight on same topic, if any
superseded_by: []                              # Set when this insight is replaced by a newer one
confidence: 0.82                               # Synthesis confidence (derived from source similarity scores)
---

# React State Management: Evolved Position

## Synthesis
Across three notes spanning 2024-2026, a clear trajectory emerges: initial adoption of
Redux for complex state (Nov 2024), growing frustration with boilerplate (Mar 2025),
and migration to Zustand for new projects (Jan 2026). The current position favors
Zustand for most cases, with Redux retained only for legacy codebases.

## Key Connections
- **abc-123** ("Redux Best Practices") → foundational patterns, now partially superseded
- **def-456** ("Zustand vs Redux Comparison") → the inflection point
- **ghi-789** ("Project X State Migration") → practical confirmation of the switch

## Distilled Memory Items
- Current preferred state management library is Zustand (as of Jan 2026).
- Redux is retained only for existing legacy projects, not new development.
- The migration was motivated by Redux boilerplate overhead, not capability gaps.
- Zustand's simpler API reduced state-related bugs in Project X by roughly 40%.

---
## Source Material
Synthesized from 3 memories: abc-123, def-456, ghi-789
```

### 3.3 Insight Types

| Type | Trigger | Output |
|------|---------|--------|
| `cluster_summary` | 3+ memories on same topic with no existing insight | Consolidated reference document combining all atomic facts |
| `evolution` | 2+ memories on same topic with temporal spread (>30 days apart) | Narrative showing how understanding/position changed over time |
| `contradiction` | 2 memories with conflicting facts on the same subject | Explicit identification of the conflict with resolution if determinable |
| `connection` | 2 memories from different categories/types that are semantically related | Cross-domain link (e.g., a person ↔ a place they recommended) |

### 3.4 Type System Change

The `MemoryTypeEnum` must be extended to include `insight`:

```typescript
export const MemoryTypeEnum = z.enum(["place", "media", "note", "person", "insight"]);
```

This requires a corresponding `TYPE_DIRS` entry in the worker:

```typescript
const TYPE_DIRS: Record<string, string> = {
  place: "places",
  media: "media",
  note: "notes",
  person: "people",
  insight: "insights",  // new
};
```

---

## 4. Architecture

### 4.1 Component Overview

```
                          ┌─────────────────────────┐
                          │    Consolidation Loop    │
                          │  (Background Interval)   │
                          └────────┬────────────────┘
                                   │
                          1. Pick next seed
                                   │
                          ┌────────▼────────────────┐
                          │    Candidate Finder      │
                          │  (QMD Hybrid Search)     │
                          └────────┬────────────────┘
                                   │
                          2. Score & filter cluster
                                   │
                          ┌────────▼────────────────┐
                          │    Cluster Analyzer      │
                          │  (Determine insight type)│
                          └────────┬────────────────┘
                                   │
                          3. Classify the relationship
                                   │
                          ┌────────▼────────────────┐
                          │   Synthesis LLM Call     │
                          │  (Structured output)     │
                          └────────┬────────────────┘
                                   │
                          4. Generate insight
                                   │
                     ┌─────────────┼─────────────────┐
                     │             │                  │
              ┌──────▼──────┐ ┌───▼──────────┐ ┌────▼────────┐
              │ Write .md   │ │ Update source│ │ QMD re-index│
              │ insight file│ │ frontmatters │ │ (via watcher)│
              └─────────────┘ └──────────────┘ └─────────────┘
```

### 4.2 The Consolidation Loop

The consolidation loop runs as a background interval, similar to the existing embedder interval. It is **not** a plugin hook — it is a standalone background service started alongside the worker, watcher, and embedder.

```typescript
export interface ConsolidationDeps {
  dataPath: string;
  qmdSearch: typeof search;        // from @kore/qmd-client
  extractFn: typeof synthesize;    // synthesis-specific LLM call
  tracker: ConsolidationTracker;   // SQLite tracking table (see §4.6)
  intervalMs: number;              // default: 30 minutes
  minClusterSize: number;          // default: 3
  maxClusterSize: number;          // default: 8
  minSimilarityScore: number;      // default: 0.45
  cooldownDays: number;            // default: 7 (don't re-consolidate within 7 days)
  maxSynthesisAttempts: number;    // default: 3 (dead-letter after N failures)
}
```

**Concurrency guard:** The loop uses a `running` boolean to prevent overlapping cycles (same pattern as the Apple Notes sync loop in `plugin-apple-notes/sync-loop.ts`). If a slow LLM inference causes a cycle to exceed the interval, the next interval invocation is a no-op.

**Loop behavior:**
1. **Check re-evaluation queue first.** Query the consolidation tracker (§4.6) for insights with `status = 'evolving'` or `status = 'degraded'`. If found, process the oldest one (see §10.6 for re-evaluation logic). Otherwise, proceed to step 2.
2. **Select seed.** Query the tracker for the next unconsolidated memory (no `consolidated_at`, or `consolidated_at` older than `cooldownDays`). Prioritize: (a) never consolidated, (b) oldest `consolidated_at`. Skip memories of type `insight` and any with `synthesis_attempts >= maxSynthesisAttempts`.
3. **Find candidates.** Use QMD hybrid search with the seed's title + distilled items as the query. Filter results to `score >= minSimilarityScore`. Exclude the seed itself and any insight files.
4. **Validate cluster.** If `candidates.length + 1 < minClusterSize`, skip this seed (not enough related material yet). Cap at `maxClusterSize` to keep context manageable.
5. **Classify insight type.** Deterministic rules (see §4.3).
6. **Synthesize.** Send the cluster to the LLM with a type-specific prompt. Receive structured output. On failure, increment `synthesis_attempts` in the tracker and skip to next interval.
7. **Write insight file.** Render as standard Kore markdown, write to `$KORE_DATA_PATH/insights/`. **Write the insight file before updating source frontmatter** (see §7.1 for crash recovery rationale).
8. **Update sources.** Add `consolidated_at` and `insight_refs` to each source memory's frontmatter.
9. **Update tracker.** Record the consolidation in the tracking table.
10. **Sleep until next interval.**

One seed per cycle. At 30-minute intervals, this processes up to 48 memories per day — sufficient for typical personal knowledge volumes without excessive LLM load.

### 4.3 Insight Type Classification

Classification is deterministic (no LLM needed), based on cluster properties:

```
function classifyInsightType(seed, candidates):
  // Check for temporal spread
  dates = [seed.date_saved, ...candidates.map(c => c.date_saved)]
  spanDays = max(dates) - min(dates)

  // Check for cross-category connections
  categories = unique([seed.category, ...candidates.map(c => c.category)])
  types = unique([seed.type, ...candidates.map(c => c.type)])

  if categories.length > 1 OR types.length > 1:
    return "connection"

  if spanDays > 30:
    return "evolution"

  // Default for same-topic clusters
  return "cluster_summary"
```

Note: `contradiction` is detected by the LLM during synthesis, not pre-classified. If the LLM identifies contradictory facts in a `cluster_summary` or `evolution` synthesis, it flags the output as `contradiction` type instead.

### 4.4 Candidate Finder: QMD Query Construction

The query sent to QMD for candidate discovery is constructed from the seed memory:

```typescript
function buildConsolidationQuery(seed: ParsedMemory): string {
  // Combine title and first 3 distilled items for a rich query
  const items = seed.distilledItems.slice(0, 3).join(". ");
  return `${seed.title}. ${items}`;
}
```

**Why not just the title?** Titles are often terse labels ("Mutekiya Ramen"). The distilled items carry the semantic content that QMD's vector search needs for meaningful similarity ("Ramen shop in Ikebukuro recommended by John for solo dining").

**Search options:**

```typescript
const results = await qmdSearch(query, {
  limit: maxClusterSize + 5,  // over-fetch to account for filtering
  collection: "memories",
  intent: "Find memories related to the same topic, concept, or entity for knowledge consolidation",
});
```

The `intent` parameter steers QMD's query expansion and reranking toward consolidation-relevant results rather than generic similarity.

### 4.5 Deduplication With Existing Insights

Before creating a new insight, the system checks whether an insight already exists for this cluster:

1. Search for existing insights whose `source_ids` overlap with the current cluster by >50%.
2. If found, this is an **update** to an existing insight, not a new one.
3. The new insight file sets `supersedes: ["<old-insight-id>"]`.
4. The old insight file is not deleted (append-only principle). Its frontmatter is updated with `superseded_by: ["<new-insight-id>"]` and `status: retired`.
5. **Default search filtering:** The search endpoint must filter out `status: retired` insights from results. Without this, queries return multiple versions of the same evolving insight, cluttering results. Users can opt in to historical results via an explicit flag (e.g., `include_retired: true`).

This prevents insight proliferation — the same topic doesn't generate a new insight file every 30 minutes. The `superseded_by` / `supersedes` bidirectional chain enables provenance traversal when needed.

### 4.6 Consolidation Tracker (SQLite)

The consolidation loop must not scan the file system to find work. Parsing YAML frontmatter from hundreds of files every 30 minutes is an unacceptable I/O bottleneck for a background process. Instead, a lightweight SQLite tracking table (in the same `kore-queue.db` used by `QueueRepository` and `PluginRegistryRepository`) provides the work queues.

```sql
CREATE TABLE IF NOT EXISTS consolidation_tracker (
  memory_id TEXT PRIMARY KEY,               -- Kore memory UUID
  memory_type TEXT NOT NULL,                 -- 'note', 'place', 'media', 'person', 'insight'
  consolidated_at DATETIME,                 -- when last consolidated (null = never)
  status TEXT DEFAULT 'pending',            -- pending | active | evolving | degraded | retired | failed
  re_eval_reason TEXT,                      -- new_evidence | source_deleted | null
  synthesis_attempts INTEGER DEFAULT 0,     -- incremented on each failed synthesis
  last_attempted_at DATETIME,               -- when synthesis was last attempted
  updated_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_consolidation_status ON consolidation_tracker(status);
CREATE INDEX idx_consolidation_pending ON consolidation_tracker(consolidated_at, memory_type)
  WHERE status = 'pending' AND memory_type != 'insight';
```

**Population:** The tracker is populated by:
- **Worker** (`onMemoryIndexed`): Inserts a row with `status = 'pending'` for every new memory. This is the only write path for new entries — no file scanning needed.
- **Consolidation loop**: Updates `consolidated_at`, `status`, `synthesis_attempts` after processing.
- **Lifecycle handlers**: Update `status` to `evolving`, `degraded`, or `retired` based on events (§10.3, §10.4).

**Seed selection query:**
```sql
SELECT memory_id FROM consolidation_tracker
WHERE memory_type != 'insight'
  AND status NOT IN ('failed', 'retired')
  AND synthesis_attempts < ?  -- maxSynthesisAttempts
  AND (consolidated_at IS NULL OR consolidated_at < datetime('now', ? || ' days'))
ORDER BY
  CASE WHEN consolidated_at IS NULL THEN 0 ELSE 1 END,  -- never-consolidated first
  consolidated_at ASC
LIMIT 1;
```

**Re-evaluation query:**
```sql
SELECT memory_id FROM consolidation_tracker
WHERE memory_type = 'insight'
  AND status IN ('evolving', 'degraded')
  AND synthesis_attempts < ?
ORDER BY updated_at ASC
LIMIT 1;
```

**Failure throttling:** When synthesis fails (LLM produces invalid JSON, schema validation error), `synthesis_attempts` is incremented and `last_attempted_at` is set. After `maxSynthesisAttempts` (default: 3) failures, `status` is set to `'failed'`. Failed entries are skipped by the seed selection query. A manual `POST /api/v1/consolidate?reset_failed=true` endpoint can reset failed entries for retry.

### 4.7 State Transition Matrix

Explicit state transitions for insight lifecycle. Terminal states are marked. Invalid transitions are rejected.

```
From State    → To State      Trigger                          Action
─────────────────────────────────────────────────────────────────────────────
pending       → pending       (no change — awaiting first consolidation)
pending       → active        First successful consolidation   Write insight, update sources
active        → evolving      New related memory detected      Set re_eval_reason
active        → degraded      >50% source memories deleted     Lower confidence
active        → retired       Superseded by new insight        Set superseded_by
evolving      → active        Successful re-synthesis          Write new insight, retire old
evolving      → failed        synthesis_attempts >= max        Dead-letter
degraded      → active        Successful re-synthesis          Write new insight with remaining sources
degraded      → retired       All source memories deleted      Terminal
degraded      → failed        synthesis_attempts >= max        Dead-letter
retired       → (terminal)    —                                Filtered from search results
failed        → pending       Manual reset via API             Reset synthesis_attempts to 0
```

**Notes:**
- `retired` is terminal. Once superseded or emptied of sources, an insight does not come back. Its content is preserved on disk for provenance but excluded from search.
- `failed` is recoverable via manual API reset only. This prevents infinite retry loops while allowing operator intervention.
- `degraded` can transition to `active` (via re-synthesis with remaining sources) or `retired` (if all sources gone). It cannot transition to `evolving` — degradation is always re-evaluated immediately on the next cycle.

---

## 5. Synthesis LLM Integration

### 5.1 Model Choice

The synthesis LLM call uses the same Ollama infrastructure as the extraction pipeline. Same model (`OLLAMA_MODEL`), same provider setup. This keeps the system simple — one model, one inference server.

A dedicated `KORE_SYNTHESIS_MODEL` env var allows overriding with a more capable model if available (e.g., a 14B model for synthesis while using 7B for extraction).

### 5.2 Synthesis Prompts

Each insight type has a specialized system prompt. The prompts enforce structured output.

#### Cluster Summary Prompt

```
You are a knowledge consolidation engine for a personal memory system.

Given a cluster of related memories on the same topic, synthesize them into a single
reference document that captures all unique facts, removes redundancy, and presents
the information as a coherent summary.

## Rules
- Before synthesizing, examine all source facts for contradictions. If two memories
  state conflicting things about the same subject, explicitly identify the conflict,
  note which memory is more recent (use the saved date), and flag the most current
  position. If significant contradictions exist, set insight_type to "contradiction"
  regardless of the requested type.
- Write a synthesis paragraph (3-5 sentences) capturing the combined knowledge.
- List 2-5 key connections between the source memories (which memory relates to which, and how).
- Extract 3-7 distilled items that represent the consolidated facts. Prefer facts that
  appear in multiple sources or that represent the most actionable/distinctive information.
- Generate a title that describes the consolidated topic, not any individual memory.

Respond with ONLY valid JSON matching this schema:
{
  "title": "string",
  "insight_type": "cluster_summary" | "contradiction",
  "synthesis": "string (3-5 sentence paragraph)",
  "connections": [{"source_id": "string", "target_id": "string", "relationship": "string"}],
  "distilled_items": ["string"],
  "tags": ["string (kebab-case, max 5)"]
}
```

#### Evolution Prompt

```
You are a knowledge consolidation engine for a personal memory system.

Given a set of memories on the same topic saved at different times, identify how the user's
understanding, position, or practices have changed over time.

## Rules
- Before synthesizing, examine all source facts for contradictions. If two memories
  state conflicting things about the same subject, explicitly identify the conflict,
  note which memory is more recent (use the saved date), and flag the most current
  position. If significant contradictions exist, set insight_type to "contradiction"
  regardless of the requested type.
- Write a synthesis paragraph (3-5 sentences) describing the evolution trajectory.
- Identify the chronological progression: what was the earlier position, what changed,
  what is the current position.
- The distilled items should capture the CURRENT state of knowledge, not historical positions.
  Historical context belongs in the synthesis paragraph.
- If the evolution reveals a clear contradiction between old and new, note which position
  is more recent and likely current.

Respond with ONLY valid JSON matching this schema:
{
  "title": "string",
  "insight_type": "evolution",
  "synthesis": "string (3-5 sentence paragraph)",
  "connections": [{"source_id": "string", "target_id": "string", "relationship": "string"}],
  "distilled_items": ["string"],
  "tags": ["string (kebab-case, max 5)"]
}
```

#### Connection Prompt

```
You are a knowledge consolidation engine for a personal memory system.

Given memories from different categories or types that are semantically related,
identify and articulate the cross-domain connection.

## Rules
- Before synthesizing, examine all source facts for contradictions. If two memories
  state conflicting things about the same subject, explicitly identify the conflict,
  note which memory is more recent (use the saved date), and flag the most current
  position. If significant contradictions exist, set insight_type to "contradiction"
  regardless of the requested type.
- Write a synthesis paragraph (2-3 sentences) explaining why these memories are connected
  despite being in different categories.
- The connection should be non-obvious and useful — not just "both mention Tokyo."
- Distilled items should capture the actionable cross-domain insight.
  Example: "John (person) recommended Mutekiya (place) for solo dining in Ikebukuro."

Respond with ONLY valid JSON matching this schema:
{
  "title": "string",
  "insight_type": "connection",
  "synthesis": "string (2-3 sentence paragraph)",
  "connections": [{"source_id": "string", "target_id": "string", "relationship": "string"}],
  "distilled_items": ["string"],
  "tags": ["string (kebab-case, max 5)"]
}
```

### 5.3 LLM Input Construction

The LLM receives the full cluster as structured context:

```typescript
function buildSynthesisPrompt(
  seed: ParsedMemory,
  candidates: ParsedMemory[],
  insightType: InsightType
): string {
  const cluster = [seed, ...candidates];
  const memoryBlocks = cluster.map((m, i) => {
    const lines = [
      `### Memory ${i + 1} (ID: ${m.id}, saved: ${m.dateSaved})`,
      `- **Title:** ${m.title}`,
      `- **Type:** ${m.type}`,
      `- **Category:** ${m.category}`,
      `- **Tags:** ${m.tags.join(", ")}`,
      `- **Facts:**`,
      ...m.distilledItems.map(item => `  - ${item}`),
    ];

    // Include truncated raw source excerpt for grounding (preserves qualifiers
    // and context that may have been lost during extraction)
    if (m.rawSourceSnippet) {
      lines.push(`- **Source excerpt:** "${m.rawSourceSnippet.slice(0, 300)}..."`);
    }

    return lines.join("\n");
  });

  return `Insight type requested: ${insightType}\n\n${memoryBlocks.join("\n\n")}`;
}
```

The synthesis input includes distilled items (primary), metadata, and a **truncated raw source excerpt** (first 300 chars) per memory. The raw snippet grounds the synthesis in original content, preserving qualifiers and nuance that extraction may have compressed. At ~300 chars × 8 memories = ~2400 extra chars, this is well within context budget for a 7B model.

See [Consolidation Design Review](./consolidation_design_review.md) — Weakness #2 for analysis of the lossy foundation tradeoff and future improvements (synthesis depth tracking at V2).

### 5.4 Output Validation

The synthesis output goes through the same pattern as extraction: structured output via Vercel AI SDK `Output.object()` with Zod schema enforcement, falling back to text + JSON parsing.

```typescript
const InsightOutputSchema = z.object({
  title: z.string(),
  insight_type: z.enum(["cluster_summary", "evolution", "contradiction", "connection"]),
  synthesis: z.string(),
  connections: z.array(z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
  })),
  distilled_items: z.array(z.string()).min(1).max(7),
  tags: z.array(z.string()).min(1).max(5),
});
```

---

## 6. Confidence Scoring

Each insight carries a `confidence` score (0.0–1.0) derived from the input cluster, not from the LLM. This avoids the problem of LLMs being overconfident about their own synthesis quality.

```typescript
function computeConfidence(
  seedScore: number,          // always 1.0 (exact match to itself)
  candidateScores: number[],  // QMD similarity scores
  clusterSize: number
): number {
  const avgSimilarity = candidateScores.reduce((a, b) => a + b, 0) / candidateScores.length;
  const sizeFactor = Math.min(clusterSize / 5, 1.0);  // clusters of 5+ get full size credit
  return Number((avgSimilarity * 0.7 + sizeFactor * 0.3).toFixed(2));
}
```

**Interpretation:**
- **0.8–1.0:** High confidence — tight cluster with strong similarity scores, 5+ memories
- **0.6–0.8:** Moderate — reasonable cluster, good for summaries
- **0.4–0.6:** Low — loose cluster, connections may be tenuous
- **<0.4:** Should not reach synthesis (filtered by `minSimilarityScore`)

---

## 7. Frontmatter Update Mechanics

Updating source memory frontmatter requires care — we must preserve the existing file content while adding consolidation metadata.

```typescript
async function updateSourceFrontmatter(
  filePath: string,
  insightId: string,
  timestamp: string
): Promise<void> {
  const content = await Bun.file(filePath).text();
  const fmEnd = content.indexOf("---", 4);  // find closing ---
  if (fmEnd === -1) return;

  const frontmatter = content.slice(4, fmEnd);  // between opening and closing ---
  const body = content.slice(fmEnd);

  // Parse existing YAML, merge new fields
  const parsed = parseYaml(frontmatter);
  parsed.consolidated_at = timestamp;
  parsed.insight_refs = [...new Set([...(parsed.insight_refs || []), insightId])];

  const updated = `---\n${stringifyYaml(parsed)}${body}`;
  await Bun.write(filePath, updated);
}
```

This triggers the file watcher → QMD re-index, ensuring the updated frontmatter is searchable.

### 7.1 Write Ordering and Crash Recovery

Creating an insight requires modifying N+1 files: 1 new insight file + N source memory frontmatter updates. File systems are not transactional — a crash mid-operation leaves partial state.

**Write ordering:** Always write the insight file **first**, then update source frontmatter. Rationale: an insight file that exists without corresponding `insight_refs` in sources is harmless (sources just don't know about it yet). The reverse — source frontmatter referencing a non-existent insight — causes errors when the lifecycle system tries to load the referenced insight.

**Startup reconciliation:** On server startup, run a lightweight consistency check:

1. **Forward check:** For each `active` insight in the tracker, verify the insight file exists on disk. If not (crashed after tracker update but before file write), remove the tracker entry.
2. **Backward check:** For each insight file on disk, verify it has a tracker entry. If not (crashed after file write but before tracker update), add the entry.
3. **Orphaned refs:** When reading `insight_refs` from a source memory's frontmatter, treat references to non-existent insight files as no-ops. Do not error. The next consolidation cycle involving that source memory will clean up stale refs during the frontmatter update.

This reconciliation runs once at startup and takes O(N) time proportional to the insight count — negligible for typical corpus sizes.

### 7.2 Handling Manual Insight Deletion

If a user manually deletes an insight file from the file system (via `rm`, Finder, or `kore delete`):

- Source memories retain stale `insight_refs` entries pointing to the deleted insight ID.
- The consolidation tracker retains the entry for the deleted insight.

**Resolution:** The `onMemoryDeleted` handler (which fires for any file deletion detected by the watcher) checks if the deleted file was an insight (type `insight`). If so:
1. Update the tracker: set `status = 'retired'`.
2. Stale `insight_refs` in source files are cleaned up lazily — the next time any source memory participates in a consolidation cycle, its `insight_refs` are validated and dead refs are pruned during the frontmatter update.

---

## 8. Integration Points

### 8.1 Startup Sequence Addition

The consolidation loop starts after the embedder, as it depends on QMD search being functional:

```
Existing:
  7. startWorker()
  8. startWatcher()
  9. startEmbedInterval()
New:
  10. startConsolidationLoop()    ← after embedder ensures vectors exist
```

### 8.2 Plugin System Interaction

The consolidation system dispatches `onMemoryIndexed` events when it writes insight files. Existing plugins (e.g., Spatialite) receive these events normally. The `source: "kore_synthesis"` field allows plugins to distinguish synthesized content from ingested content.

### 8.3 API Surface

No new API endpoints are strictly required — insights are memories and appear in existing endpoints:

- `GET /api/v1/memories?type=insight` — list all insights
- `GET /api/v1/memory/:id` — fetch a specific insight
- `POST /api/v1/search` — QMD returns insights alongside regular memories (often ranked highly due to density of relevant content)

One optional endpoint for manual control:

- `POST /api/v1/consolidate` — trigger an immediate consolidation cycle (useful for testing)

### 8.4 CLI Addition

```
kore consolidate              # Trigger one consolidation cycle manually
kore consolidate --dry-run    # Show what would be synthesized without writing to disk
kore list --type insight      # Already works with existing --type filter
```

The `--dry-run` flag runs the full pipeline (seed selection, candidate finding, cluster analysis, type classification) but stops before the LLM synthesis call. It prints the proposed cluster: seed memory, candidates with similarity scores, proposed insight type, and confidence estimate. Useful for calibrating thresholds and understanding system behavior without generating insight files.

### 8.5 Reset Integration

The existing `DELETE /api/v1/memories` (reset) already deletes all files in `$KORE_DATA_PATH` recursively. Since insights live in `$KORE_DATA_PATH/insights/`, they are automatically included in a full reset.

---

## 9. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| LLM produces bad synthesis | Low-quality insight indexed | Confidence score + `source: kore_synthesis` allows filtering; originals preserved |
| LLM produces invalid JSON repeatedly | Cluster blocks the queue | `synthesis_attempts` incremented per failure; dead-lettered after `maxSynthesisAttempts` (3); `status: failed` (§4.6) |
| QMD search returns poor candidates | Incoherent cluster | `minSimilarityScore` threshold (0.45) filters weak matches; `minClusterSize` (3) prevents trivial insights |
| Frontmatter update corrupts source file | Data loss | Read-parse-merge-write pattern; insight file written first (§7.1) |
| Crash mid-consolidation | Partial state (insight written, sources not updated) | Startup reconciliation heals orphaned insight files and stale refs (§7.1) |
| Manual insight deletion | Stale `insight_refs` in source files | Lazy cleanup on next consolidation cycle; tracker updated via `onMemoryDeleted` (§7.2) |
| Consolidation runs before embeddings exist | No vector search results | Schedule after embedder; QMD falls back to BM25 which still finds related content |
| Too many insights generated | Index noise | Dedup check against existing insights with overlapping `source_ids`; cooldown period |
| Superseded insights pollute search | Multiple versions of same insight in results | `status: retired` insights filtered from default search results (§4.5) |
| Model unavailable (Ollama down) | Consolidation silently fails | Log error, increment `synthesis_attempts`, retry next interval |
| Overlapping cycles (slow LLM) | Duplicate synthesis | `running` boolean guard prevents concurrent cycles (§4.2) |

---

## 10. Insight Lifecycle: Self-Learning & Evolution

_Added 2026-03-17_

The original design treats insights as static snapshots — created once, occasionally superseded. This section extends the design with a self-learning lifecycle where insights evolve autonomously as new knowledge enters the system and existing knowledge changes.

### 10.1 The Problem With Static Insights

A static insight is correct at the moment of creation but degrades in three ways:

1. **New evidence ignored.** A user saves a new memory about React state management. An existing insight on that topic doesn't incorporate it — the insight is stale while the user's actual knowledge has grown.
2. **Source material deleted.** A user removes a memory that was one of three sources for an insight. The insight now makes claims based on material that no longer exists in the system.
3. **No quality signal over time.** There's no way to distinguish a well-supported insight from a weakly-supported one as the knowledge base grows. All insights have equal standing regardless of how much evidence backs them.

### 10.2 Insight Lifecycle States

Insights transition through states based on autonomous signals — no manual intervention required:

```
                    new evidence
                   ┌───────────┐
                   │           ▼
  create ──► active ──► evolving ──► active (re-synthesized)
                │                       │
                │   sources deleted      │
                ▼                       ▼
            degraded ──────────► retired
```

| State | Meaning | Trigger |
|-------|---------|---------|
| `active` | Insight is current and well-supported | Initial creation, or successful re-synthesis |
| `evolving` | Flagged for re-synthesis on next cycle | New related memory detected, or enough time + evidence has accumulated |
| `degraded` | Source material partially lost | >50% of `source_ids` refer to deleted memories |
| `retired` | No longer trustworthy | All source memories deleted, or re-synthesis failed to produce meaningful output |

All transitions are autonomous. The system detects triggers via existing event hooks (`onMemoryIndexed`, `onMemoryDeleted`) and the consolidation loop itself.

### 10.3 Reactive Re-synthesis (New Evidence)

This is the core self-learning mechanism. When a new memory arrives that is semantically related to an existing insight, the insight is flagged for re-evaluation.

**Detection mechanism:**

When `onMemoryIndexed` fires for any new memory (not of type `insight`):

1. Construct a query from the new memory's title + first 3 distilled items
2. Search QMD for results with `type: insight` and `score >= relevanceThreshold` (e.g., 0.5)
3. For each matching insight, check if the new memory is genuinely related (not already in `source_ids`)
4. If related, set the insight's frontmatter `status: evolving` and `re_eval_reason: new_evidence`

**Re-synthesis on next consolidation cycle:**

The consolidation loop checks for `evolving` insights before picking new seeds. For each evolving insight:

1. Load the insight's current `source_ids` as the base cluster
2. Search QMD for the insight's topic (using its title + distilled items) to find additional candidates — including the new memory that triggered the flag
3. Re-synthesize with the expanded cluster using the same type-specific prompt
4. Write a new insight file with `supersedes: ["<old-insight-id>"]`
5. Set the old insight's status to `retired` (it has been replaced)
6. Update source frontmatter (`insight_refs`) on all participating memories

**Why not re-synthesize immediately on `onMemoryIndexed`?**

- The embedder may not have generated vectors for the new memory yet
- Multiple related memories may arrive in quick succession (e.g., Apple Notes sync batch) — batching avoids redundant re-synthesis
- The consolidation loop already handles one-at-a-time processing with proper error handling

**Throttling:** An insight can only transition to `evolving` once per `cooldownDays` period. This prevents a burst of new memories from triggering repeated re-synthesis of the same insight.

### 10.4 Source Integrity Checking (Deleted Sources)

When a memory is deleted (via API, CLI, or plugin), the system checks whether any insights depend on it.

**Detection mechanism:**

When `onMemoryDeleted` fires:

1. Scan insight files in `$KORE_DATA_PATH/insights/` whose `source_ids` contain the deleted memory's ID
2. For each affected insight, count how many `source_ids` still exist on disk
3. Apply state transition:

```
remaining_sources = source_ids.filter(id => memoryExists(id))
ratio = remaining_sources.length / source_ids.length

if ratio == 0:
  status → retired (no sources remain)
elif ratio < 0.5:
  status → degraded
else:
  status → evolving, re_eval_reason → source_deleted
  (re-synthesize with remaining sources on next cycle)
```

**Rationale for the 50% threshold:** An insight built from 6 memories that loses 1 is still well-supported — it should be re-synthesized with the remaining 5, not degraded. An insight built from 3 memories that loses 2 is on shaky ground — it's degraded until re-synthesis confirms or retires it.

**Degraded insights in search:** Degraded and retired insights should rank lower in search results. This can be achieved by:
- Setting `confidence` to a low value (e.g., 0.2 for degraded, 0.0 for retired)
- Or filtering them out of search results entirely via QMD collection/tag filtering

### 10.5 Revised Confidence Model

The original confidence model (§6) uses only QMD similarity scores and cluster size at creation time. The revised model incorporates ongoing signals to produce a **living confidence score** that reflects how well-supported an insight is over time.

#### 10.5.1 Factors

| Factor | Signal | Rationale |
|--------|--------|-----------|
| **Cluster tightness** | Average QMD similarity score of source memories | Tight clusters produce more coherent insights |
| **Cluster size** | Number of source memories | More evidence = more robust. An insight from 7 memories is more trustworthy than one from 3 |
| **Reinforcement** | Count of new memories that arrived post-creation and supported the insight (triggered re-synthesis) | Knowledge that keeps being confirmed is more reliable |
| **Source integrity** | Ratio of source memories still present | Lost sources weaken the foundation |

#### 10.5.2 Computation

```typescript
function computeInsightConfidence(params: {
  avgSimilarity: number;       // QMD similarity scores, 0.0–1.0
  clusterSize: number;         // number of source memories
  reinforcementCount: number;  // times re-synthesized with new evidence
  sourceIntegrity: number;     // ratio of source_ids still on disk (0.0–1.0)
}): number {
  const { avgSimilarity, clusterSize, reinforcementCount, sourceIntegrity } = params;

  // Cluster size: 3 = baseline (0.6), 5 = strong (1.0), 8+ = max
  const sizeFactor = Math.min((clusterSize - 2) / 3, 1.0);

  // Reinforcement: each re-synthesis adds a diminishing boost
  // 0 = neutral (1.0), 1 = small boost (1.05), 3+ = cap (1.15)
  const reinforcementFactor = Math.min(1.0 + reinforcementCount * 0.05, 1.15);

  // Base confidence from cluster quality
  const base = avgSimilarity * 0.5 + sizeFactor * 0.5;

  // Apply reinforcement boost and source integrity penalty
  const adjusted = base * reinforcementFactor * sourceIntegrity;

  return Number(Math.min(adjusted, 1.0).toFixed(2));
}
```

**Key design choices:**

- **No time-based decay.** A recipe insight from 2022 with all sources intact is just as valid as one from yesterday. Age alone is not a quality signal — what matters is source integrity and whether new contradicting evidence has arrived. Stale knowledge is handled by reactive re-synthesis when new evidence appears, not by penalizing silence.
- **Cluster size is heavily weighted.** An insight synthesized from 7 converging memories deserves significantly more confidence than one from 3 loosely related ones. The `sizeFactor` gives this a 50% weight, equal to similarity.
- **Reinforcement is a soft boost, not dominant.** Each re-synthesis with new supporting evidence nudges confidence up by 5%, capped at 15%. This rewards actively-relevant topics without inflating confidence unboundedly.
- **Source integrity is multiplicative.** Losing 50% of sources halves the confidence regardless of how strong the original cluster was. This is intentionally aggressive — an insight that's lost its foundation should drop fast.

#### 10.5.3 Why Not Time-Based Decay?

The initial design considered confidence decay over time (insights lose confidence if not reinforced). This was rejected because:

1. **Domain-dependent staleness.** A programming tutorial from 2024 may be outdated; a restaurant recommendation from 2024 is probably still valid. Any time-based decay would need category-aware rules, adding complexity for marginal benefit.
2. **Silence is neutral, not negative.** The absence of new evidence doesn't mean existing evidence is wrong. A well-synthesized insight about a niche topic may never receive reinforcement simply because the user doesn't save more content on that topic — that doesn't make it less trustworthy.
3. **Reactive re-synthesis handles staleness.** When genuinely outdated knowledge is contradicted by new evidence, the reactive re-synthesis mechanism (§10.3) detects it and triggers an evolution-type re-synthesis. This handles staleness precisely where it matters, without penalizing stable knowledge.
4. **Simplicity.** A decay function requires choosing a half-life, handling edge cases (paused systems, bulk imports), and explaining non-obvious confidence drops to users. The input-derived model is transparent: confidence reflects what went into the insight, not how long ago it happened.

### 10.6 Re-evaluation Queue

The consolidation loop (§4.2) is extended with a **dual-queue** design. The loop checks two sources of work, in priority order:

```
Each consolidation cycle:
  1. Check for evolving/degraded insights  → re-synthesis queue
  2. If none, pick a new seed              → new insight queue (existing behavior)
```

**Priority rationale:** Maintaining the accuracy of existing insights is more important than creating new ones. A degraded insight actively serves wrong information to the user; an unconsolidated memory is merely a missed opportunity.

**Re-synthesis queue processing:**

1. Load the insight file and its `source_ids`
2. Resolve which source memories still exist on disk
3. If `re_eval_reason` is `new_evidence`: search QMD for additional candidates using the insight's topic. The new memory that triggered the flag should appear in results.
4. If `re_eval_reason` is `source_deleted`: re-synthesize with remaining sources only
5. If the remaining cluster is below `minClusterSize`: retire the insight (not enough material to justify synthesis)
6. Otherwise: re-synthesize, write new insight, supersede old one

**Updated `ConsolidationDeps`:**

```typescript
export interface ConsolidationDeps {
  dataPath: string;
  qmdSearch: typeof search;
  extractFn: typeof synthesize;
  intervalMs: number;              // default: 30 minutes
  minClusterSize: number;          // default: 3
  maxClusterSize: number;          // default: 8
  minSimilarityScore: number;      // default: 0.45
  cooldownDays: number;            // default: 7
  relevanceThreshold: number;      // default: 0.5 (for reactive re-synthesis detection)
}
```

### 10.7 Frontmatter Extensions for Lifecycle

The insight frontmatter schema (§3.2) gains lifecycle fields:

```yaml
---
id: "ins-789"
type: insight
category: qmd://tech/programming/react
date_saved: "2026-03-14T02:00:00Z"
source: kore_synthesis
tags: [react, state-management, zustand]
# ── Insight-specific fields ──
insight_type: evolution
source_ids: ["abc-123", "def-456", "ghi-789"]
supersedes: ["ins-432"]
superseded_by: []                           # set when replaced by newer insight
confidence: 0.82
# ── Lifecycle fields ──
status: active                              # active | evolving | degraded | retired | failed
reinforcement_count: 2                      # times re-synthesized with new evidence
re_eval_reason: null                        # new_evidence | source_deleted | null
last_synthesized_at: "2026-03-17T02:00:00Z" # when this version of the insight was generated
---
```

All new fields are optional with sensible defaults:
- `status`: defaults to `"active"` on creation
- `reinforcement_count`: defaults to `0`
- `re_eval_reason`: defaults to `null`
- `last_synthesized_at`: set to `date_saved` on initial creation

### 10.8 Integration With Existing Event System

The lifecycle system hooks into Kore's existing `EventDispatcher`:

| Event | Lifecycle Action |
|-------|-----------------|
| `memory.indexed` (type ≠ insight) | Search for related insights; flag as `evolving` if found (§10.3) |
| `memory.deleted` | Check insight `source_ids`; transition to `degraded` or `retired` (§10.4) |
| `memory.updated` | Same as delete + re-index: update source integrity, flag for re-eval if needed |

These handlers run in the consolidation service, registered as event listeners alongside the existing plugin event dispatching. They do **not** require extending the `KorePlugin` interface — the consolidation service is a core service with direct access to the event dispatcher.

### 10.9 Lifecycle Walkthrough Example

A concrete example showing how an insight evolves over time:

**Day 1:** User saves 4 memories about sourdough baking techniques from different sources. The consolidation loop clusters them and creates an insight:
- `ins-001`: "Sourdough Baking Techniques" (type: `cluster_summary`, confidence: 0.78, 4 sources, status: `active`)

**Day 5:** User saves a new memory about a sourdough masterclass they attended. `onMemoryIndexed` fires, QMD finds `ins-001` as highly relevant (score: 0.72). The insight is flagged:
- `ins-001`: status → `evolving`, re_eval_reason → `new_evidence`

**Day 5 (next consolidation cycle):** The loop picks up `ins-001` from the re-evaluation queue. It loads the 4 original sources + the new masterclass memory, re-synthesizes, and writes:
- `ins-002`: "Sourdough Baking Techniques" (type: `cluster_summary`, confidence: 0.85, 5 sources, reinforcement_count: 1, supersedes: ["ins-001"])
- `ins-001`: status → `retired`

**Day 12:** User deletes 2 of the original source memories (cleaning up duplicates). `onMemoryDeleted` fires for each. After both deletions, `ins-002` has 3 of 5 sources remaining (60%):
- `ins-002`: status → `evolving`, re_eval_reason → `source_deleted`

**Day 12 (next consolidation cycle):** Re-synthesizes with 3 remaining sources. Cluster still meets `minClusterSize` (3), so a new insight is written:
- `ins-003`: "Sourdough Baking Techniques" (confidence: 0.68, 3 sources, reinforcement_count: 2, supersedes: ["ins-002"])

**Day 30:** User saves a memory claiming "sourdough starters die if not fed daily" — contradicting a distilled item in `ins-003` that says "weekly feeding is sufficient for refrigerated starters." The re-synthesis detects this and produces:
- `ins-004`: type: `contradiction`, noting the conflicting positions and which source is more recent

---

## 11. What This Design Intentionally Omits

### Knowledge Graph (Plugin Type B from earlier analysis)

The graph database approach (Neo4j, custom SQLite graph tables) is deferred. The insight file approach solves 80% of the cross-referencing problem with 20% of the complexity. A graph plugin can be built later if the connection insight type proves insufficient — it would consume the same `connections` data from insight files as its seed.

### Real-Time Consolidation

Consolidation is not triggered on every new memory ingestion. This is intentional:
- The embedder needs time to generate vectors for new content
- Immediate consolidation would re-process the same cluster every time a related memory arrives
- The cooldown period ensures clusters have time to accumulate before synthesis

The lifecycle system (§10) flags insights for re-evaluation via `onMemoryIndexed`, but the actual re-synthesis is deferred to the next consolidation cycle. This preserves the batching benefit while enabling reactivity.

### Manual User Feedback on Insights

The system is designed to be **fully autonomous** — no manual thumbs-up/down or rating mechanism. The rationale:
- Manual feedback requires user discipline that realistically won't happen for a background memory system
- Autonomous signals (new evidence, source integrity, cluster quality) are more reliable than sporadic human input
- The reactive re-synthesis mechanism (§10.3) handles quality correction automatically when new evidence arrives

If manual feedback is ever needed, the `confidence` field and `supersedes` chain provide the foundation, but the design prioritizes self-correction over human-in-the-loop.

### Consolidation of Insights (Meta-Synthesis)

Insights can theoretically consolidate with other insights (insight-of-insights). This is excluded from the current design to avoid recursive complexity. This can be revisited when the insight corpus grows large enough to warrant it.

### Time-Based Confidence Decay

See §10.5.3 for detailed analysis. Rejected because age alone is not a quality signal — stable knowledge (recipes, places, people) would be unfairly penalized. The reactive re-synthesis mechanism handles genuinely stale knowledge when contradicting evidence arrives.

---

## 11. Implementation Sequence

### Phase 1: Schema & Infrastructure
1. Extend `MemoryTypeEnum` to include `"insight"`
2. Add `TYPE_DIRS.insight = "insights"`
3. Create `$KORE_DATA_PATH/insights/` directory in `ensureKoreDirectories()`
4. Define `InsightFrontmatterSchema` extending `BaseFrontmatterSchema` (including lifecycle fields: `status`, `superseded_by`, `reinforcement_count`, `re_eval_reason`, `last_synthesized_at`)
5. Define `InsightOutputSchema` for LLM output validation
6. Implement `ConsolidationTracker` SQLite table in `kore-queue.db` (§4.6) with seed selection and re-evaluation queries

### Phase 2: Core Loop
7. Implement seed selection via tracker query (not file scanning)
8. Implement candidate finder (QMD search with constructed query)
9. Implement insight type classification (deterministic rules)
10. Implement synthesis LLM call with type-specific prompts (including raw source snippets and temporal context)
11. Implement insight file rendering and writing
12. Implement source frontmatter updates with write-ordering guarantee (insight first, then sources — §7.1)
13. Implement dedup check against existing insights (§4.5) with `superseded_by` backlink
14. Implement concurrency guard (`running` boolean) and failure throttling (`synthesis_attempts`, dead-lettering)

### Phase 3: Insight Lifecycle
15. Implement reactive re-synthesis detection in `onMemoryIndexed` handler (§10.3)
16. Implement source integrity checking in `onMemoryDeleted` handler (§10.4), including manual insight deletion handling (§7.2)
17. Implement dual-queue consolidation loop (re-evaluation queue priority — §10.6)
18. Implement revised confidence model with cluster size, reinforcement, and source integrity factors (§10.5)
19. Handle full lifecycle cycle: `evolving` → re-synthesize → new active insight → retire old → update `superseded_by`
20. Implement startup reconciliation for crash recovery (§7.1)

### Phase 4: Integration
21. Wire consolidation loop + event handlers into startup sequence
22. Populate tracker from `onMemoryIndexed` events (insert `status = 'pending'` for new memories)
23. Add `POST /api/v1/consolidate` endpoint (including `?reset_failed=true` option)
24. Add `kore consolidate` CLI command
25. Filter `status: retired` insights from default search results (§4.5)
26. Verify insight files appear in existing search/list/show commands
27. Verify lifecycle transitions work end-to-end (new evidence, source deletion, failure throttling)

### Phase 5: Tuning
28. Calibrate `minSimilarityScore` against real QMD results
29. Calibrate `relevanceThreshold` for reactive re-synthesis detection
30. Calibrate `cooldownDays` and `intervalMs` for typical usage patterns
31. Test with real memory corpus across different category distributions
32. Verify confidence scores produce meaningful ranking differentiation
33. Verify startup reconciliation correctly heals partial state

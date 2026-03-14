# Consolidation System: Detailed Architecture & Design

_2026-03-14_

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

Consolidation operates exclusively on distilled items and metadata — **not** raw source text (see §5.3). This keeps context small and focused, but it means that if the extraction layer produces poor distilled items, consolidation amplifies the error by synthesizing bad facts into bad insights. The [Design Effectiveness Review](./design_effectiveness_review.md) identifies extraction quality as Weakness #1 and the highest priority improvement. Extraction improvements (intent field, confidence scoring, constrained decoding) should be deployed before or alongside consolidation to ensure source memories have high-quality facts.

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
  intervalMs: number;              // default: 30 minutes
  minClusterSize: number;          // default: 3
  maxClusterSize: number;          // default: 8
  minSimilarityScore: number;      // default: 0.45
  cooldownDays: number;            // default: 7 (don't re-consolidate within 7 days)
}
```

**Loop behavior:**
1. **Select seed.** Scan `$KORE_DATA_PATH` for memories where `consolidated_at` is absent or older than `cooldownDays`. Prioritize by: (a) never consolidated, (b) oldest `consolidated_at`. Skip memories of type `insight`.
2. **Find candidates.** Use QMD hybrid search with the seed's title + distilled items as the query. Filter results to `score >= minSimilarityScore`. Exclude the seed itself and any existing insight files.
3. **Validate cluster.** If `candidates.length + 1 < minClusterSize`, skip this seed (not enough related material yet). Cap at `maxClusterSize` to keep context manageable.
4. **Classify insight type.** Deterministic rules (see §4.3).
5. **Synthesize.** Send the cluster to the LLM with a type-specific prompt. Receive structured output.
6. **Write insight file.** Render as standard Kore markdown, write to `$KORE_DATA_PATH/insights/`.
7. **Update sources.** Add `consolidated_at` and `insight_refs` to each source memory's frontmatter.
8. **Sleep until next interval.**

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
4. The old insight file is not deleted (append-only principle) but will naturally rank lower as the new insight is more recent and comprehensive.

This prevents insight proliferation — the same topic doesn't generate a new insight file every 30 minutes.

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
- Write a synthesis paragraph (3-5 sentences) capturing the combined knowledge.
- List 2-5 key connections between the source memories (which memory relates to which, and how).
- Extract 3-7 distilled items that represent the consolidated facts. Prefer facts that
  appear in multiple sources or that represent the most actionable/distinctive information.
- If any facts contradict each other, explicitly note the contradiction and which memory
  contains each version. In this case, set insight_type to "contradiction".
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
    return [
      `### Memory ${i + 1} (ID: ${m.id})`,
      `- **Title:** ${m.title}`,
      `- **Type:** ${m.type}`,
      `- **Category:** ${m.category}`,
      `- **Date:** ${m.dateSaved}`,
      `- **Tags:** ${m.tags.join(", ")}`,
      `- **Facts:**`,
      ...m.distilledItems.map(item => `  - ${item}`),
    ].join("\n");
  });

  return `Insight type requested: ${insightType}\n\n${memoryBlocks.join("\n\n")}`;
}
```

Note: Only distilled items and metadata are sent — **not** the raw source text. This keeps context small and focused on the extracted knowledge, which is what consolidation operates on.

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
kore consolidate           # Trigger one consolidation cycle manually
kore list --type insight   # Already works with existing --type filter
```

### 8.5 Reset Integration

The existing `DELETE /api/v1/memories` (reset) already deletes all files in `$KORE_DATA_PATH` recursively. Since insights live in `$KORE_DATA_PATH/insights/`, they are automatically included in a full reset.

---

## 9. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| LLM produces bad synthesis | Low-quality insight indexed | Confidence score + `source: kore_synthesis` allows filtering; originals preserved |
| QMD search returns poor candidates | Incoherent cluster | `minSimilarityScore` threshold (0.45) filters weak matches; `minClusterSize` (3) prevents trivial insights |
| Frontmatter update corrupts source file | Data loss | Read-parse-merge-write pattern; could add backup before write if paranoid |
| Consolidation runs before embeddings exist | No vector search results | Schedule after embedder; QMD falls back to BM25 which still finds related content |
| Too many insights generated | Index noise | Dedup check against existing insights with overlapping `source_ids`; cooldown period |
| Model unavailable (Ollama down) | Consolidation silently fails | Log error, skip cycle, retry next interval — same pattern as worker retry logic |

---

## 10. What This Design Intentionally Omits

### Knowledge Graph (Plugin Type B from earlier analysis)

The graph database approach (Neo4j, custom SQLite graph tables) is deferred. The insight file approach solves 80% of the cross-referencing problem with 20% of the complexity. A graph plugin can be built later if the connection insight type proves insufficient — it would consume the same `connections` data from insight files as its seed.

### Real-Time Consolidation

Consolidation is not triggered on every new memory ingestion. This is intentional:
- The embedder needs time to generate vectors for new content
- Immediate consolidation would re-process the same cluster every time a related memory arrives
- The cooldown period ensures clusters have time to accumulate before synthesis

### User Feedback on Insights

V1 has no mechanism for a user to rate or correct insights. This is a future enhancement — the `confidence` field and `supersedes` chain provide the foundation for a feedback loop where low-confidence insights could be flagged for review.

### Consolidation of Insights (Meta-Synthesis)

Insights can theoretically consolidate with other insights (insight-of-insights). V1 excludes insights from seed selection to avoid recursive complexity. This can be revisited when the insight corpus grows large enough to warrant it.

---

## 11. Implementation Sequence

### Phase 1: Schema & Infrastructure
1. Extend `MemoryTypeEnum` to include `"insight"`
2. Add `TYPE_DIRS.insight = "insights"`
3. Create `$KORE_DATA_PATH/insights/` directory in `ensureKoreDirectories()`
4. Define `InsightFrontmatterSchema` extending `BaseFrontmatterSchema`
5. Define `InsightOutputSchema` for LLM output validation

### Phase 2: Core Loop
6. Implement seed selection (scan for unconsolidated memories)
7. Implement candidate finder (QMD search with constructed query)
8. Implement insight type classification (deterministic rules)
9. Implement synthesis LLM call with type-specific prompts
10. Implement insight file rendering and writing
11. Implement source frontmatter updates

### Phase 3: Integration
12. Wire consolidation loop into startup sequence
13. Add `POST /api/v1/consolidate` endpoint
14. Add `kore consolidate` CLI command
15. Verify insight files appear in existing search/list/show commands

### Phase 4: Tuning
16. Calibrate `minSimilarityScore` against real QMD results
17. Calibrate `cooldownDays` and `intervalMs` for typical usage patterns
18. Test with real memory corpus across different category distributions

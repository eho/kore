# Kore MCP Server: Detailed Architecture & Design

_2026-03-17_

This document specifies the design of Kore's native MCP (Model Context Protocol) server — the agent-facing interface to the personal memory system. It defines what tools are exposed, how agents should interact with them, the technical architecture, and how the server relates to QMD's existing MCP server.

---

## 1. Why Kore Needs Its Own MCP Server

### 1.1 The Current State

Kore currently relies on QMD's built-in MCP server for agent access. QMD exposes four tools (`query`, `get`, `multi_get`, `status`) that provide raw document search and retrieval over indexed Markdown files. Agents connect to QMD's MCP server and search the memory corpus directly.

### 1.2 The Problem

QMD is a generic document search engine. It doesn't know about Kore's semantic layer — types, intents, confidence scores, insights, lifecycle states, or the ingestion pipeline. This creates five specific gaps:

**Gap 1: Agents receive raw Markdown, not structured memories.**
When an agent calls QMD's `query` tool, it gets back a Markdown document with YAML frontmatter embedded in the text. The agent must parse YAML to extract `type`, `intent`, `confidence`, `tags`, and `distilled_items`. This wastes tokens, introduces parsing errors, and forces every agent to implement the same extraction logic.

**Gap 2: No write path.**
QMD's MCP server is read-only. Agents cannot save new memories, which means the "bidirectional knowledge flow" from the vision (agents discover and preserve useful information during conversation) is impossible via MCP.

**Gap 3: No structured filtering.**
QMD search is semantic (BM25 + vectors). An agent cannot ask "show me all my aspiration-type travel memories" or "find recommendations with confidence > 0.8". These require structured field queries that QMD's search interface doesn't support.

**Gap 4: Insights are indistinguishable from memories.**
Insight files (type `insight`) are indexed alongside regular memories. An agent searching for "React state management" gets 15 individual notes mixed with 1 synthesized insight, with no way to distinguish them or prefer the insight without parsing frontmatter.

**Gap 5: No lifecycle awareness.**
Retired insights, degraded insights, and failed consolidation states are invisible to agents. QMD returns all indexed documents regardless of lifecycle state, potentially serving outdated or superseded information.

### 1.3 The Solution

A Kore-native MCP server that wraps QMD's search with Kore's semantic layer. QMD remains the retrieval engine; Kore's MCP is the agent-facing interface that provides structured results, write access, and lifecycle awareness.

```
Agent (Claude, Cursor, etc.)
    |
    +--MCP--> Kore MCP Server (agent-facing, semantic)
    |              |
    |              +-- QMD (via @kore/qmd-client) for search/retrieval
    |              +-- Core-API internals for ingestion, memory index, events
    |
    +--MCP--> QMD MCP Server (low-level, still available for power users)
```

Both servers can run simultaneously. Kore's MCP is the recommended interface for AI agents. QMD's MCP remains available for direct document access, debugging, or non-Kore use cases.

---

## 2. Design Principles

### 2.1 Structured Over Raw

Every tool returns structured JSON objects with pre-parsed frontmatter fields. Agents never need to parse YAML or Markdown. This reduces token consumption, eliminates parsing errors, and lets agents reason directly about memory metadata.

### 2.2 Behavior-Encoding Tool Descriptions

Tool descriptions don't just say *what* — they say *when*. Each description includes explicit guidance on when to use the tool proactively versus reactively. This is the primary mechanism for achieving the vision's "without you having to ask" retrieval behavior.

### 2.3 Minimal Tool Count

Fewer tools = better agent decision-making. Each tool has a clear, non-overlapping purpose. Agents shouldn't need to reason about which of 10 tools to use — 6 tools cover all interaction patterns.

### 2.4 QMD as Retrieval Backend, Not Abstraction

Kore's MCP server is not an abstraction layer over QMD's MCP server. It calls QMD's search SDK (`@kore/qmd-client`) directly in-process, then enriches results with Kore metadata from the memory index and frontmatter. No MCP-to-MCP proxying.

### 2.5 No Destructive Operations

Agents are strictly append-only or read-only. There is no `forget`, `delete`, or `update` tool. Deletion must always remain a manual user action via the CLI or UI. AI agents are prone to hallucination, and granting an LLM the ability to autonomously delete or overwrite personal memories is an unacceptable data-loss risk.

---

## 3. Server Architecture

### 3.1 Package Location

The MCP implementation spans two locations — one for shared business logic, one for the standalone stdio proxy:

**Core-api (tool logic + embedded MCP server):**
```
apps/core-api/src/
├── operations/
│   ├── recall.ts            # Shared recall() function
│   ├── remember.ts          # Shared remember() function
│   ├── inspect.ts           # Shared inspect() function
│   ├── insights.ts          # Shared insights() function
│   ├── health.ts            # Shared health() function
│   └── consolidate.ts       # Shared consolidate() function
└── mcp.ts                   # MCP server registration, tool dispatch, HTTP transport (/mcp route)
```

**MCP server package (stdio proxy only):**
```
apps/mcp-server/
├── package.json
├── index.ts                 # Standalone stdio-to-HTTP proxy for Claude Desktop
└── __tests__/
    └── proxy.test.ts
```

The `apps/mcp-server/` package contains no tool implementations. It is only the stdio proxy entry point (§3.6). All business logic lives in `apps/core-api/src/operations/` and is shared by both the MCP tools and the CLI.

**`apps/mcp-server/package.json` dependencies:**
```json
{
  "name": "@kore/mcp-server",
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest"
  }
}
```

### 3.2 Connection to Core Infrastructure

The MCP server needs access to Kore's internals. Two architectural options:

| Option | Description | Verdict |
|--------|-------------|---------|
| A. HTTP client to core-api | MCP server calls `localhost:3000/api/v1/*` | Requires core-api to be running; network hop; auth token management |
| B. Direct import of core modules | MCP server imports `QueueRepository`, `MemoryIndex`, `qmd-client`, etc. directly | No network dependency; same-process access; shares SQLite connections |
| **C. Embedded in core-api process** | MCP server starts alongside the REST API in `core-api/src/index.ts` | Simplest — same process, same deps, no coordination overhead |

**Decision: Option C.** The MCP server runs inside the `core-api` process, started after the REST API. This matches QMD's own pattern (QMD's MCP server is part of the QMD process). The MCP server has direct access to:
- `qmdClient.search()` — QMD hybrid search
- `memoryIndex` — in-memory map of ID → file path
- `queue.enqueue()` — ingestion queue
- `parseMemoryFile()` / `parseMemoryFileFull()` — frontmatter parsing
- `eventDispatcher` — lifecycle events

### 3.3 Transport

The MCP server supports two transports:

**stdio** (primary): For Claude Desktop, Claude Code, and other MCP clients that launch the server as a subprocess. The standalone entry point (`apps/mcp-server/index.ts`) proxies stdio to the embedded HTTP endpoint.

**Streamable HTTP** (secondary): For remote agents or web-based clients. Mounted on the existing core-api server at `/mcp` — no separate port or listener. The full MCP endpoint URL is `http://localhost:3000/mcp`.

This keeps the deployment simple: one process, one port, one address to configure. The `/mcp` route is protected by the same `KORE_API_KEY` bearer token as the REST API (§3.4).

### 3.4 Authentication

- **stdio transport**: No auth needed — the process is launched by the local user.
- **HTTP transport**: Uses the same `KORE_API_KEY` bearer token as the REST API. Consistent with existing security model.

### 3.5 Startup Sequence

When embedded in core-api, the MCP server starts after all core services:

```
Existing:
  1. initLogger()
  2. ensureKoreDirectories()
  3. qmdClient.initStore()
  4. MemoryIndex.build()
  5. createApp()
  6. app.listen(3000)
  7. startWorker()
  8. startWatcher()
  9. startEmbedInterval()
  10. plugins.forEach(p => p.start?.(deps))
  11. startConsolidationLoop()
New:
  12. startMcpServer()          <-- after all services ready
```

### 3.6 Standalone Mode (for Claude Desktop)

For Claude Desktop and Claude Code integration, the MCP server needs a standalone stdio entry point. **This entry point must NOT instantiate its own data stores.** If it did, it would hold a stale `MemoryIndex` (no file watcher), miss memories created by the background worker, and risk SQLite locking conflicts with the running core-api daemon.

**Design: stdio-to-HTTP proxy.** The standalone process is a lightweight bridge that translates MCP JSON-RPC over stdio into HTTP calls to the running core-api daemon:

```typescript
// apps/mcp-server/index.ts (standalone stdio entry point)
const CORE_API_URL = process.env.KORE_API_URL ?? "http://localhost:3000";

// 1. Check if core-api daemon is running
const healthy = await fetch(`${CORE_API_URL}/health`).then(r => r.ok).catch(() => false);
if (!healthy) {
  process.stderr.write("Error: Kore daemon is not running. Start it with `kore start`.\n");
  process.exit(1);
}

// 2. Create MCP server that proxies to the daemon's HTTP MCP endpoint
const server = createKoreMcpProxy({ coreApiUrl: CORE_API_URL });
await server.listen({ transport: "stdio" });
```

This ensures:
- **Single source of truth**: One `MemoryIndex`, one file watcher, one QMD connection (in the daemon)
- **No stale state**: The stdio process has no local caches to go stale
- **No locking conflicts**: Only the daemon touches SQLite

The daemon's embedded MCP server (Option C, §3.2) handles the actual tool execution. The stdio entry point simply bridges the transport.

**Prerequisite**: The core-api daemon must be running before Claude Desktop can use Kore's MCP server. This is consistent with the system's architecture — Kore is a background service, not a stateless CLI tool.

Claude Desktop configuration (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "kore": {
      "command": "bun",
      "args": ["run", "/path/to/kore/apps/mcp-server/index.ts"]
    }
  }
}
```

---

## 4. Tools

### 4.1 `recall` — Search Personal Knowledge

The primary retrieval tool. Wraps QMD hybrid search but returns structured memory objects with pre-parsed metadata.

**Input Schema:**
```typescript
{
  query: string;               // Natural language search query (required)
  type?: string;               // Filter by memory type: "place" | "media" | "note" | "person"
  intent?: string;             // Filter by intent: "recommendation" | "reference" | "personal-experience" | "aspiration" | "how-to"
  tags?: string[];             // Filter to memories containing ALL specified tags
  created_after?: string;      // ISO 8601 date — only return memories saved after this date
  created_before?: string;     // ISO 8601 date — only return memories saved before this date
  limit?: number;              // Max results (default: 10, max: 50)
  offset?: number;             // Skip first N results for pagination (default: 0)
  min_score?: number;          // Minimum QMD relevance score (default: 0.0)
  min_confidence?: number;     // Minimum extraction confidence (default: 0.0)
  include_insights?: boolean;  // Include insight-type results (default: true)
}
```

**Output Schema:**
```typescript
{
  results: Array<{
    id: string;
    title: string;
    type: string;                    // place | media | note | person | insight
    category: string;                // qmd://travel/food/ramen
    intent?: string;                 // recommendation | reference | ...
    confidence?: number;             // 0.0-1.0 extraction confidence
    tags: string[];
    date_saved: string;              // ISO 8601
    source: string;                  // apple_notes | web_clipper | ...
    distilled_items: string[];       // Atomic facts
    score: number;                   // QMD relevance score
    // Insight-specific fields (only when type === "insight")
    insight_type?: string;           // cluster_summary | evolution | contradiction | connection
    source_count?: number;           // Number of source memories
    status?: string;                 // active | evolving | degraded
  }>;
  query: string;                     // Echo of the original query
  total: number;                     // Number of results returned
  offset: number;                    // Current offset
  has_more: boolean;                 // True if more results available beyond this page
}
```

**Implementation:**

```typescript
async function recall(params: RecallInput): Promise<RecallOutput> {
  const limit = params.limit ?? 10;
  const offset = params.offset ?? 0;

  // 1. Search QMD — over-fetch to account for post-filtering and pagination
  const qmdResults = await qmdClient.search(params.query, {
    intent: "personal knowledge retrieval",
    limit: (limit + offset) * 2,
  });

  // 2. Enrich with Kore metadata
  const enriched = await Promise.all(
    qmdResults.map(async (r) => {
      const id = memoryIndex.getIdByPath(r.file);
      if (!id) return null;
      const memory = await parseMemoryFileFull(id, r.file);
      if (!memory) return null;
      return { ...memory, score: r.score, distilled_items: extractDistilledItems(r.file) };
    })
  );

  // 3. Apply Kore-level filters
  let filtered = enriched.filter(Boolean);

  // Filter out retired insights
  filtered = filtered.filter(m => m.type !== "insight" || m.status !== "retired");

  if (params.type) filtered = filtered.filter(m => m.type === params.type);
  if (params.intent) filtered = filtered.filter(m => m.intent === params.intent);
  if (params.tags?.length) filtered = filtered.filter(m => params.tags!.every(t => m.tags.includes(t)));
  if (params.min_confidence) filtered = filtered.filter(m => (m.confidence ?? 0) >= params.min_confidence!);
  if (params.created_after) filtered = filtered.filter(m => m.date_saved >= params.created_after!);
  if (params.created_before) filtered = filtered.filter(m => m.date_saved <= params.created_before!);
  if (!params.include_insights) filtered = filtered.filter(m => m.type !== "insight");

  // 4. Apply pagination
  const results = filtered.slice(offset, offset + limit);

  return { results, query: params.query, total: results.length, offset, has_more: filtered.length > offset + limit };
}
```

### 4.2 `remember` — Save New Memory

Enqueues content for LLM extraction and indexing. Enables agents to capture knowledge discovered during conversation.

**Input Schema:**
```typescript
{
  content: string;             // The raw content to remember (required)
  source?: string;             // Where this came from (default: "agent")
  url?: string;                // Source URL if applicable
  priority?: string;           // "low" | "normal" | "high" (default: "normal")
  suggested_tags?: string[];   // Agent-suggested tags — passed as hints to the extraction pipeline
  suggested_category?: string; // Agent-suggested category (e.g., "travel/food/ramen") — hint, not override
}
```

**Output Schema:**
```typescript
{
  task_id: string;             // Queue task ID for tracking
  status: "queued";
  message: string;             // "Memory queued for extraction"
}
```

**Implementation:**

```typescript
async function remember(params: RememberInput): Promise<RememberOutput> {
  const taskId = queue.enqueue({
    source: params.source ?? "agent",
    content: params.content,
    original_url: params.url,
    // Hints are passed to the extraction pipeline — the LLM extractor uses them
    // as suggestions but makes the final decision on tags and category
    suggested_tags: params.suggested_tags,
    suggested_category: params.suggested_category,
  }, params.priority as any ?? "normal");

  return {
    task_id: taskId,
    status: "queued",
    message: "Memory queued for extraction. It will be searchable once processing completes.",
  };
}
```

### 4.3 `inspect` — Get Full Memory Details

Retrieves complete details of a specific memory by ID, including all metadata, distilled items, and raw source content.

**Input Schema:**
```typescript
{
  id: string;                  // Memory UUID (required)
}
```

**Output Schema:**
```typescript
{
  id: string;
  title: string;
  type: string;
  category: string;
  intent?: string;
  confidence?: number;
  tags: string[];
  date_saved: string;
  date_created?: string;
  date_modified?: string;
  source: string;
  url?: string;
  distilled_items: string[];
  content: string;            // Full Kore Markdown file content (frontmatter + distilled items + original source)
  // Consolidation metadata
  consolidated_at?: string;
  insight_refs?: string[];
  // Insight-specific fields
  insight_type?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  status?: string;
  reinforcement_count?: number;
}
```

**Implementation:** Reads the memory file from disk via `memoryIndex.get(id)`, parses frontmatter and body sections, returns the full structured representation. The `distilled_items` field is parsed from the `## Distilled Memory Items` section in the Markdown body (bulleted list items). The `content` field is the full raw file content as read from disk. The shared `inspect()` operation in `apps/core-api/src/operations/inspect.ts` implements this body parsing; the same logic is reused by `recall`'s `extractDistilledItems()` helper.

### 4.4 `insights` — Query Synthesized Knowledge

Searches specifically in the insight layer — synthesized documents that capture higher-order knowledge from multiple memories.

**Input Schema:**
```typescript
{
  query?: string;              // Semantic search query (optional — if omitted, lists recent insights)
  insight_type?: string;       // Filter: "cluster_summary" | "evolution" | "contradiction" | "connection"
  status?: string;             // Filter: "active" | "evolving" | "degraded" (default: "active")
  limit?: number;              // Max results (default: 5, max: 20)
}
```

**Output Schema:**
```typescript
{
  results: Array<{
    id: string;
    title: string;
    insight_type: string;
    confidence: number;
    status: string;
    source_ids: string[];
    source_count: number;
    synthesis: string;           // The synthesis paragraph
    distilled_items: string[];   // Consolidated facts
    tags: string[];
    date_saved: string;
    last_synthesized_at?: string;
    reinforcement_count: number;
    supersedes?: string[];
  }>;
  total: number;
}
```

**Implementation:**

When `query` is provided: search QMD with the query, filter results to `type === "insight"` and the requested `status` (default: active only). When `query` is omitted: scan insight files in `$KORE_DATA_PATH/insights/`, parse frontmatter, filter by requested criteria, return sorted by `last_synthesized_at` descending.

### 4.5 `health` — System Health

Returns the current state of the Kore system — memory counts, queue status, sync state, and index health. Supersedes the previous `kore health` (basic API ping) by incorporating memory counts and index state into one unified view.

**Input Schema:**
```typescript
{}  // No parameters
```

**Output Schema:**
```typescript
{
  memories: {
    total: number;
    by_type: Record<string, number>;   // { note: 120, place: 45, media: 30, person: 12, insight: 8 }
  };
  queue: {
    pending: number;
    processing: number;
    failed: number;
  };
  index: {
    documents: number;
    embedded: number;
    status: string;                    // "ok" | "embedding" | "unavailable"
  };
  sync?: {
    apple_notes: {
      enabled: boolean;
      last_sync_at?: string;
      total_tracked: number;
    };
  };
}
```

### 4.6 `consolidate` — Trigger Knowledge Synthesis

Triggers an immediate consolidation cycle. Supports dry-run mode for previewing what would be synthesized.

**Input Schema:**
```typescript
{
  dry_run?: boolean;           // Preview only, don't write insight files (default: false)
  no_wait?: boolean;           // Return immediately after triggering; don't wait for cycle to complete (default: false)
}
```

**Output Schema:**
```typescript
// When dry_run is false and no_wait is false (default): blocks until cycle completes
// The API awaits runConsolidationCycle() synchronously, so this returns the full result:
{
  status: "consolidated" | "no_seed" | "cluster_too_small";
  seed?: { id: string; title: string };
  insight_id?: string;
  cluster_size?: number;
  message?: string;
}

// When no_wait is true: fires cycle in background, returns immediately
{
  status: "triggered";
  message: string;
}

// When dry_run is true:
{
  status: "dry_run";
  seed?: {
    id: string;
    title: string;
  };
  candidates?: Array<{
    id: string;
    title: string;
    score: number;
  }>;
  proposed_type?: string;        // cluster_summary | evolution | connection
  estimated_confidence?: number;
  message: string;               // "No eligible seeds found" if nothing to consolidate
}
```

---

## 5. Tool Descriptions (Agent-Facing)

These descriptions are the primary mechanism for guiding agent behavior. They are embedded in the MCP server and sent to agents during tool discovery. Each description answers three questions: what does this tool do, when should you use it, and when should you not use it.

### 5.1 `recall`

```
Search the user's personal knowledge base — saved bookmarks, notes, recommendations,
experiences, and synthesized insights. Returns structured results with metadata
(type, intent, confidence, tags) so you can reason about the nature of each memory.

WHEN TO USE:
- Before answering questions that could benefit from the user's personal context.
  Topics include: restaurants, travel, recipes, books, movies, people, places,
  projects, technical preferences, health, hobbies, learning resources, or any
  subject where the user might have saved relevant information in the past.
- The user often forgets what they've saved. Proactively checking is more helpful
  than waiting to be asked. If the conversation topic MIGHT have personal context,
  check.
- Use the intent filter to narrow results: "recommendation" for suggestions others
  gave the user, "aspiration" for things the user wants to try, "how-to" for
  instructions and procedures.
- Use created_after/created_before for time-based queries: "restaurants saved
  last month", "articles from 2024", "recent bookmarks".
- Use offset for pagination when you need more results than a single page.

WHEN NOT TO USE:
- General knowledge questions with no personal angle ("what is photosynthesis")
- Pure code generation or debugging tasks with no personal context
- When the user has explicitly said they don't want memory lookup

RESULT INTERPRETATION:
- score: How relevant this result is to your query (from the search engine)
- confidence: How reliably the memory was extracted from the original source
- type "insight": A synthesized document combining multiple memories — prefer
  these when the user wants a summary rather than individual saved items
```

### 5.2 `remember`

```
Save noteworthy information to the user's personal knowledge base. The content
will be processed by an LLM to extract key facts, categorize it, and make it
searchable for future recall.

WHEN TO USE:
- When the conversation produces information the user would want to recall later:
  a restaurant recommendation discovered, a useful technique explained, a decision
  made, a resource found, a preference expressed.
- When the user explicitly says "remember this", "save this", "note this down".

IMPORTANT:
- Ask the user for confirmation before saving, unless they've told you to save
  freely. Example: "This looks like a useful resource — would you like me to save
  it to your memory?"
- Include enough context in the content for the extraction to produce good results.
  Don't just save "Mutekiya" — save "Mutekiya Ramen in Ikebukuro, Tokyo —
  recommended by John for solo dining, known for rich 48-hour pork bone broth."
- The saved content goes through LLM extraction, so raw/messy text is fine.
- Use suggested_tags and suggested_category when you have strong context about
  the content's domain. These are hints — the extraction pipeline may refine them,
  but your suggestions improve extraction accuracy.
```

### 5.3 `inspect`

```
Get the complete details of a specific memory by its ID. Returns all metadata,
distilled facts, raw source content, and consolidation state.

WHEN TO USE:
- After recall returns results and you need deeper detail on a specific item
  (e.g., the full raw source text, or which insights reference this memory).
- When you need to verify the quality of a memory (check its confidence score,
  see the original source text vs. the extracted facts).
- When exploring the consolidation graph (follow insight_refs or source_ids).
```

### 5.4 `insights`

```
Query the synthesized knowledge layer — higher-order documents that connect and
consolidate multiple individual memories on the same topic. Insights capture
the user's evolved understanding, cross-domain connections, and consolidated
reference material.

WHEN TO USE:
- When the user asks about their "current view", "overall understanding", or
  "what do I know about" a topic — insights provide the synthesized answer.
- When recall returns many fragmented results on the same topic (5+ results
  about sourdough baking) — check insights for a consolidated version first.
- When the user asks about how their thinking has changed over time — use
  insight_type "evolution".
- When you want to understand connections across different areas of the user's
  knowledge — use insight_type "connection".

RESULT INTERPRETATION:
- synthesis: A 3-5 sentence summary combining knowledge from multiple memories
- source_ids: The individual memories this insight was built from
- reinforcement_count: How many times new evidence has updated this insight
  (higher = more actively confirmed knowledge)
- status "evolving": This insight is being updated with new evidence
```

### 5.5 `health`

```
Check Kore system health — memory counts by type, ingestion queue status,
search index state, and sync status.

WHEN TO USE:
- When the user asks about their memory system ("how many memories do I have?",
  "is Kore running?")
- When diagnosing unexpected search results (check if the index is still
  embedding, or if the queue has failed tasks)
```

### 5.6 `consolidate`

```
Trigger knowledge synthesis — clusters related memories and produces insight
documents that capture higher-order understanding.

WHEN TO USE:
- When recall returns many fragmented results on a topic and no insight exists
  yet. Offer: "You have 8 separate notes about sourdough. Would you like me to
  synthesize them into a consolidated reference?"
- When the user explicitly asks to consolidate or synthesize their knowledge.
- Use dry_run=true first to preview what would be synthesized before committing.

NOTE: Consolidation runs automatically in the background every 30 minutes.
This tool is for on-demand synthesis when the user wants it now.
```

---

## 6. Server Instructions

The MCP specification supports a server-level `instructions` field — a block of text sent to agents when they connect. This establishes the overall interaction pattern beyond individual tool descriptions.

```
You have access to the user's personal knowledge base through Kore. This system
contains bookmarks, notes, recommendations, experiences, and synthesized insights
the user has saved over time — often months or years ago.

The user frequently forgets what they've saved. Your role is to bridge the gap
between saved knowledge and active recall.

Interaction patterns:

1. PROACTIVE RECALL: When the user discusses a topic that could involve personal
   context (travel, food, projects, preferences, people, places), call `recall`
   BEFORE composing your response. Weave relevant memories into your answer
   naturally — don't list them mechanically.

2. PREFER INSIGHTS: When recall returns many results on the same topic, check
   `insights` for a synthesized view. Present the insight's synthesis rather
   than listing individual memories, unless the user wants specifics.

3. OFFER TO REMEMBER: When the conversation produces valuable information the
   user might want later, offer to save it. Don't save silently.

4. NEVER FABRICATE: If recall returns nothing relevant, say so. Don't guess
   what the user might have saved. "I don't see anything in your saved memories
   about that" is a perfectly good response.

5. RESPECT CONFIDENCE: When a memory has low confidence (< 0.5), mention that
   the extraction may be imperfect: "I found a note about this, though the
   details might not be fully accurate."
```

---

## 7. Relationship to QMD's MCP Server

### 7.1 Coexistence

Both servers can run simultaneously. They serve different audiences:

| Aspect | QMD MCP Server | Kore MCP Server |
|--------|---------------|-----------------|
| **Audience** | Power users, non-Kore apps, debugging | AI agents interacting with Kore |
| **Returns** | Raw Markdown documents | Structured JSON objects |
| **Write access** | No | Yes (`remember`) |
| **Lifecycle awareness** | No | Yes (filters retired insights, exposes health state) |
| **Consolidation** | No | Yes (`insights`, `consolidate`) |
| **Tool descriptions** | Generic ("search documents") | Behavior-encoding ("check before answering travel questions") |

### 7.2 When to Use QMD's MCP Directly

- Direct document retrieval by file path (e.g., Obsidian integration)
- Searching non-Kore collections indexed by QMD
- Debugging QMD search behavior (raw scores, query expansion)
- Applications that don't need Kore's semantic layer

### 7.3 Migration Path

For users currently using QMD's MCP server with Kore, the migration is:
1. Update Claude Desktop config to point to Kore's MCP server instead of QMD's
2. All existing QMD search functionality is preserved (Kore's `recall` uses QMD under the hood)
3. New capabilities (structured results, `remember`, `insights`) are immediately available

---

## 8. Configuration

```bash
# Enable/disable MCP server (default: true when core-api starts)
KORE_MCP_ENABLED=true

# HTTP transport route on core-api (default: /mcp; set to empty string to disable HTTP transport)
KORE_MCP_PATH=/mcp

# Default recall limit (default: 10)
KORE_MCP_DEFAULT_RECALL_LIMIT=10

# Minimum score for recall results (default: 0.0 — let QMD's own scoring handle relevance)
KORE_MCP_MIN_SCORE=0.0
```

---

## 9. Error Handling

All tool errors return structured MCP error responses:

```typescript
{
  isError: true,
  content: [{
    type: "text",
    text: "Error: <human-readable message>"
  }]
}
```

| Error Scenario | Tool | Response |
|---------------|------|----------|
| QMD index not available | `recall`, `insights` | "Search index is not available. The system may still be starting up." |
| Memory not found | `inspect` | "Memory with ID {id} was not found." |
| Empty query | `recall` | "A search query is required." |
| Queue not available | `remember` | "The ingestion queue is not available." |
| Consolidation not ready | `consolidate` | "The consolidation system is not available." |

---

## 10. Testing Strategy

### 10.1 Unit Tests (per tool)

Each tool has unit tests with mocked dependencies (`qmdClient`, `memoryIndex`, `queue`):

- `recall`: query passthrough, structured result enrichment, type/intent/tag filtering, retired insight exclusion, confidence filtering
- `remember`: enqueue with default source, custom source/url/priority, empty content rejection
- `inspect`: found memory returns full structure, not-found returns error
- `insights`: query-based search, no-query listing, type/status filtering
- `health`: aggregates counts from memory index and queue
- `consolidate`: dry-run returns preview, non-dry-run triggers cycle

### 10.2 Integration Tests

- Connect an MCP client to the server over stdio, call each tool, verify response structure
- Verify `remember` → `recall` round-trip: save content, wait for extraction, search for it
- Verify `recall` filters: create memories with different types/intents, verify filtering works

### 10.3 Description Tests

- Verify each tool description contains "WHEN TO USE" section
- Verify server instructions are non-empty and contain key behavioral patterns

---

## 11. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| QMD index not ready at startup | `recall` and `insights` return errors | Graceful error message; retry on next call |
| Slow QMD search (>2s) | Agent timeout; user perceives latency | QMD search is typically <200ms; log warnings for slow queries |
| Frontmatter parse failure | Missing metadata in `recall` results | Return partial results with available fields; don't fail the entire search |
| Queue full or unavailable | `remember` fails | Return clear error; agent can inform user and retry |
| File deleted between search and inspect | `inspect` returns not-found | Normal — file was deleted; return not-found error |
| Core-api daemon not running (stdio mode) | All tools fail | stdio proxy checks health on startup; exits with clear error message instructing user to run `kore start` |
| Core-api daemon crashes while stdio proxy is connected | Tools fail mid-session | stdio proxy returns connection error; agent sees "Kore daemon is unavailable" |

---

## 12. CLI Alignment

### 12.1 Motivation

There is an emerging pattern where agents (Claude Code, OpenClaw, etc.) interact with tools via CLI + agent skills rather than MCP. OpenClaw already uses QMD's CLI directly instead of QMD's MCP server. To support both interaction modes without divergence, Kore's CLI commands and MCP tools must share the same underlying implementation.

### 12.2 Shared Implementation Principle

CLI commands and MCP tools are thin wrappers around the same core functions. Neither implements business logic directly:

```
CLI command  ──┐
               ├──> core function (shared) ──> result object
MCP tool     ──┘
                        │
              ┌─────────┼──────────┐
              ▼                    ▼
     CLI: format for terminal   MCP: wrap as MCP response
     (table/text or --json)     (content: [{ type: "text", text: JSON }])
```

Each core function lives in a shared module (e.g., `apps/core-api/src/operations/`) and returns a typed result object. The CLI and MCP layers are responsible only for argument parsing and output formatting.

### 12.3 CLI ↔ MCP Mapping

| MCP Tool | CLI Command | Current Status | Changes Needed |
|----------|-------------|----------------|----------------|
| `recall` | `kore search` | Exists but limited | Add `--type`, `--intent`, `--tags`, `--min-confidence`, `--min-score`, `--include-insights`, `--created-after`, `--created-before`, `--offset` flags; add `--json` output |
| `remember` | `kore ingest` | Exists | Add `--json` output |
| `inspect` | `kore show <id>` | Exists | Add `--json` output with full structured metadata |
| `insights` | `kore insights` | **New** | New command: `kore insights [query] [--type] [--status] [--limit] [--json]` |
| `health` | `kore health` | Exists but limited | Extend to include memory counts, index state, sync state; add `--json` output. Replaces `kore health` (basic API ping) and absorbs `kore sync --status` |
| `consolidate` | `kore consolidate` | Exists (basic) | Add `--dry-run`, `--json` flags |

**Renamed CLI command:** `kore status <task-id>` → `kore task <id>`. The old `kore status` checked a single ingestion task; this is now `kore task <id>`. The top-level `kore status` is retired — use `kore health` for system state and `kore task <id>` for task state.

### 12.4 New & Enhanced CLI Commands

**`kore search` (enhanced):**
```bash
# Current
kore search "best ramen in tokyo"

# Enhanced — matches recall's full filtering capability
kore search "best ramen in tokyo" --type place --intent recommendation --tags japanese,noodles --min-confidence 0.7 --limit 5
kore search "saved restaurants" --created-after 2026-02-01 --created-before 2026-03-01
kore search "tokyo places" --limit 10 --offset 10   # page 2
kore search "best ramen in tokyo" --json   # structured output matching recall's schema
```

**`kore insights` (new):**
```bash
kore insights                                   # list recent active insights
kore insights "sourdough baking"                # semantic search within insights
kore insights --type evolution --status active   # filtered listing
kore insights --json                            # structured output matching insights tool schema
```

**`kore health` (extended, replaces fragmented commands):**
```bash
kore health           # human-readable summary: API status, memory counts, queue, index, sync
kore health --json    # structured output matching health tool schema
# Replaces: kore health (basic ping), kore sync --status (sync state)
```

**`kore task <id>` (renamed from `kore status <task-id>`):**
```bash
kore task abc123      # check status of a specific ingestion task
kore task abc123 --json
```

**`kore consolidate` (enhanced):**
```bash
kore consolidate              # trigger immediate consolidation cycle
kore consolidate --dry-run    # preview what would be synthesized
kore consolidate --json       # structured output matching consolidate tool schema
```

### 12.5 The `--json` Convention

Every CLI command supports a `--json` flag that:
- Outputs the same structured JSON object as the corresponding MCP tool
- Prints a single JSON object to stdout (no extra formatting, no color codes)
- Exits with code 0 on success, non-zero on error (with JSON error object on stderr)
- Enables agents using the CLI to get identical data to agents using MCP

```typescript
// Example: shared core function
// apps/core-api/src/operations/recall.ts
export async function recall(params: RecallInput): Promise<RecallOutput> {
  // All business logic here — QMD search, enrichment, filtering
  // Both CLI and MCP call this
}

// CLI wrapper (apps/cli/src/commands/search.ts)
if (flags.json) {
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  formatRecallForTerminal(result);  // colored, human-readable
}

// MCP wrapper (apps/core-api/src/mcp.ts — tool registration)
return {
  content: [{ type: "text", text: JSON.stringify(result) }]
};
```

### 12.6 Implementation Approach

The shared core functions will be extracted during MCP implementation (Phase 1 of §13). The sequence:

1. Extract business logic from existing CLI commands into `apps/core-api/src/operations/`
2. Refactor CLI commands to call shared functions
3. Build MCP tools as thin wrappers around the same functions
4. Add `--json` flag and new filter flags to CLI commands
5. Add new CLI commands (`kore insights`); extend `kore health`; rename `kore status <id>` to `kore task <id>`

This ensures CLI and MCP never diverge — a bug fix or feature addition in the core function benefits both interfaces automatically.

---

## 13. Future Considerations

### 13.1 MCP Resources

The MCP spec supports `resources` — URI-addressable content the agent can read. Kore could expose `kore://memory/{id}` resources for direct memory access alongside tools. Deferred until agent support for MCP resources matures.

### 13.2 MCP Prompts

The MCP spec supports `prompts` — predefined prompt templates agents can invoke. Kore could offer prompts like "summarize my knowledge about {topic}" or "plan a trip using my saved places." Deferred until the tool layer is proven.

### 13.3 Streaming

For large `recall` result sets or long `consolidate` dry-run outputs, streaming responses would improve perceived latency. The MCP SDK supports streaming; this can be added once the basic tools are stable.

### 13.4 Agent-Specific Calibration

Different agents (Claude, GPT, Cursor) may interpret tool descriptions differently. Monitoring which tools agents call (and when) will inform description refinement. A simple log of `tool_name + query + agent_id` per call would enable this analysis.

---

## 14. Implementation Sequence

### Phase 1: Core Tools + Shared Operations
1. Create `apps/core-api/src/operations/` module with shared core functions
2. Extract business logic from existing CLI commands (`search`, `show`, `ingest`) into shared operations
3. Add `@modelcontextprotocol/sdk` dependency
4. Implement MCP server skeleton with stdio transport in `apps/mcp-server/`
5. Implement `recall` tool wrapping shared `recall()` operation
6. Implement `remember` tool wrapping shared `remember()` operation
7. Implement `inspect` tool wrapping shared `inspect()` operation
8. Implement `health` tool wrapping shared `health()` operation
9. Write tool descriptions (§5)
10. Write server instructions (§6)
11. Unit tests for all tools and shared operations

### Phase 2: CLI Alignment
12. Add `--json` flag to `kore search`, `kore show`, `kore ingest`
13. Add structured filter flags to `kore search` (`--type`, `--intent`, `--tags`, `--min-confidence`, `--min-score`, `--include-insights`)
14. Implement `kore insights` command wrapping shared `insights()` operation
15. Extend `kore health` with memory counts, index state, sync state (replacing fragmented `kore health` + `kore sync --status`); add `--json` output
16. Rename `kore status <task-id>` → `kore task <id>`
17. Refactor existing CLI commands to call shared operations

### Phase 3: Insight Tools (consolidation system is complete)
18. Implement `insights` MCP tool (insight search/listing)
19. Implement `consolidate` MCP tool (trigger synthesis)
20. Enhance `kore consolidate` CLI command with `--dry-run` and `--json` flags
21. Update `recall` to include insight-specific fields and retired insight filtering

### Phase 4: Integration
22. Wire MCP server startup into core-api process (`startMcpServer()` in `index.ts`)
23. Mount `/mcp` HTTP route on core-api's existing Bun.serve() instance
24. Add standalone stdio proxy entry point (`apps/mcp-server/index.ts`) for Claude Desktop
25. Add `KORE_MCP_*` env vars to `.env.example`
26. Integration tests (MCP client → server round-trip)
27. Document Claude Desktop configuration

### Phase 5: Refinement
27. Monitor agent tool usage patterns
28. Refine tool descriptions based on observed behavior
29. Calibrate default limits and thresholds

---

## Appendix A: Review Feedback Log

### Incorporated

| # | Feedback | What Changed |
|---|----------|--------------|
| 1 | Standalone mode creates stale state + SQLite locking risk | §3.6 rewritten: stdio entry point is now a lightweight HTTP proxy to the running daemon, not a standalone process with its own data stores |
| 2 | Missing temporal filtering in `recall` | Added `created_after` and `created_before` (ISO 8601) to `recall` input schema (§4.1), implementation, and tool description (§5.1) |
| 3 | Missing pagination in `recall` | Added `offset` to `recall` input schema (§4.1), `offset` + `has_more` to output schema, updated implementation with pagination logic |
| 4 | `remember` lacks agent-assisted extraction hints | Added `suggested_tags` and `suggested_category` to `remember` input schema (§4.2) as hints to the extraction pipeline; updated tool description (§5.2) |
| 6 | No explicit ban on destructive tools | Added §2.5 "No Destructive Operations" as a core design principle |
| 7 | `apps/mcp-server/` package vs. embedded core-api ambiguous | §3.1 rewritten: tool logic lives in `apps/core-api/src/operations/`; `apps/mcp-server/` is solely the stdio proxy; MCP server registration lives in `apps/core-api/src/mcp.ts` |
| 8 | HTTP transport on separate port 3001 unnecessary | §3.3 updated: HTTP transport mounted as `/mcp` route on existing port 3000; no second listener needed |
| 9 | `kore status` naming collision with existing task-status command | §12.3, §12.4 updated: `kore status <task-id>` renamed to `kore task <id>`; system health unified into `kore health`; MCP `status` tool renamed to `health` |
| 10 | `raw_source` field name misleading in `inspect` output | Renamed to `content` (§4.3) — reflects that the full file content is returned, which is the purpose of `inspect` |
| 11 | `distilled_items` parsing undefined | §4.3 implementation note added: parsed from `## Distilled Memory Items` Markdown section; shared `extractDistilledItems()` helper reused by both `inspect` and `recall` |
| 12 | Phase 3 blocked by consolidation system | Prerequisite lifted — consolidation system is complete; phases restructured accordingly |

### Assessed and Not Incorporated

| # | Feedback | Rationale |
|---|----------|-----------|
| 5 | `append_to_id` for amending existing memories | Architecturally complex — appending raw text to structured YAML+Markdown files risks frontmatter corruption. The extraction pipeline expects raw input, not pre-enriched files. The consolidation system (reactive re-synthesis, insight evolution) is specifically designed to merge related knowledge over time — that is the correct mechanism. Adding `append_to_id` creates a competing merge path with different semantics. Revisit if consolidation proves insufficient for real-time knowledge updates. |

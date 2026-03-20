import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  recall,
  remember,
  inspect,
  insights,
  health,
  consolidate,
} from "./operations";
import type { OperationDeps } from "./operations";

// ─── Tool Descriptions (§5 of design doc) ──────────────────────────

const RECALL_DESCRIPTION = `Search the user's personal knowledge base — saved bookmarks, notes, recommendations,
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
- query is optional. For purely metadata-based browsing (e.g., "show me all
  my aspirations" or "list recent places"), omit query entirely and use the
  type/intent/created_after filters — results are sorted by date_saved
  descending. Only pass a semantic query when content relevance matters.

WHEN NOT TO USE:
- General knowledge questions with no personal angle ("what is photosynthesis")
- Pure code generation or debugging tasks with no personal context
- When the user has explicitly said they don't want memory lookup

IF RESULTS ARE EMPTY OR SPARSE:
- Try broadening your search terms or removing specific filters before
  concluding nothing exists. A query for "tonkotsu ramen tokyo" that returns
  nothing might still return results for "ramen tokyo" or "ramen".
- Try omitting intent/tag filters to widen the match set, then narrow manually.

RESULT INTERPRETATION:
- score: How relevant this result is to your query (from the search engine)
- confidence: How reliably the memory was extracted from the original source
- type "insight": A synthesized document combining multiple memories — prefer
  these when the user wants a summary rather than individual saved items`;

const REMEMBER_DESCRIPTION = `Save noteworthy information to the user's personal knowledge base. The content
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
  but your suggestions improve extraction accuracy.`;

const INSPECT_DESCRIPTION = `Get the complete details of a specific memory by its ID. Returns all metadata,
distilled facts, raw source content, and consolidation state.

WHEN TO USE:
- After recall returns results and you need deeper detail on a specific item
  (e.g., the full raw source text, or which insights reference this memory).
- When you need to verify the quality of a memory (check its confidence score,
  see the original source text vs. the extracted facts).
- When exploring the consolidation graph (follow insight_refs or source_ids).`;

const INSIGHTS_DESCRIPTION = `Query the synthesized knowledge layer — higher-order documents that connect and
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
- status "evolving": This insight is being updated with new evidence`;

const HEALTH_DESCRIPTION = `Check Kore system health — memory counts by type, ingestion queue status,
search index state, and sync status.

WHEN TO USE:
- When the user asks about their memory system ("how many memories do I have?",
  "is Kore running?")
- When diagnosing unexpected search results (check if the index is still
  embedding, or if the queue has failed tasks)`;

const CONSOLIDATE_DESCRIPTION = `Trigger knowledge synthesis — clusters related memories and produces insight
documents that capture higher-order understanding.

WHEN TO USE:
- When recall returns many fragmented results on a topic and no insight exists
  yet. Offer: "You have 8 separate notes about sourdough. Would you like me to
  synthesize them into a consolidated reference?"
- When the user explicitly asks to consolidate or synthesize their knowledge.
- Use dry_run=true first to preview what would be synthesized before committing.

NOTE: Consolidation runs automatically in the background every 30 minutes.
This tool is for on-demand synthesis when the user wants it now. The call
blocks until the cycle completes (typically <5s) and returns the result.

RESULT INTERPRETATION:
- "consolidated": synthesis succeeded — insightId contains the new insight's ID
- "no_seed": nothing ready to consolidate yet; more memories needed
- "cluster_too_small": a candidate seed exists but lacks related memories yet
- "retired_reeval" / "synthesis_failed": transient failure; suggest trying again
- dry_run "no_seed": no candidates at all — the knowledge base may be too sparse`;

// ─── Server Instructions (§6 of design doc) ────────────────────────

const SERVER_INSTRUCTIONS = `You have access to the user's personal knowledge base through Kore. This system
contains bookmarks, notes, recommendations, experiences, and synthesized insights
the user has saved over time — often months or years ago.

The user frequently forgets what they've saved. Your role is to bridge the gap
between saved knowledge and active recall.

Interaction patterns:

1. PROACTIVE RECALL: When the user discusses a topic that could involve personal
   context (travel, food, projects, preferences, people, places), call \`recall\`
   BEFORE composing your response. Weave relevant memories into your answer
   naturally — don't list them mechanically.

2. PREFER INSIGHTS: When recall returns many results on the same topic, check
   \`insights\` for a synthesized view. Present the insight's synthesis rather
   than listing individual memories, unless the user wants specifics.

3. OFFER TO REMEMBER: When the conversation produces valuable information the
   user might want later, offer to save it. Don't save silently.

4. NEVER FABRICATE: If recall returns nothing relevant, say so. Don't guess
   what the user might have saved. "I don't see anything in your saved memories
   about that" is a perfectly good response.

5. RESPECT CONFIDENCE: When a memory has low confidence (< 0.5), mention that
   the extraction may be imperfect: "I found a note about this, though the
   details might not be fully accurate."`;

// ─── Error Helpers ──────────────────────────────────────────────────

function mcpError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

function mcpSuccess(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// ─── MCP Server Creation ────────────────────────────────────────────

// NOTE: We use `as any` for the Zod schema objects and explicitly type the callback
// arguments as `args: any` when registering tools with `server.tool()`.
// This is necessary because the MCP SDK uses extremely deep generic type inference
// to map Zod schemas to handler arguments. Passing complex Zod objects inline causes
// the TypeScript compiler to enter an infinite inference loop and crash with an Out of Memory (OOM) error.
export function createMcpServer(deps: OperationDeps) {
  const server = new McpServer(
    { name: "kore", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // ── recall ────────────────────────────────────────────────────────
  server.tool(
    "recall",
    RECALL_DESCRIPTION,
    {
      query: z.string().optional().describe("Natural language search query (optional — if omitted, returns recent memories sorted by date_saved descending)"),
      type: z.string().optional().describe('Filter by memory type: "place" | "media" | "note" | "person"'),
      intent: z.string().optional().describe('Filter by intent: "recommendation" | "reference" | "personal-experience" | "aspiration" | "how-to"'),
      tags: z.array(z.string()).optional().describe("Filter to memories containing ALL specified tags"),
      created_after: z.string().optional().describe("ISO 8601 date — only return memories saved after this date"),
      created_before: z.string().optional().describe("ISO 8601 date — only return memories saved before this date"),
      limit: z.number().optional().describe("Max results (default: 10, max: 50)"),
      offset: z.number().optional().describe("Skip first N results for pagination (default: 0)"),
      min_score: z.number().optional().describe("Minimum QMD relevance score (default: 0.0)"),
      min_confidence: z.number().optional().describe("Minimum extraction confidence (default: 0.0)"),
      include_insights: z.boolean().optional().describe("Include insight-type results (default: true)"),
    } as any,
    async (args: any) => {
      try {
        const result = await recall(args, deps);
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not available") || message.includes("unavailable")) {
          return mcpError("Search index is not available. The system may still be starting up.");
        }
        return mcpError(message);
      }
    }
  );

  // ── remember ──────────────────────────────────────────────────────
  server.tool(
    "remember",
    REMEMBER_DESCRIPTION,
    {
      content: z.string().describe("The raw content to remember (required)"),
      source: z.string().optional().describe('Where this came from (default: "agent")'),
      url: z.string().optional().describe("Source URL if applicable"),
      priority: z.string().optional().describe('"low" | "normal" | "high" (default: "normal")'),
      suggested_tags: z.array(z.string()).optional().describe("Agent-suggested tags — passed as hints to the extraction pipeline"),
      suggested_category: z.string().optional().describe('Agent-suggested category (e.g., "travel/food/ramen") — hint, not override'),
    } as any,
    async (args: any) => {
      try {
        const result = await remember(
          { ...args, priority: (args.priority as "low" | "normal" | "high") ?? "normal" },
          deps
        );
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mcpError("The ingestion queue is not available.");
      }
    }
  );

  // ── inspect ───────────────────────────────────────────────────────
  server.tool(
    "inspect",
    INSPECT_DESCRIPTION,
    {
      id: z.string().describe("Memory UUID (required)"),
    } as any,
    async (args: any) => {
      try {
        const result = await inspect(args.id, deps);
        if (!result) {
          return mcpError(`Memory with ID ${args.id} was not found.`);
        }
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mcpError(message);
      }
    }
  );

  // ── insights ──────────────────────────────────────────────────────
  server.tool(
    "insights",
    INSIGHTS_DESCRIPTION,
    {
      query: z.string().optional().describe("Semantic search query (optional — if omitted, lists recent insights)"),
      insight_type: z.string().optional().describe('Filter: "cluster_summary" | "evolution" | "contradiction" | "connection"'),
      status: z.string().optional().describe('Filter: "active" | "evolving" | "degraded" (default: "active")'),
      limit: z.number().optional().describe("Max results (default: 5, max: 20)"),
    } as any,
    async (args: any) => {
      try {
        const result = await insights(args, deps);
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not available") || message.includes("unavailable")) {
          return mcpError("Search index is not available. The system may still be starting up.");
        }
        return mcpError(message);
      }
    }
  );

  // ── health ────────────────────────────────────────────────────────
  server.tool(
    "health",
    HEALTH_DESCRIPTION,
    {},
    async () => {
      try {
        const result = await health(deps);
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return mcpError(message);
      }
    }
  );

  // ── consolidate ───────────────────────────────────────────────────
  server.tool(
    "consolidate",
    CONSOLIDATE_DESCRIPTION,
    {
      dry_run: z.boolean().optional().describe("Preview only, don't write insight files (default: false)"),
    } as any,
    async (args: any) => {
      try {
        const result = await consolidate(args, deps);
        return mcpSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not available")) {
          return mcpError("The consolidation system is not available.");
        }
        return mcpError(message);
      }
    }
  );

  return server;
}

// ─── Session Management + Request Handler ────────────────────────────

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Creates an MCP request handler that manages sessions and routes requests
 * to the appropriate transport. Each session gets its own McpServer + transport pair.
 */
export function createMcpRequestHandler(deps: OperationDeps) {
  const sessions = new Map<string, McpSession>();

  return async function handleMcpRequest(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");

    // Route to existing session
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        return session.transport.handleRequest(request);
      }
      // Invalid/expired session — let a fresh transport handle it (it will reject properly)
    }

    // New session: create transport + server pair
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcpServer });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });

    const mcpServer = createMcpServer(deps);
    await mcpServer.connect(transport);

    return transport.handleRequest(request);
  };
}

// ─── Startup ─────────────────────────────────────────────────────────

export async function startMcpServer(deps: OperationDeps) {
  const enabled = process.env.KORE_MCP_ENABLED !== "false";
  if (!enabled) {
    console.log("MCP server disabled (KORE_MCP_ENABLED=false)");
    return null;
  }

  const mcpPath = process.env.KORE_MCP_PATH ?? "/mcp";
  if (!mcpPath) {
    console.log("MCP HTTP transport disabled (KORE_MCP_PATH is empty)");
    return null;
  }

  const handleRequest = createMcpRequestHandler(deps);

  console.log(`MCP server started (path: ${mcpPath})`);

  return { handleRequest, mcpPath };
}

export type McpServerHandle = Awaited<ReturnType<typeof startMcpServer>>;

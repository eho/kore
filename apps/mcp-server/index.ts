/**
 * Kore MCP stdio-to-HTTP proxy
 *
 * Lightweight bridge that exposes Kore's embedded MCP server to stdio-based
 * MCP clients (Claude Desktop, Claude Code, etc.). Connects to the running
 * Kore daemon at KORE_API_URL/mcp using Streamable HTTP transport.
 *
 * This process contains NO tool logic — all business logic lives in core-api.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const KORE_API_URL = process.env.KORE_API_URL ?? "http://localhost:3000";
const KORE_API_KEY = process.env.KORE_API_KEY ?? "";
const MCP_PATH = process.env.KORE_MCP_PATH ?? "/mcp";

// ── Health check ─────────────────────────────────────────────────────

async function checkDaemonHealth(): Promise<void> {
  const url = `${KORE_API_URL}/api/v1/health`;
  const headers: Record<string, string> = {};
  if (KORE_API_KEY) {
    headers["Authorization"] = `Bearer ${KORE_API_KEY}`;
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      process.stderr.write(
        `Kore daemon returned HTTP ${res.status}. Check KORE_API_KEY and ensure the server is running.\n`
      );
      process.exit(1);
    }
  } catch {
    process.stderr.write(
      "Kore daemon is not running. Start it with: bun run apps/core-api/src/index.ts\n"
    );
    process.exit(1);
  }
}

// ── Proxy setup ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  await checkDaemonHealth();

  // Upstream: HTTP client connecting to daemon's /mcp endpoint
  const mcpUrl = new URL(MCP_PATH, KORE_API_URL);
  const authHeaders: Record<string, string> = {};
  if (KORE_API_KEY) {
    authHeaders["Authorization"] = `Bearer ${KORE_API_KEY}`;
  }

  const httpTransport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: authHeaders },
  });

  const upstream = new Client({ name: "kore-stdio-proxy", version: "1.0.0" });
  await upstream.connect(httpTransport);

  // Downstream: stdio server facing the MCP client (Claude, etc.)
  const server = new Server(
    { name: "kore", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Forward listTools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstream.listTools();
    return { tools: result.tools };
  });

  // Forward callTool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await upstream.callTool({ name, arguments: args });
    return result;
  });

  // Connect stdio transport
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  // Graceful shutdown
  const cleanup = async () => {
    await server.close();
    await upstream.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

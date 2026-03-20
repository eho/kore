#!/usr/bin/env bun
import { Command } from "commander";
import { warnIfNoApiKey } from "./utils/env.ts";
import { healthCommand } from "./commands/health.ts";
import { configCommand } from "./commands/config.ts";
import { ingestCommand } from "./commands/ingest.ts";
import { taskCommand } from "./commands/task.ts";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { deleteCommand } from "./commands/delete.ts";
import { searchCommand } from "./commands/search.ts";
import { resetCommand } from "./commands/reset.ts";
import { syncCommand } from "./commands/sync.ts";
import { consolidateCommand } from "./commands/consolidate.ts";
import { consolidationResetCommand } from "./commands/consolidation-reset.ts";
import { insightsCommand } from "./commands/insights.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { startCommand } from "./commands/start.ts";

// Read version from package.json
const pkg = await import("../package.json", { with: { type: "json" } });
const version: string = pkg.default.version;

const program = new Command();

program
  .name("kore")
  .description("CLI for the Kore memory system")
  .version(version, "-V, --version", "Print version number");

// Warn when API key is missing (but not for config or help)
program.hook("preAction", (thisCommand) => {
  const name = thisCommand.args[0];
  if (name !== "config") {
    warnIfNoApiKey();
  }
});

// ─── start ───────────────────────────────────────────────────────────────────
program
  .command("start")
  .description("Start the Kore daemon (core-api server)")
  .action(async () => {
    await startCommand();
  });

// ─── health ──────────────────────────────────────────────────────────────────
program
  .command("health")
  .description("Check system health: memory counts, queue, index, and sync state")
  .option("--json", "Output raw JSON", false)
  .action(async (opts) => {
    await healthCommand(opts);
  });

// ─── config ──────────────────────────────────────────────────────────────────
program
  .command("config")
  .description("Show current CLI configuration (no API call)")
  .option("--json", "Output raw JSON", false)
  .action(async (opts) => {
    await configCommand(opts);
  });

// ─── ingest ─────────────────────────────────────────────────────────────────
program
  .command("ingest")
  .description("Ingest text content for memory extraction")
  .argument("[files...]", "Files to ingest (reads stdin if none)")
  .option("--source <name>", "Override the source label")
  .option("--url <url>", "Attach an original URL to the ingestion payload")
  .option("--priority <level>", "Queue priority: low, normal, high", "normal")
  .option("--no-wait", "Skip polling and return immediately")
  .option("--suggested-tags <tags>", "Comma-separated suggested tags")
  .option("--suggested-category <category>", "Suggested category")
  .option("--json", "Output JSON (with --no-wait)", false)
  .action(async (files, opts) => {
    await ingestCommand(files, opts);
  });

// ─── task ────────────────────────────────────────────────────────────────────
program
  .command("task")
  .description("Check the status of an ingestion task")
  .argument("<id>", "Task ID to check")
  .option("--json", "Output raw JSON", false)
  .action(async (taskId, opts) => {
    await taskCommand(taskId, opts);
  });

// ─── list ────────────────────────────────────────────────────────────────────
program
  .command("list")
  .description("List stored memories")
  .option("--type <type>", "Filter by memory type (place, media, note, person, insight)")
  .option("--limit <n>", "Maximum number of results", "20")
  .option("--json", "Output raw JSON", false)
  .action(async (opts) => {
    await listCommand({ type: opts.type, limit: Number(opts.limit), json: opts.json });
  });

// ─── show ────────────────────────────────────────────────────────────────────
program
  .command("show")
  .description("Show a stored memory with full details")
  .argument("<id>", "Memory ID (or prefix)")
  .option("--json", "Output raw JSON matching InspectOutput schema", false)
  .action(async (id, opts) => {
    await showCommand(id, opts);
  });

// ─── delete ──────────────────────────────────────────────────────────────────
program
  .command("delete")
  .description("Delete a stored memory")
  .argument("<id>", "Memory ID")
  .option("--force", "Skip confirmation prompt", false)
  .action(async (id, opts) => {
    await deleteCommand(id, opts);
  });

// ─── search ──────────────────────────────────────────────────────────────────
program
  .command("search")
  .description("Search memories using semantic search (backed by recall operation)")
  .argument("[query]", "Search query (prompted interactively if omitted)")
  .option("--type <type>", "Filter by memory type")
  .option("--intent <string>", "Hint for the reranker")
  .option("--tags <tags>", "Comma-separated tag filter (all must match)")
  .option("--limit <number>", "Max results to return", "10")
  .option("--min-confidence <number>", "Minimum confidence threshold (0.0 to 1.0)")
  .option("--min-score <number>", "Minimum score threshold (0.0 to 1.0)")
  .option("--include-insights", "Include insight memories in results")
  .option("--created-after <date>", "Filter to memories created after this date (ISO 8601)")
  .option("--created-before <date>", "Filter to memories created before this date (ISO 8601)")
  .option("--offset <number>", "Pagination offset", "0")
  .option("--json", "Output results as JSON matching RecallOutput schema", false)
  .action(async (query, opts) => {
    await searchCommand(query, opts);
  });

// ─── insights ────────────────────────────────────────────────────────────────
program
  .command("insights")
  .description("List or search synthesized insights")
  .argument("[query]", "Optional search query")
  .option("--type <type>", "Filter by insight type (e.g., evolution, pattern, preference)")
  .option("--status <status>", "Filter by status (default: active)", "active")
  .option("--limit <number>", "Max results to return", "5")
  .option("--json", "Output results as JSON matching InsightsOutput schema", false)
  .action(async (query, opts) => {
    await insightsCommand(query, opts);
  });

// ─── mcp ────────────────────────────────────────────────────────────────────
program
  .command("mcp")
  .description("Start the MCP stdio proxy for agent integration")
  .action(async () => {
    await mcpCommand();
  });

// ─── sync ───────────────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Trigger Apple Notes sync or check sync status")
  .option("--status", "Show sync status instead of triggering a sync", false)
  .option("--json", "Output raw JSON", false)
  .action(async (opts) => {
    await syncCommand(opts);
  });

// ─── consolidate ────────────────────────────────────────────────────────────
program
  .command("consolidate")
  .description("Trigger a consolidation cycle to synthesize related memories into insights")
  .option("--dry-run", "Preview consolidation without running LLM synthesis", false)
  .option("--reset-failed", "Reset failed tracker entries before running", false)
  .option("-v, --verbose", "Show detailed diagnostic info", false)
  .option("--json", "Output raw JSON matching ConsolidateOutput schema", false)
  .action(async (opts) => {
    await consolidateCommand({ dryRun: opts.dryRun, resetFailed: opts.resetFailed, json: opts.json, verbose: opts.verbose });
  });

// ─── consolidation (subcommands) ─────────────────────────────────────────────
const consolidationCmd = program
  .command("consolidation")
  .description("Manage consolidation state");

consolidationCmd
  .command("reset")
  .description("Delete all insights and restore all memories to unconsolidated state")
  .option("--force", "Skip confirmation prompt", false)
  .option("--json", "Output raw JSON", false)
  .action(async (opts) => {
    await consolidationResetCommand({ force: opts.force, json: opts.json });
  });

// ─── reset ──────────────────────────────────────────────────────────────────
program
  .command("reset")
  .description("Delete all memories, tasks, and the search index")
  .option("--force", "Skip confirmation prompt", false)
  .action(async (opts) => {
    await resetCommand(opts);
  });

// Unknown commands: print error + help, exit 1
program.on("command:*", (operands) => {
  process.stderr.write(`Error: unknown command '${operands[0]}'\n\n`);
  program.outputHelp();
  process.exit(1);
});

// No subcommand: print help
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

await program.parseAsync(process.argv);
process.exit(0);

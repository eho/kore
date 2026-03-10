#!/usr/bin/env bun
import { Command } from "commander";
import { warnIfNoApiKey } from "./utils/env.ts";
import { healthCommand } from "./commands/health.ts";
import { configCommand } from "./commands/config.ts";

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

// ─── health ──────────────────────────────────────────────────────────────────
program
  .command("health")
  .description("Check the health of the Kore API")
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

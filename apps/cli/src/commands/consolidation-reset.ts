import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface ConsolidationResetOpts {
  force: boolean;
  json: boolean;
}

interface ConsolidationResetResponse {
  status: string;
  deleted_insights: number;
  restored_memories: number;
  tracker_backfilled: number;
}

async function confirm(message: string): Promise<boolean> {
  const enquirer = await import("enquirer");
  return (enquirer.default as any).confirm({ name: "value", message });
}

export async function consolidationResetCommand(opts: ConsolidationResetOpts): Promise<void> {
  if (!opts.force) {
    const yes = await confirm(
      "This will delete all insights and restore all memories to unconsolidated state. Continue?",
    );
    if (!yes) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  const result = await apiFetch<ConsolidationResetResponse>("/api/v1/consolidation", {
    method: "DELETE",
  });

  if (!result.ok) {
    if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(
        `Error: Consolidation reset failed (${result.status}): ${result.message}\n`,
      );
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
    return;
  }

  const { deleted_insights, restored_memories, tracker_backfilled } = result.data;
  process.stdout.write(
    [
      pc.green("Consolidation reset complete!"),
      `Deleted insights:    ${deleted_insights}`,
      `Restored memories:   ${restored_memories}`,
      `Tracker backfilled:  ${tracker_backfilled}`,
    ].join("\n") + "\n",
  );
}

import pc from "picocolors";
import { createSpinner } from "nanospinner";
import { apiFetch } from "../api.ts";

interface ConsolidateOutput {
  status: "consolidated" | "no_seed" | "cluster_too_small" | "retired_reeval" | "synthesis_failed" | "dry_run";
  seed?: { id: string; title: string };
  insight_id?: string;
  cluster_size?: number;
  candidate_count?: number;
  candidates?: Array<{ id: string; title: string; score: number }>;
  proposed_insight_type?: string;
  estimated_confidence?: number;
}

export async function consolidateCommand(opts: {
  dryRun: boolean;
  resetFailed: boolean;
  json: boolean;
  verbose: boolean;
}): Promise<void> {
  const isTTY = process.stdout.isTTY && !opts.json && !opts.dryRun;
  const spinner = isTTY ? createSpinner("Consolidating…").start() : null;

  const body: Record<string, unknown> = {};
  if (opts.dryRun) body.dry_run = true;
  if (opts.resetFailed) body.reset_failed = true;

  const result = await apiFetch<ConsolidateOutput>("/api/v1/consolidate", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (spinner) spinner.stop();

  if (!result.ok) {
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: result.message }) + "\n");
    } else {
      process.stderr.write(`Error: Consolidation failed (${result.status}): ${result.message}\n`);
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data) + "\n");
    return;
  }

  const data = result.data;

  if (data.status === "no_seed") {
    process.stdout.write("No consolidation work available. Try again later.\n");
    return;
  }

  if (data.status === "cluster_too_small") {
    process.stdout.write(
      `Seed: "${data.seed?.title}" (${data.seed?.id})\n` +
        `Found only ${data.candidate_count} candidate(s), need at least 3. Try running with different content.\n`
    );
    return;
  }

  if (data.status === "dry_run") {
    process.stdout.write(`Seed: "${data.seed?.title}" (${data.seed?.id})\n`);
    if (data.candidates && data.candidates.length > 0) {
      process.stdout.write(`Candidates (${data.candidates.length}):\n`);
      for (const c of data.candidates) {
        process.stdout.write(`  - "${c.title}" (score: ${c.score.toFixed(2)})\n`);
      }
    }
    process.stdout.write(`Proposed type: ${data.proposed_insight_type}\n`);
    process.stdout.write(
      `Estimated confidence: ${data.estimated_confidence?.toFixed(2)}\n`
    );
    return;
  }

  if (data.status === "consolidated") {
    process.stdout.write(
      [
        pc.green("Consolidation complete!"),
        `Seed:         "${data.seed?.title}" (${data.seed?.id})`,
        `Cluster Size: ${data.cluster_size}`,
        `Insight ID:   ${data.insight_id}`,
      ].join("\n") + "\n"
    );
    return;
  }

  // Fallback for any other status
  process.stdout.write(`Consolidation result: ${data.status}\n`);
  if (data.seed) {
    process.stdout.write(
      `Seed: "${data.seed.title}" (${data.seed.id})\n`
    );
  }
}

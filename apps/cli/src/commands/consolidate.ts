import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

interface ConsolidateResponse {
  status: string;
  insightId?: string;
  seed?: { id: string; title: string };
  clusterSize?: number;
  candidateCount?: number;
  candidates?: Array<{ id: string; title: string; score: number }>;
  proposedInsightType?: string;
  estimatedConfidence?: number;
}

export async function consolidateCommand(opts: {
  dryRun: boolean;
  resetFailed: boolean;
  json: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (opts.dryRun) params.set("dry_run", "true");
  if (opts.resetFailed) params.set("reset_failed", "true");

  const qs = params.toString();
  const path = `/api/v1/consolidate${qs ? `?${qs}` : ""}`;

  const result = await apiFetch<ConsolidateResponse>(path, { method: "POST" });

  if (!result.ok) {
    if (result.status === 0) {
      process.stderr.write(
        `Error: Cannot reach Kore API at ${API_URL}. Is the server running?\n`
      );
    } else {
      process.stderr.write(
        `Error: Consolidation failed (${result.status}): ${result.message}\n`
      );
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
    return;
  }

  const { status } = result.data;

  if (status === "no_seed") {
    process.stdout.write("No consolidation work available. Try again later.\n");
    return;
  }

  if (status === "cluster_too_small") {
    const { seed, candidateCount } = result.data;
    process.stdout.write(
      `Seed: "${seed?.title}" (${seed?.id})\n` +
        `Found only ${candidateCount} candidate(s), need at least 3. Try running with different content.\n`
    );
    return;
  }

  if (status === "dry_run") {
    const { seed, candidates, proposedInsightType, estimatedConfidence } =
      result.data;
    process.stdout.write(`Seed: "${seed?.title}" (${seed?.id})\n`);
    if (candidates && candidates.length > 0) {
      process.stdout.write(`Candidates (${candidates.length}):\n`);
      for (const c of candidates) {
        process.stdout.write(`  - "${c.title}" (score: ${c.score.toFixed(2)})\n`);
      }
    }
    process.stdout.write(`Proposed type: ${proposedInsightType}\n`);
    process.stdout.write(
      `Estimated confidence: ${estimatedConfidence?.toFixed(2)}\n`
    );
    return;
  }

  if (status === "consolidated") {
    const { seed, clusterSize, insightId } = result.data;
    process.stdout.write(
      [
        pc.green("Consolidation complete!"),
        `Seed:         "${seed?.title}" (${seed?.id})`,
        `Cluster Size: ${clusterSize}`,
        `Insight ID:   ${insightId}`,
      ].join("\n") + "\n"
    );
    return;
  }

  // Fallback for any other status (e.g., retired_reeval)
  process.stdout.write(`Consolidation result: ${status}\n`);
  if (result.data.seed) {
    process.stdout.write(
      `Seed: "${result.data.seed.title}" (${result.data.seed.id})\n`
    );
  }
}

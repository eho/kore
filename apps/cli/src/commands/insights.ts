import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface InsightResultItem {
  id: string;
  title: string;
  insight_type: string;
  confidence: number;
  status: string;
  source_ids: string[];
  source_count: number;
  synthesis: string;
  distilled_items: string[];
  tags: string[];
  date_saved: string;
  last_synthesized_at?: string;
  reinforcement_count: number;
  supersedes?: string[];
}

interface InsightsOutput {
  results: InsightResultItem[];
  total: number;
}

interface InsightsOpts {
  type?: string;
  status?: string;
  limit?: string;
  json: boolean;
}

export async function insightsCommand(
  query: string | undefined,
  opts: InsightsOpts
): Promise<void> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("query", query.trim());
  if (opts.type) params.set("type", opts.type);
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", opts.limit);

  const qs = params.toString();
  const path = `/api/v1/insights${qs ? `?${qs}` : ""}`;

  const result = await apiFetch<InsightsOutput>(path);

  if (!result.ok) {
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: result.message }) + "\n");
    } else {
      process.stderr.write(`Error: ${result.message}\n`);
    }
    process.exit(1);
  }

  const data = result.data;

  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + "\n");
    return;
  }

  if (data.results.length === 0) {
    process.stdout.write("No insights found.\n");
    return;
  }

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    const confStr = pc.dim(`confidence: ${r.confidence.toFixed(2)}`);
    const typeStr = pc.dim(`[${r.insight_type}]`);
    const statusStr = r.status === "active" ? pc.green(r.status) : pc.yellow(r.status);

    const lines = [
      pc.bold(pc.cyan(r.title)) + "  " + typeStr + "  " + confStr,
      `  Status: ${statusStr}  Sources: ${r.source_count}  Reinforced: ${r.reinforcement_count}x`,
      pc.dim(`  id: ${r.id}`),
    ];

    if (r.synthesis) {
      const synth = r.synthesis.length > 200 ? r.synthesis.slice(0, 200) + "..." : r.synthesis;
      lines.push(`  ${synth}`);
    }

    process.stdout.write(lines.join("\n") + "\n");
    if (i < data.results.length - 1) {
      process.stdout.write(pc.dim("───") + "\n");
    }
  }

  process.stdout.write(pc.dim(`\n${data.total} insight(s) found`) + "\n");
}

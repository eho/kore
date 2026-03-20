import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface RecallResultItem {
  id: string;
  title: string;
  type: string;
  category: string;
  intent?: string;
  confidence?: number;
  tags: string[];
  date_saved: string;
  source: string;
  distilled_items: string[];
  score: number;
  insight_type?: string;
  source_count?: number;
  status?: string;
}

interface RecallOutput {
  results: RecallResultItem[];
  query: string;
  total: number;
  offset: number;
  has_more: boolean;
}

interface SearchOpts {
  intent?: string;
  limit?: string;
  type?: string;
  tags?: string;
  minConfidence?: string;
  minScore?: string;
  includeInsights?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  offset?: string;
  json: boolean;
}

export async function searchCommand(
  query: string | undefined,
  opts: SearchOpts
): Promise<void> {
  // If no query supplied, prompt interactively
  let resolvedQuery = query?.trim() ?? "";

  if (!resolvedQuery && process.stdin.isTTY) {
    const { prompt } = await import("enquirer");
    const answer = await prompt<{ query: string }>({
      type: "input",
      name: "query",
      message: "Search query:",
    });
    resolvedQuery = answer.query.trim();
  }

  // Build recall request body
  const body: Record<string, unknown> = {};
  if (resolvedQuery) body.query = resolvedQuery;
  if (opts.type) body.type = opts.type;
  if (opts.intent) body.intent = opts.intent;
  if (opts.tags) body.tags = opts.tags.split(",").map((t) => t.trim());
  if (opts.limit) body.limit = Number(opts.limit);
  if (opts.minConfidence) body.min_confidence = Number(opts.minConfidence);
  if (opts.minScore) body.min_score = Number(opts.minScore);
  if (opts.includeInsights !== undefined) body.include_insights = opts.includeInsights;
  if (opts.createdAfter) body.created_after = opts.createdAfter;
  if (opts.createdBefore) body.created_before = opts.createdBefore;
  if (opts.offset) body.offset = Number(opts.offset);

  const result = await apiFetch<RecallOutput>("/api/v1/recall", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: result.message }) + "\n");
    } else {
      process.stderr.write(`Error: ${result.message}\n`);
    }
    process.exit(1);
  }

  const data = result.data;

  // ── JSON output ──────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + "\n");
    return;
  }

  // ── Empty results ────────────────────────────────────────────────────
  if (data.results.length === 0) {
    const queryStr = data.query ? ` for '${data.query}'` : "";
    process.stdout.write(`No results found${queryStr}\n`);
    return;
  }

  // ── Formatted output ─────────────────────────────────────────────────
  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    const scoreStr = pc.dim(`score: ${r.score.toFixed(3)}`);
    const typeStr = pc.dim(`[${r.type}]`);
    const lines = [
      pc.bold(pc.cyan(r.title)) + "  " + typeStr + "  " + scoreStr,
      pc.dim(`id: ${r.id}`),
    ];

    if (r.distilled_items.length > 0) {
      lines.push(r.distilled_items.slice(0, 3).map((d) => `  - ${d}`).join("\n"));
    }

    process.stdout.write(lines.join("\n") + "\n");
    if (i < data.results.length - 1) {
      process.stdout.write(pc.dim("───") + "\n");
    }
  }

  if (data.has_more) {
    process.stdout.write(pc.dim(`\n… more results available (use --offset ${data.offset + data.results.length})`) + "\n");
  }
}

import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  collection: string | null;
}

interface SearchOpts {
  intent?: string;
  limit?: string;
  collection?: string;
  json: boolean;
}

export async function searchCommand(
  query: string | undefined,
  opts: SearchOpts
): Promise<void> {
  // If no query supplied, prompt interactively
  let resolvedQuery = query?.trim() ?? "";

  if (!resolvedQuery) {
    const { prompt } = await import("enquirer");
    const answer = await prompt<{ query: string }>({
      type: "input",
      name: "query",
      message: "Search query:",
    });
    resolvedQuery = answer.query.trim();
    if (!resolvedQuery) {
      process.stderr.write("Error: query cannot be empty.\n");
      process.exit(1);
    }
  }

  const body: Record<string, unknown> = { query: resolvedQuery };
  if (opts.intent) body.intent = opts.intent;
  if (opts.limit) body.limit = Number(opts.limit);
  if (opts.collection) body.collection = opts.collection;

  const result = await apiFetch<SearchResult[]>("/api/v1/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(
        `Error: ${result.message || `API error (${result.status})`}\n`
      );
    }
    process.exit(1);
  }

  const results = result.data;

  // ── JSON output ──────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ query: resolvedQuery, results }, null, 2) + "\n"
    );
    return;
  }

  // ── Empty results ────────────────────────────────────────────────────
  if (results.length === 0) {
    process.stdout.write(`No results found for '${resolvedQuery}'\n`);
    return;
  }

  // ── Formatted output ────────────────────────────────────────────────
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const snippet =
      r.snippet && r.snippet.length > 200
        ? r.snippet.slice(0, 200) + "..."
        : r.snippet ?? "";

    process.stdout.write(
      [
        pc.bold(pc.cyan(r.title)),
        pc.dim(r.path),
        snippet,
      ].join("\n") + "\n"
    );

    if (i < results.length - 1) {
      process.stdout.write(pc.dim("───") + "\n");
    }
  }
}

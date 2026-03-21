import Table from "cli-table3";
import { apiFetch } from "../api.ts";

interface RecallResultItem {
  id: string;
  type: string;
  title: string;
  source: string;
  date_saved: string;
  tags: string[];
  score: number;
  confidence?: number;
  // Insight-specific fields
  insight_type?: string;
  status?: string;
  source_count?: number;
}

interface RecallOutput {
  results: RecallResultItem[];
  query: string;
  total: number;
  offset: number;
  has_more: boolean;
}

interface ListOpts {
  type?: string;
  limit: number;
  json: boolean;
}

export async function listCommand(opts: ListOpts): Promise<void> {
  const body: Record<string, any> = {
    limit: opts.limit,
  };
  if (opts.type) body.type = opts.type;

  const result = await apiFetch<RecallOutput>(`/api/v1/recall`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    process.stderr.write(
      result.status === 0
        ? `Error: ${result.message}\n`
        : `Error: API error (${result.status}): ${result.message}\n`
    );
    process.exit(1);
  }

  const memories = result.data.results;

  if (opts.json) {
    process.stdout.write(JSON.stringify(memories, null, 2) + "\n");
    return;
  }

  if (memories.length === 0) {
    process.stdout.write("No memories found.\n");
    return;
  }

  const isInsightList = opts.type === "insight";

  if (isInsightList) {
    const table = new Table({
      head: ["ID", "Title", "Insight Type", "Status", "Confidence", "Sources", "Tags", "Date Saved"],
      style: { head: ["cyan"] },
    });

    for (const m of memories) {
      const tags = m.tags.join(", ");
      table.push([
        m.id.slice(0, 12),
        m.title.slice(0, 30) + (m.title.length > 30 ? "…" : ""),
        m.insight_type ?? "",
        m.status ?? "",
        m.confidence !== undefined ? String(m.confidence) : "",
        m.source_count !== undefined ? String(m.source_count) : "",
        tags.slice(0, 20) + (tags.length > 20 ? "…" : ""),
        m.date_saved ? new Date(m.date_saved).toLocaleDateString() : "",
      ]);
    }

    process.stdout.write(table.toString() + "\n");
  } else {
    const table = new Table({
      head: ["ID", "Type", "Title", "Source", "Date Saved"],
      style: { head: ["cyan"] },
    });

    for (const m of memories) {
      table.push([
        m.id.slice(0, 8),
        m.type,
        m.title.slice(0, 40) + (m.title.length > 40 ? "…" : ""),
        m.source,
        m.date_saved ? new Date(m.date_saved).toLocaleDateString() : "",
      ]);
    }

    process.stdout.write(table.toString() + "\n");
  }
}

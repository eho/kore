import Table from "cli-table3";
import { apiFetch } from "../api.ts";

interface MemorySummary {
  id: string;
  type: string;
  title: string;
  source: string;
  date_saved: string;
  tags: string[];
  // Insight-specific fields
  insight_type?: string;
  status?: string;
  source_ids_count?: number;
}

interface ListOpts {
  type?: string;
  limit: number;
  json: boolean;
}

export async function listCommand(opts: ListOpts): Promise<void> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  params.set("limit", String(opts.limit));

  const result = await apiFetch<MemorySummary[]>(`/api/v1/memories?${params}`);

  if (!result.ok) {
    process.stderr.write(
      result.status === 0
        ? `Error: ${result.message}\n`
        : `Error: API error (${result.status}): ${result.message}\n`
    );
    process.exit(1);
  }

  const memories = result.data;

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
      head: ["ID", "Title", "Insight Type", "Status", "Confidence", "Sources", "Date Saved"],
      style: { head: ["cyan"] },
    });

    for (const m of memories) {
      table.push([
        m.id.slice(0, 12),
        m.title.slice(0, 40) + (m.title.length > 40 ? "…" : ""),
        m.insight_type ?? "",
        m.status ?? "",
        (m as any).confidence !== undefined ? String((m as any).confidence) : "",
        m.source_ids_count !== undefined ? String(m.source_ids_count) : "",
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

import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface InspectOutput {
  id: string;
  title: string;
  type: string;
  category: string;
  intent?: string;
  confidence?: number;
  tags: string[];
  date_saved: string;
  date_created?: string;
  date_modified?: string;
  source: string;
  url?: string;
  distilled_items: string[];
  content: string;
  consolidated_at?: string;
  insight_refs?: string[];
  insight_type?: string;
  source_ids?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  status?: string;
  reinforcement_count?: number;
}

interface ShowOpts {
  json: boolean;
}

export async function showCommand(id: string, opts: ShowOpts): Promise<void> {
  const result = await apiFetch<InspectOutput>(`/api/v1/inspect/${id}`);

  if (!result.ok) {
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: result.message }) + "\n");
    } else if (result.status === 404) {
      process.stderr.write(`Error: Memory ${id} not found.\n`);
    } else {
      process.stderr.write(`Error: ${result.message}\n`);
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data) + "\n");
    return;
  }

  // Human-readable output: show the raw content (backward-compatible)
  process.stdout.write(result.data.content + "\n");
}

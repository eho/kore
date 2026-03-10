import { apiFetch } from "../api.ts";

interface MemoryFull {
  id: string;
  type: string;
  category: string;
  date_saved: string;
  source: string;
  tags: string[];
  url?: string;
  title: string;
  content: string;
}

interface ShowOpts {
  json: boolean;
}

export async function showCommand(id: string, opts: ShowOpts): Promise<void> {
  const result = await apiFetch<MemoryFull>(`/api/v1/memory/${id}`);

  if (!result.ok) {
    if (result.status === 404) {
      process.stderr.write(`Error: Memory ${id} not found.\n`);
    } else if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(`Error: API error (${result.status}): ${result.message}\n`);
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
    return;
  }

  process.stdout.write(result.data.content + "\n");
}

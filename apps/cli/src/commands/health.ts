import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

interface HealthOutput {
  version: string;
  memories: {
    total: number;
    by_type: Record<string, number>;
  };
  queue: {
    pending: number;
    processing: number;
    failed: number;
  };
  index: {
    documents: number;
    embedded: number;
    status: string;
  };
  sync?: {
    apple_notes: {
      enabled: boolean;
      last_sync_at?: string;
      total_tracked: number;
    };
  };
}

export async function healthCommand(opts: { json: boolean }): Promise<void> {
  const result = await apiFetch<HealthOutput>("/api/v1/health");

  if (!result.ok) {
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: result.message }) + "\n");
    } else if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(
        `Error: Cannot reach Kore API at ${API_URL}. Is the server running?\n`
      );
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data) + "\n");
    return;
  }

  const { version, memories, queue, index, sync } = result.data;
  const indexColor = index.status === "ok" ? pc.green(index.status) : pc.yellow(index.status);

  const lines = [
    `Version:      ${version}`,
    ``,
    pc.bold("Memories"),
    `  Total:      ${memories.total}`,
  ];

  // Memory counts by type
  for (const [type, count] of Object.entries(memories.by_type)) {
    lines.push(`  ${type}: ${count}`);
  }

  lines.push(
    ``,
    pc.bold("Queue"),
    `  Pending:    ${queue.pending}`,
    `  Processing: ${queue.processing}`,
    `  Failed:     ${queue.failed}`,
    ``,
    pc.bold("Index"),
    `  Status:     ${indexColor}`,
    `  Documents:  ${index.documents}`,
    `  Embedded:   ${index.embedded}`,
  );

  // Sync state
  if (sync?.apple_notes) {
    const an = sync.apple_notes;
    const enabledStr = an.enabled ? pc.green("enabled") : pc.dim("disabled");
    lines.push(
      ``,
      pc.bold("Sync"),
      `  Apple Notes: ${enabledStr}`,
    );
    if (an.last_sync_at) lines.push(`  Last Sync:   ${an.last_sync_at}`);
    lines.push(`  Tracked:     ${an.total_tracked}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

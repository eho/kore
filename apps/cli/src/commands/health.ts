import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";
import { readPidFile, isProcessAlive } from "../utils/pid.ts";

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

function getProcessInfo(): { pid: number | null; alive: boolean } {
  const pid = readPidFile();
  if (pid === null) return { pid: null, alive: false };
  return { pid, alive: isProcessAlive(pid) };
}

function extractPort(): number | null {
  try {
    const url = new URL(API_URL);
    const port = parseInt(url.port, 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

export async function healthCommand(opts: { json: boolean }): Promise<void> {
  const { pid, alive } = getProcessInfo();
  const port = extractPort();
  const result = await apiFetch<HealthOutput>("/api/v1/health");

  if (!result.ok) {
    // Server unreachable
    if (alive && pid !== null) {
      // PID alive but health endpoint not responding
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ status: "unreachable", pid, port, error: "Health endpoint is not responding" }) + "\n"
        );
      } else {
        process.stderr.write(
          `Kore process exists (pid ${pid}) but health endpoint is not responding.\n`
        );
      }
      process.exit(1);
    }

    // Nothing found at all
    if (opts.json) {
      process.stderr.write(JSON.stringify({ error: "Kore is not running." }) + "\n");
    } else {
      process.stderr.write("Kore is not running.\n");
    }
    process.exit(1);
  }

  // Server is reachable
  if (opts.json) {
    const jsonData: Record<string, unknown> = { ...result.data };
    if (pid !== null) jsonData.pid = pid;
    if (port !== null) jsonData.port = port;
    process.stdout.write(JSON.stringify(jsonData) + "\n");
    return;
  }

  const { version, memories, queue, index, sync } = result.data;
  const indexColor = index.status === "ok" ? pc.green(index.status) : pc.yellow(index.status);

  const lines: string[] = [];

  // Always show running status when server is reachable
  if (pid !== null && port !== null) {
    lines.push(`Kore is running on :${port} (pid ${pid})`);
  } else if (pid !== null) {
    lines.push(`Kore is running (pid ${pid})`);
  } else if (port !== null) {
    lines.push(`Kore is running on :${port}`);
  } else {
    lines.push("Kore is running.");
  }
  lines.push("");

  lines.push(
    `Version:      ${version}`,
    ``,
    pc.bold("Memories"),
    `  Total:      ${memories.total}`,
  );

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

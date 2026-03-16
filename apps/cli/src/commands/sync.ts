import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

interface StatusResponse {
  enabled: boolean;
  last_sync_at: string | null;
  last_sync_result: string | null;
  total_tracked_notes: number;
  next_sync_in_seconds: number | null;
  staging_path: string;
}

interface SyncResponse {
  status: string;
  message: string;
}

export async function syncCommand(opts: { status: boolean; json: boolean }): Promise<void> {
  if (opts.status) {
    const result = await apiFetch<StatusResponse>("/api/v1/plugins/apple-notes/status");

    if (!result.ok) {
      if (result.status === 0) {
        process.stderr.write(`Error: ${result.message}\n`);
      } else {
        process.stderr.write(
          `Error: Cannot reach Kore API at ${API_URL}. Is the server running?\n`
        );
      }
      process.exit(1);
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
      return;
    }

    const { enabled, last_sync_at, last_sync_result, total_tracked_notes, next_sync_in_seconds, staging_path } = result.data;

    const enabledStr = enabled ? pc.green("enabled") : pc.red("disabled");
    const resultStr = last_sync_result === "success"
      ? pc.green(last_sync_result)
      : last_sync_result === "error"
        ? pc.red(last_sync_result)
        : pc.dim("n/a");

    const nextSyncStr = next_sync_in_seconds != null
      ? `${Math.floor(next_sync_in_seconds / 60)}m ${next_sync_in_seconds % 60}s`
      : pc.dim("n/a");

    process.stdout.write(
      [
        `Apple Notes:    ${enabledStr}`,
        `Last Sync:      ${last_sync_at ?? pc.dim("never")}`,
        `Last Result:    ${resultStr}`,
        `Tracked Notes:  ${total_tracked_notes}`,
        `Next Sync In:   ${nextSyncStr}`,
        `Staging Path:   ${staging_path}`,
      ].join("\n") + "\n"
    );
    return;
  }

  // Trigger sync
  const result = await apiFetch<SyncResponse>("/api/v1/plugins/apple-notes/sync", {
    method: "POST",
  });

  if (!result.ok) {
    if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(`Error: Failed to trigger sync (${result.status}): ${result.message}\n`);
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Sync triggered. ${result.data.message}\n`);
}

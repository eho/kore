import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

interface HealthResponse {
  status: string;
  version: string;
  qmd_status: string;
  queue_length: number;
}

export async function healthCommand(opts: { json: boolean }): Promise<void> {
  const result = await apiFetch<HealthResponse>("/api/v1/health");

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

  const { status, version, qmd_status, queue_length } = result.data;
  const statusColor = status === "ok" ? pc.green(status) : pc.red(status);
  const qmdColor =
    qmd_status === "ok" ? pc.green(qmd_status) : pc.yellow(qmd_status);

  process.stdout.write(
    [
      `API Status:   ${statusColor}`,
      `Version:      ${version}`,
      `QMD Status:   ${qmdColor}`,
      `Queue Length: ${queue_length}`,
    ].join("\n") + "\n"
  );
}

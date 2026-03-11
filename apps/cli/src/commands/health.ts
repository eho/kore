import pc from "picocolors";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

interface HealthResponse {
  status: string;
  version: string;
  qmd: {
    status: string;
    doc_count?: number;
    collections?: number;
    needs_embedding?: number;
  };
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

  const { status, version, qmd, queue_length } = result.data;
  const statusColor = status === "ok" ? pc.green(status) : pc.red(status);
  
  // Guard against missing `qmd` if server returns old structure temporarily
  const qmdStatus = qmd?.status || "undefined";
  const qmdColor =
    qmdStatus === "ok" ? pc.green(qmdStatus) : pc.yellow(qmdStatus);
    
  let qmdDetails = "";
  if (qmd) {
    const details = [];
    if (qmd.doc_count !== undefined) details.push(`docs: ${qmd.doc_count}`);
    if (qmd.collections !== undefined) details.push(`collections: ${qmd.collections}`);
    if (qmd.needs_embedding) details.push(`needs embedding: ${qmd.needs_embedding}`);
    if (details.length > 0) {
      qmdDetails = ` (${details.join(", ")})`;
    }
  }

  process.stdout.write(
    [
      `API Status:   ${statusColor}`,
      `Version:      ${version}`,
      `QMD Status:   ${qmdColor}${qmdDetails}`,
      `Queue Length: ${queue_length}`,
    ].join("\n") + "\n"
  );
}

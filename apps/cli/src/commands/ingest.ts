import pc from "picocolors";
import { createSpinner } from "nanospinner";
import { apiFetch } from "../api.ts";

interface IngestResponse {
  task_id: string;
}

interface TaskResponse {
  id: string;
  status: string;
  source?: string;
  error_log?: string;
  created_at?: string;
  updated_at?: string;
}

interface IngestOpts {
  source?: string;
  url?: string;
  priority: string;
  wait: boolean;
  json: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = process.stdin;
  for await (const chunk of reader) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function submitIngest(
  content: string,
  source: string,
  opts: IngestOpts
): Promise<{ taskId: string } | { error: string }> {
  const body: Record<string, unknown> = {
    content,
    source,
    priority: opts.priority,
  };
  if (opts.url) {
    body.original_url = opts.url;
  }

  const result = await apiFetch<IngestResponse>("/api/v1/ingest/raw", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    if (result.status === 0) {
      return { error: result.message };
    }
    return { error: `API error (${result.status}): ${result.message}` };
  }

  return { taskId: result.data.task_id };
}

async function pollTask(taskId: string, source: string): Promise<boolean> {
  const isTTY = process.stdout.isTTY;
  const spinner = isTTY ? createSpinner(`Ingesting "${source}"...`).start() : null;

  while (true) {
    const result = await apiFetch<TaskResponse>(`/api/v1/task/${taskId}`);

    if (!result.ok) {
      if (spinner) spinner.error({ text: `Failed to check task ${taskId}: ${result.message}` });
      else process.stderr.write(`Error: Failed to check task ${taskId}: ${result.message}\n`);
      return false;
    }

    const task = result.data;

    if (task.status === "completed" || task.status === "done") {
      if (spinner) spinner.success({ text: `Ingested "${source}" → task ${taskId} completed` });
      else process.stdout.write(`✓ Ingested "${source}" → task ${taskId} completed\n`);
      return true;
    }

    if (task.status === "failed" || task.status === "error") {
      const errorMsg = task.error_log || "Unknown error";
      if (spinner) spinner.error({ text: `Task ${taskId} failed: ${errorMsg}` });
      else process.stderr.write(`Error: Task ${taskId} failed: ${errorMsg}\n`);
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function ingestCommand(
  files: string[],
  opts: IngestOpts
): Promise<void> {
  // No files and stdin is a TTY → show help
  if (files.length === 0 && process.stdin.isTTY) {
    process.stderr.write(
      "Error: No input provided. Pass file(s) or pipe via stdin.\n" +
        "Usage: kore ingest <file...> or echo 'text' | kore ingest\n"
    );
    process.exit(1);
  }

  // Read from stdin
  if (files.length === 0) {
    const content = await readStdin();
    const source = opts.source || "stdin";

    const result = await submitIngest(content, source, opts);
    if ("error" in result) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }

    if (!opts.wait) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ task_id: result.taskId, source }) + "\n"
        );
      } else {
        process.stdout.write(
          `Queued task ${result.taskId} (source: "${source}"). Check status: kore status ${result.taskId}\n`
        );
      }
      return;
    }

    const success = await pollTask(result.taskId, source);
    if (!success) process.exit(1);
    return;
  }

  // Multi-file ingestion
  let succeeded = 0;
  let failed = 0;

  for (const filePath of files) {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      process.stderr.write(`Error: File not found: ${filePath}\n`);
      failed++;
      continue;
    }

    const content = await file.text();
    const source = opts.source || filePath;

    const result = await submitIngest(content, source, opts);
    if ("error" in result) {
      process.stderr.write(`Error: ${result.error}\n`);
      failed++;
      continue;
    }

    if (!opts.wait) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ task_id: result.taskId, source }) + "\n"
        );
      } else {
        process.stdout.write(
          `Queued task ${result.taskId} (source: "${source}"). Check status: kore status ${result.taskId}\n`
        );
      }
      succeeded++;
      continue;
    }

    const success = await pollTask(result.taskId, source);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  // Summary for multi-file
  if (files.length > 1) {
    const total = succeeded + failed;
    if (failed === 0) {
      process.stdout.write(
        `✓ ${succeeded}/${total} files ingested successfully\n`
      );
    } else {
      process.stderr.write(
        `⚠ ${succeeded}/${total} files ingested, ${failed} failed\n`
      );
    }
  }

  if (failed > 0) process.exit(1);
}

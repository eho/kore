import pc from "picocolors";
import { apiFetch } from "../api.ts";

interface TaskResponse {
  id: string;
  status: string;
  source?: string;
  error_log?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export async function statusCommand(
  taskId: string,
  opts: { json: boolean }
): Promise<void> {
  const result = await apiFetch<TaskResponse>(`/api/v1/task/${taskId}`);

  if (!result.ok) {
    if (result.status === 404) {
      process.stderr.write(`Error: Task ${taskId} not found.\n`);
    } else if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(
        `Error: Failed to fetch task ${taskId} (${result.status}): ${result.message}\n`
      );
    }
    process.exit(1);
  }

  const task = result.data;

  if (opts.json) {
    process.stdout.write(JSON.stringify(task, null, 2) + "\n");
    return;
  }

  const statusColor =
    task.status === "completed" || task.status === "done"
      ? pc.green(task.status)
      : task.status === "failed" || task.status === "error"
        ? pc.red(task.status)
        : pc.yellow(task.status);

  const lines = [
    `Task ID:      ${task.id}`,
    `Status:       ${statusColor}`,
  ];

  if (task.source) lines.push(`Source:       ${task.source}`);
  if (task.created_at) lines.push(`Created:      ${task.created_at}`);
  if (task.updated_at) lines.push(`Updated:      ${task.updated_at}`);
  if (task.error_log) lines.push(`Error:        ${pc.red(task.error_log)}`);

  process.stdout.write(lines.join("\n") + "\n");
}

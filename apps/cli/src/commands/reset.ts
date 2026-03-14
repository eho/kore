import { apiFetch } from "../api.ts";

interface ResetOpts {
  force: boolean;
}

interface ResetResponse {
  status: string;
  deleted_memories: number;
  deleted_tasks: number;
}

async function confirm(message: string): Promise<boolean> {
  const enquirer = await import("enquirer");
  return (enquirer.default as any).confirm({ name: "value", message });
}

export async function resetCommand(opts: ResetOpts): Promise<void> {
  if (!opts.force) {
    const yes = await confirm(
      "This will permanently delete all memories, tasks, and the search index. Continue?"
    );
    if (!yes) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  const result = await apiFetch<ResetResponse>("/api/v1/memories", {
    method: "DELETE",
  });

  if (!result.ok) {
    if (result.status === 0) {
      process.stderr.write(`Error: ${result.message}\n`);
    } else {
      process.stderr.write(
        `Error: API error (${result.status}): ${result.message}\n`
      );
    }
    process.exit(1);
  }

  const { deleted_memories, deleted_tasks } = result.data;
  process.stdout.write(
    `✓ Reset complete. Deleted ${deleted_memories} memories and ${deleted_tasks} tasks.\n`
  );
}

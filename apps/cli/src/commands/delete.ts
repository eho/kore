import { apiFetch } from "../api.ts";

interface DeleteOpts {
  force: boolean;
}

async function confirm(message: string): Promise<boolean> {
  // enquirer.default.confirm is a factory fn that creates and runs the prompt
  const enquirer = await import("enquirer");
  return (enquirer.default as any).confirm({ name: "value", message });
}

export async function deleteCommand(id: string, opts: DeleteOpts): Promise<void> {
  if (!opts.force) {
    const yes = await confirm(`Delete memory ${id}?`);
    if (!yes) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  const result = await apiFetch<{ status: string; id: string; restored_sources?: number }>(
    `/api/v1/memory/${id}`,
    { method: "DELETE" }
  );

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

  const restored = result.data?.restored_sources ?? 0;
  if (restored > 0) {
    process.stdout.write(`✓ Deleted insight ${id}. ${restored} source memories restored to consolidation pool.\n`);
  } else {
    process.stdout.write(`✓ Deleted memory ${id}.\n`);
  }
}

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { resolveKoreHome } from "@kore/qmd-client";

export { resolveKoreHome };

export function resolveDataPath(): string {
  return join(resolveKoreHome(), "data");
}

export function resolveQueueDbPath(): string {
  return join(resolveKoreHome(), "db", "kore-queue.db");
}

export function resolveQmdDbPath(): string {
  return join(resolveKoreHome(), "db", "qmd.sqlite");
}

/**
 * Ensure $KORE_HOME/data and $KORE_HOME/db exist before SQLite connections open.
 */
export async function ensureKoreDirectories(): Promise<void> {
  const home = resolveKoreHome();
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "db"), { recursive: true });
}

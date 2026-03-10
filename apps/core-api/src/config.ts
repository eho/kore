import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function resolveDataPath(): string {
  const raw = process.env.KORE_DATA_PATH || "~/.kore/data";
  if (raw.startsWith("~")) {
    return join(homedir(), raw.slice(1));
  }
  return resolve(raw);
}

export function resolveQueueDbPath(): string {
  return process.env.KORE_QUEUE_DB_PATH || "kore-queue.db";
}

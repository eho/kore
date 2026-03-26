import { join } from "node:path";
import { resolveKoreHome } from "./kore-home.ts";

const PID_FILENAME = ".kore.pid";

/** Returns the absolute path to the PID file: `$KORE_HOME/.kore.pid`. */
export function pidFilePath(): string {
  return join(resolveKoreHome(), PID_FILENAME);
}

/** Reads the PID file and returns the PID, or null if missing/corrupt. */
export function readPidFile(): number | null {
  try {
    const content = require("fs").readFileSync(pidFilePath(), "utf-8") as string;
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Writes the PID file atomically (write to temp, then rename).
 * Creates the parent directory if it doesn't exist.
 */
export function writePidFile(pid: number): void {
  const fs = require("fs");
  const path = pidFilePath();
  const dir = require("path").dirname(path);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, String(pid), "utf-8");
  fs.renameSync(tmpPath, path);
}

/** Deletes the PID file if it exists. */
export function deletePidFile(): void {
  try {
    require("fs").unlinkSync(pidFilePath());
  } catch {
    // Already gone — nothing to do
  }
}

/** Returns true if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

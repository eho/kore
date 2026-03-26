import { resolve } from "node:path";
import { readPidFile, writePidFile, deletePidFile, isProcessAlive } from "../utils/pid.ts";
import { apiFetch } from "../api.ts";

export async function startCommand(): Promise<void> {
  // Check if Kore is already running via PID file or health endpoint
  const existingPid = readPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    process.stdout.write(`Kore is already running (pid ${existingPid})\n`);
    process.exit(0);
  }

  // Also check health endpoint in case the PID file is missing
  const health = await apiFetch("/api/v1/health");
  if (health.ok) {
    process.stdout.write("Kore is already running.\n");
    process.exit(0);
  }

  // Clean up stale PID file if present
  if (existingPid) {
    deletePidFile();
  }

  const serverPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "core-api",
    "src",
    "index.ts"
  );

  const proc = Bun.spawn(["bun", "run", serverPath], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  });

  // Write PID file after successful spawn
  writePidFile(proc.pid);

  // Clean up PID file and forward signal on SIGTERM/SIGINT
  const cleanup = (signal: NodeJS.Signals) => {
    deletePidFile();
    process.kill(proc.pid, signal);
  };

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  const exitCode = await proc.exited;

  // Clean up PID file on child exit
  deletePidFile();
  process.exit(exitCode);
}

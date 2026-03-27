import { readPidFile, deletePidFile, isProcessAlive } from "../utils/pid.ts";
import { apiFetch } from "../api.ts";
import { API_URL } from "../utils/env.ts";

function extractPort(): number {
  try {
    const url = new URL(API_URL);
    return parseInt(url.port, 10) || 3000;
  } catch {
    return 3000;
  }
}

/**
 * Waits for a process to exit, polling every 200ms.
 * Returns true if the process exited within the timeout.
 */
function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!isProcessAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

/**
 * Discovers the PID of a process listening on the given port via `lsof`.
 * Returns null if nothing is found.
 */
function discoverPidByPort(port: number): number | null {
  try {
    const result = Bun.spawnSync(["lsof", "-i", `:${port}`, "-t"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString().trim();
    if (!output) return null;
    // lsof may return multiple PIDs (one per line); take the first
    const pid = parseInt(output.split("\n")[0], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stopProcess(pid: number): Promise<void> {
  process.stdout.write(`Stopping Kore (pid ${pid})... `);

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already gone
    deletePidFile();
    process.stdout.write("done.\n");
    return;
  }

  const exited = await waitForExit(pid, 10_000);

  if (!exited) {
    // Escalate to SIGKILL
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone
    }
    await waitForExit(pid, 2_000);
  }

  deletePidFile();
  process.stdout.write("done.\n");
}

export async function stopCommand(opts: { force: boolean }): Promise<void> {
  const pid = readPidFile();

  if (pid && isProcessAlive(pid)) {
    await stopProcess(pid);
    return;
  }

  // PID file exists but process is dead — clean up stale file
  if (pid) {
    deletePidFile();
  }

  // No PID file (or stale) — check health endpoint
  const health = await apiFetch("/api/v1/health");

  if (!health.ok) {
    process.stdout.write("Kore is not running.\n");
    return;
  }

  // Health responds but no PID file
  if (!opts.force) {
    const port = extractPort();
    process.stderr.write(
      `Kore is running on :${port} but was started externally.\n` +
      `Run \`kore stop --force\` to stop it.\n`
    );
    process.exit(1);
  }

  // --force: discover PID via lsof
  const port = extractPort();
  const discoveredPid = discoverPidByPort(port);

  if (!discoveredPid) {
    process.stderr.write(
      `Error: Could not discover process on port ${port} via lsof.\n`
    );
    process.exit(1);
  }

  await stopProcess(discoveredPid);
}

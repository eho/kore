import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";

setDefaultTimeout(15_000);
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = `${import.meta.dir}/../src/index.ts`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kore-stop-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

function runStop(port: number, ...extraArgs: string[]) {
  return spawnSync(["bun", CLI, "stop", ...extraArgs], {
    env: {
      ...process.env,
      KORE_HOME: tmpDir,
      KORE_API_URL: `http://127.0.0.1:${port}`,
      KORE_API_KEY: "test-key",
    },
  });
}

/** Spawn a detached HTTP server process on the given port, returns its PID */
function spawnServerOnPort(port: number): number {
  const script = `Bun.serve({ port: ${port}, fetch() { return new Response(JSON.stringify({version:"1.0.0"}), {headers:{"Content-Type":"application/json"}}); } }); await Bun.sleep(60000);`;
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Give server a moment to bind
  Bun.sleepSync(500);
  return proc.pid;
}

describe("kore stop", () => {
  test("prints 'not running' when no PID file and server unreachable", () => {
    const result = runStop(19860);
    expect(result.stdout.toString()).toContain("Kore is not running.");
    expect(result.exitCode).toBe(0);
  });

  test("cleans up stale PID file when process is dead", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "2147483647");
    const result = runStop(19861);
    expect(result.stdout.toString()).toContain("Kore is not running.");
    expect(existsSync(join(tmpDir, ".kore.pid"))).toBe(false);
  });

  test("stops a real process via PID file", () => {
    const sleeper = Bun.spawn(["sleep", "300"], { stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(tmpDir, ".kore.pid"), String(sleeper.pid));

    const result = runStop(19862);
    expect(result.stdout.toString()).toContain(`Stopping Kore (pid ${sleeper.pid})`);
    expect(result.stdout.toString()).toContain("done.");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, ".kore.pid"))).toBe(false);

    try { process.kill(sleeper.pid, "SIGKILL"); } catch {}
  });

  test("warns about external process when health responds but no PID file", () => {
    // Spawn a separate server process so stopping it won't affect the test runner
    const serverPid = spawnServerOnPort(19863);

    try {
      const result = runStop(19863);
      expect(result.stderr.toString()).toContain("started externally");
      expect(result.stderr.toString()).toContain("--force");
      expect(result.exitCode).toBe(1);
    } finally {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
  });

  test("--force discovers and stops process via lsof", () => {
    // Spawn a separate server process
    const serverPid = spawnServerOnPort(19864);

    try {
      const result = runStop(19864, "--force");
      const stdout = result.stdout.toString();
      expect(stdout).toContain("Stopping Kore");
      expect(stdout).toContain("done.");
    } finally {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
  });
});

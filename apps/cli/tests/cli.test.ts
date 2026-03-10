import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { spawnSync, serve } from "bun";

const CLI = `${import.meta.dir}/../src/index.ts`;

function runCli(...args: string[]) {
  return spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      KORE_API_URL: "http://localhost:3000",
      KORE_API_KEY: "test-key",
    },
  });
}

function runCliNoKey(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "KORE_API_KEY") env[k] = v;
  }
  env.KORE_API_URL = "http://localhost:3000";
  return spawnSync(["bun", CLI, ...args], { env });
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

describe("argument parsing", () => {
  test("no args prints usage and exits 0", () => {
    const result = runCli();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
  });

  test("--help prints usage and exits 0", () => {
    const result = runCli("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
    expect(result.stdout.toString()).toContain("health");
    expect(result.stdout.toString()).toContain("config");
  });

  test("--version prints version and exits 0", () => {
    const result = runCli("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/\d+\.\d+\.\d+/);
  });

  test("unknown command prints error and exits 1", () => {
    const result = runCli("notacommand");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown command");
    expect(result.stdout.toString()).toContain("Usage:");
  });
});

// ─── Config Command ──────────────────────────────────────────────────────────

describe("config command", () => {
  test("prints KORE_API_URL and masked key", () => {
    const result = spawnSync(["bun", CLI, "config"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://api.example.com",
        KORE_API_KEY: "kore_abc123xyz",
      },
    });
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(out).toContain("http://api.example.com");
    expect(out).toContain("***");
    // Should not print the full key
    expect(out).not.toContain("kore_abc123xyz");
  });

  test("--json outputs valid JSON with KORE_API_KEY_SET flag", () => {
    const result = spawnSync(["bun", CLI, "config", "--json"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://localhost:3000",
        KORE_API_KEY: "some-key",
      },
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.toString());
    expect(data.KORE_API_URL).toBe("http://localhost:3000");
    expect(data.KORE_API_KEY_SET).toBe(true);
    expect(data.KORE_API_KEY_MASKED).toContain("***");
  });
});

// ─── Key Masking ─────────────────────────────────────────────────────────────

describe("maskApiKey", () => {
  test("masks a normal key", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("kore_abc123xyz")).toBe("kore_***...***xyz");
  });

  test("returns (not set) for empty string", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("")).toBe("(not set)");
  });

  test("returns *** for very short keys", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("abc")).toBe("***");
  });
});

// ─── Health Command ──────────────────────────────────────────────────────────

describe("health command", () => {
  const server = serve({
    port: 19998,
    fetch(req) {
      if (req.url.endsWith("/api/v1/health")) {
        return new Response(JSON.stringify({
          status: "ok",
          version: "1.0",
          qmd_status: "ok",
          queue_length: 5
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }
  });

  afterAll(() => {
    server.stop();
  });

  test("prints successful health status", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:${server.port}`,
        KORE_API_KEY: "test-key",
      },
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("API Status:");
    expect(out).toContain("ok");
    expect(out).toContain("Queue Length: 5");
  });

  test("prints error and exits 1 when API is unreachable", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://127.0.0.1:19999",
        KORE_API_KEY: "test-key",
      },
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    const out = await new Response(proc.stderr).text();
    expect(out).toContain("Cannot reach Kore API");
  });

  test("warns when KORE_API_KEY is not set", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://127.0.0.1:19999",
        KORE_API_KEY: "",
      },
      stderr: "pipe",
    });
    await proc.exited;
    const out = await new Response(proc.stderr).text();
    expect(out).toContain("KORE_API_KEY not set");
  });
});

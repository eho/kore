import { test, expect, describe, mock, beforeEach } from "bun:test";
import { spawnSync } from "bun";

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
  test("prints error and exits 1 when API is unreachable", () => {
    const result = spawnSync(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://localhost:19999",
        KORE_API_KEY: "test-key",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Cannot reach Kore API");
  });

  test("warns when KORE_API_KEY is not set", () => {
    const result = spawnSync(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://localhost:19999",
        KORE_API_KEY: "",
      },
    });
    expect(result.stderr.toString()).toContain("KORE_API_KEY not set");
  });
});

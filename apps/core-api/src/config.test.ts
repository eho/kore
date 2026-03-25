import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

// Save original env to restore after each test
let originalKoreHome: string | undefined;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__config_test_tmp__", String(Date.now()));
  await mkdir(tmpDir, { recursive: true });
  originalKoreHome = process.env.KORE_HOME;
  delete process.env.KORE_HOME;

  // Clear env vars that would interfere with loadConfig tests
  delete process.env.KORE_PORT;
  delete process.env.KORE_API_KEY;
  delete process.env.LLM_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.KORE_APPLE_NOTES_ENABLED;
  delete process.env.KORE_EMBED_INTERVAL_MS;
  delete process.env.KORE_MCP_ENABLED;
  delete process.env.CONSOLIDATION_INTERVAL_MS;
  delete process.env.CONSOLIDATION_COOLDOWN_DAYS;
  delete process.env.CONSOLIDATION_MAX_ATTEMPTS;
});

afterEach(async () => {
  if (originalKoreHome === undefined) {
    delete process.env.KORE_HOME;
  } else {
    process.env.KORE_HOME = originalKoreHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// Re-import functions fresh per test by importing module-level after env setup.
// Since bun caches modules, we import once and rely on env reads at call time.
import {
  resolveKoreHome,
  resolveDataPath,
  resolveQueueDbPath,
  resolveQmdDbPath,
  loadConfig,
  getPort,
  getApiKey,
  getLlmProvider,
  getGeminiApiKey,
  getGeminiModel,
  getOllamaBaseUrl,
  getOllamaModel,
  getAppleNotesEnabled,
  getEmbedIntervalMs,
  getMcpEnabled,
  getConsolidationIntervalMs,
  getConsolidationCooldownDays,
  getConsolidationMaxAttempts,
} from "./config";

describe("resolveKoreHome()", () => {
  test("defaults to ~/.kore when KORE_HOME is not set", () => {
    const result = resolveKoreHome();
    expect(result).toBe(join(homedir(), ".kore"));
  });

  test("uses KORE_HOME env var when set to an absolute path", () => {
    process.env.KORE_HOME = "/custom/kore";
    expect(resolveKoreHome()).toBe("/custom/kore");
  });

  test("expands tilde in KORE_HOME env var", () => {
    process.env.KORE_HOME = "~/.my-kore";
    expect(resolveKoreHome()).toBe(join(homedir(), ".my-kore"));
  });

  test("expands bare ~ to homedir", () => {
    process.env.KORE_HOME = "~";
    expect(resolveKoreHome()).toBe(homedir());
  });
});

describe("resolveDataPath()", () => {
  test("returns $KORE_HOME/data by default", () => {
    expect(resolveDataPath()).toBe(join(homedir(), ".kore", "data"));
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveDataPath()).toBe("/opt/kore/data");
  });
});

describe("resolveQueueDbPath()", () => {
  test("returns $KORE_HOME/db/kore-queue.db by default", () => {
    expect(resolveQueueDbPath()).toBe(
      join(homedir(), ".kore", "db", "kore-queue.db"),
    );
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveQueueDbPath()).toBe("/opt/kore/db/kore-queue.db");
  });
});

describe("resolveQmdDbPath()", () => {
  test("returns $KORE_HOME/db/qmd.sqlite by default", () => {
    expect(resolveQmdDbPath()).toBe(
      join(homedir(), ".kore", "db", "qmd.sqlite"),
    );
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveQmdDbPath()).toBe("/opt/kore/db/qmd.sqlite");
  });
});

// ── loadConfig() tests ────────────────────────────────────────────────

describe("loadConfig()", () => {
  async function writeConfigJson(obj: object) {
    await Bun.write(join(tmpDir, "config.json"), JSON.stringify(obj, null, 2));
  }

  test("config.json present — values loaded as defaults", async () => {
    process.env.KORE_HOME = tmpDir;
    await writeConfigJson({
      port: 4000,
      apiKey: "test-key",
      llm: {
        provider: "gemini",
        geminiApiKey: "AIza-test",
        geminiModel: "gemini-2.0-flash",
        ollamaBaseUrl: "http://localhost:9999",
        ollamaModel: "llama3",
      },
      appleNotes: { enabled: true },
      embedIntervalMs: 60000,
      mcpEnabled: false,
      consolidation: { intervalMs: 900000, cooldownDays: 3, maxAttempts: 5 },
    });

    await loadConfig();

    expect(getPort()).toBe(4000);
    expect(getApiKey()).toBe("test-key");
    expect(getLlmProvider()).toBe("gemini");
    expect(getGeminiApiKey()).toBe("AIza-test");
    expect(getGeminiModel()).toBe("gemini-2.0-flash");
    expect(getOllamaBaseUrl()).toBe("http://localhost:9999");
    expect(getOllamaModel()).toBe("llama3");
    expect(getAppleNotesEnabled()).toBe(true);
    expect(getEmbedIntervalMs()).toBe(60000);
    expect(getMcpEnabled()).toBe(false);
    expect(getConsolidationIntervalMs()).toBe(900000);
    expect(getConsolidationCooldownDays()).toBe(3);
    expect(getConsolidationMaxAttempts()).toBe(5);
  });

  test("config.json missing — falls back to hardcoded defaults", async () => {
    process.env.KORE_HOME = tmpDir;
    // No config.json written
    await loadConfig();

    expect(getPort()).toBe(3000);
    expect(getApiKey()).toBeUndefined();
    expect(getLlmProvider()).toBe("ollama");
    expect(getGeminiApiKey()).toBeUndefined();
    expect(getGeminiModel()).toBe("gemini-2.5-flash-lite");
    expect(getOllamaBaseUrl()).toBe("http://localhost:11434");
    expect(getOllamaModel()).toBe("qwen2.5:7b");
    expect(getAppleNotesEnabled()).toBe(false);
    expect(getEmbedIntervalMs()).toBe(300_000);
    expect(getMcpEnabled()).toBe(true);
    expect(getConsolidationIntervalMs()).toBe(1_800_000);
    expect(getConsolidationCooldownDays()).toBe(7);
    expect(getConsolidationMaxAttempts()).toBe(3);
  });

  test("env var overrides config.json value", async () => {
    process.env.KORE_HOME = tmpDir;
    await writeConfigJson({
      port: 4000,
      apiKey: "from-json",
      llm: { provider: "gemini" },
    });

    process.env.KORE_PORT = "5000";
    process.env.KORE_API_KEY = "from-env";
    process.env.LLM_PROVIDER = "ollama";

    await loadConfig();

    expect(getPort()).toBe(5000);
    expect(getApiKey()).toBe("from-env");
    expect(getLlmProvider()).toBe("ollama");
  });

  test("malformed JSON throws clear error", async () => {
    process.env.KORE_HOME = tmpDir;
    await Bun.write(join(tmpDir, "config.json"), "{ not valid json }");

    await expect(loadConfig()).rejects.toThrow("contains invalid JSON");
  });

  test("partial config.json — missing keys fall back to defaults", async () => {
    process.env.KORE_HOME = tmpDir;
    await writeConfigJson({ port: 8080 });
    await loadConfig();

    expect(getPort()).toBe(8080);
    expect(getLlmProvider()).toBe("ollama"); // default
    expect(getApiKey()).toBeUndefined(); // default
  });
});

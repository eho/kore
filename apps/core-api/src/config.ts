import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { resolveKoreHome } from "@kore/qmd-client";

export { resolveKoreHome };

// ── Config JSON schema ────────────────────────────────────────────────

interface LlmConfig {
  provider?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

interface AppleNotesConfig {
  enabled?: boolean;
  syncIntervalMs?: number;
  includeHandwriting?: boolean;
  folderAllowlist?: string[];
  folderBlocklist?: string[];
  dbDirOverride?: string | null;
}

interface ConsolidationConfig {
  intervalMs?: number;
  cooldownDays?: number;
  maxAttempts?: number;
}

interface KoreConfigJson {
  koreHome?: string;
  port?: number;
  apiKey?: string;
  llm?: LlmConfig;
  appleNotes?: AppleNotesConfig;
  consolidation?: ConsolidationConfig;
  embedIntervalMs?: number;
  mcpEnabled?: boolean;
}

// ── Module-level config state ─────────────────────────────────────────

let _config: KoreConfigJson = {};

/**
 * Load config.json from $KORE_HOME. Env vars always take precedence.
 * Call once at startup before any getters are used.
 * No-op (safe to call) if config.json is absent — falls back to env vars.
 */
export async function loadConfig(): Promise<void> {
  const koreHome = resolveKoreHome();
  const configPath = join(koreHome, "config.json");

  const file = Bun.file(configPath);
  const exists = await file.exists();
  if (!exists) {
    _config = {};
    return;
  }

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config.json at ${configPath} contains invalid JSON: ${err}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config.json at ${configPath} must be a JSON object`);
  }

  _config = parsed as KoreConfigJson;
}

// ── Getters (env vars take precedence over config.json) ───────────────

export function getPort(): number {
  if (process.env.KORE_PORT) return Number(process.env.KORE_PORT);
  return _config.port ?? 3000;
}

export function getApiKey(): string | undefined {
  return process.env.KORE_API_KEY ?? _config.apiKey;
}

export function getLlmProvider(): string {
  return process.env.LLM_PROVIDER ?? _config.llm?.provider ?? "ollama";
}

export function getGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    _config.llm?.geminiApiKey
  );
}

export function getGeminiModel(): string {
  return process.env.LLM_MODEL ?? _config.llm?.geminiModel ?? "gemini-2.5-flash-lite";
}

export function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? _config.llm?.ollamaBaseUrl ?? "http://localhost:11434";
}

export function getOllamaModel(): string {
  return (
    process.env.OLLAMA_MODEL ??
    process.env.LLM_MODEL ??
    _config.llm?.ollamaModel ??
    "qwen2.5:7b"
  );
}

export function getAppleNotesEnabled(): boolean {
  if (process.env.KORE_APPLE_NOTES_ENABLED !== undefined) {
    return process.env.KORE_APPLE_NOTES_ENABLED === "true";
  }
  return _config.appleNotes?.enabled ?? false;
}

export function getEmbedIntervalMs(): number {
  if (process.env.KORE_EMBED_INTERVAL_MS) return Number(process.env.KORE_EMBED_INTERVAL_MS);
  return _config.embedIntervalMs ?? 300_000;
}

export function getMcpEnabled(): boolean {
  if (process.env.KORE_MCP_ENABLED !== undefined) {
    return process.env.KORE_MCP_ENABLED !== "false";
  }
  return _config.mcpEnabled ?? true;
}

export function getConsolidationIntervalMs(): number {
  if (process.env.CONSOLIDATION_INTERVAL_MS) return Number(process.env.CONSOLIDATION_INTERVAL_MS);
  return _config.consolidation?.intervalMs ?? 1_800_000;
}

export function getConsolidationCooldownDays(): number {
  if (process.env.CONSOLIDATION_COOLDOWN_DAYS) return Number(process.env.CONSOLIDATION_COOLDOWN_DAYS);
  return _config.consolidation?.cooldownDays ?? 7;
}

export function getConsolidationMaxAttempts(): number {
  if (process.env.CONSOLIDATION_MAX_ATTEMPTS) return Number(process.env.CONSOLIDATION_MAX_ATTEMPTS);
  return _config.consolidation?.maxAttempts ?? 3;
}

// ── Path helpers ──────────────────────────────────────────────────────

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

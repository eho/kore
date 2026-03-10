export const API_URL = process.env.KORE_API_URL ?? "http://localhost:3000";
export const API_KEY = process.env.KORE_API_KEY ?? "";

export function warnIfNoApiKey(): void {
  if (!API_KEY) {
    process.stderr.write(
      "Warning: KORE_API_KEY not set. Authenticated endpoints will fail.\n"
    );
  }
}

/**
 * Masks an API key for display, e.g. "kore_abc123xyz" → "kore_***...***xyz"
 */
export function maskApiKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "***";
  const prefix = key.slice(0, 5);
  const suffix = key.slice(-3);
  return `${prefix}***...***${suffix}`;
}

/**
 * Returns the path of the .env file that Bun would auto-load (cwd/.env), if it exists.
 */
export async function resolvedEnvPath(): Promise<string | null> {
  const envPath = `${process.cwd()}/.env`;
  const file = Bun.file(envPath);
  const exists = await file.exists();
  return exists ? envPath : null;
}

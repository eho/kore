import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

/**
 * Resolves `KORE_HOME` by checking, in order:
 * 1. The `KORE_HOME` environment variable (if exported)
 * 2. `KORE_HOME=…` in a `.env` file found by walking up from cwd
 * 3. The fallback default `~/.kore`
 *
 * Mirrors the Swift ConfigManager.resolveKoreHome() logic.
 */
export function resolveKoreHome(): string {
  const envVal = process.env.KORE_HOME;
  if (envVal) {
    return expandTilde(envVal);
  }

  const fromDotEnv = readDotEnvValue("KORE_HOME");
  if (fromDotEnv) {
    return expandTilde(fromDotEnv);
  }

  return join(homedir(), ".kore");
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return resolve(p);
}

/**
 * Reads a value from a `.env` file by walking up from cwd.
 * Stops at the first `.env` that contains the key. Returns null
 * if no `.env` is found or the key is absent.
 *
 * Only plain `KEY=VALUE` lines are supported (no export, no interpolation).
 */
function readDotEnvValue(key: string): string | null {
  let dir = process.cwd();
  const prefix = `${key}=`;

  for (let i = 0; i < 10; i++) {
    const envPath = join(dir, ".env");
    try {
      const contents = require("fs").readFileSync(envPath, "utf-8") as string;
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith(prefix)) {
          const value = trimmed.slice(prefix.length).trim();
          // Strip optional surrounding quotes
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            return value.slice(1, -1);
          }
          return value;
        }
      }
    } catch {
      // .env doesn't exist at this level, keep walking
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

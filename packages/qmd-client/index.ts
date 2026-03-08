/**
 * QMD Client - Typed wrapper around the QMD CLI.
 *
 * Wraps `qmd` CLI commands via `Bun.spawn` with typed inputs/outputs
 * and graceful error handling.
 */

export interface QmdStatusResult {
  online: boolean;
  error?: string;
}

export interface QmdCommandResult {
  success: boolean;
  error?: string;
}

/** Spawner abstraction for testing — defaults to Bun.spawn. */
export type SpawnFn = (
  cmd: string[]
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to spawn "${cmd[0]}": ${message}`);
  }
};

let _spawn: SpawnFn = defaultSpawn;

/**
 * Override the spawn function (for testing).
 * Returns a restore function that resets to the default.
 */
export function setSpawn(fn: SpawnFn): () => void {
  _spawn = fn;
  return () => {
    _spawn = defaultSpawn;
  };
}

/**
 * Trigger `qmd update` to refresh the index.
 */
export async function update(): Promise<QmdCommandResult> {
  try {
    const result = await _spawn(["qmd", "update"]);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `qmd update exited with code ${result.exitCode}`,
      };
    }
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run `qmd collection add <path> --name <name>`.
 */
export async function collectionAdd(
  path: string,
  name: string
): Promise<QmdCommandResult> {
  try {
    const result = await _spawn([
      "qmd",
      "collection",
      "add",
      path,
      "--name",
      name,
    ]);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error:
          result.stderr.trim() ||
          `qmd collection add exited with code ${result.exitCode}`,
      };
    }
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run `qmd status` and return a typed result indicating if QMD is responsive.
 */
export async function status(): Promise<QmdStatusResult> {
  try {
    const result = await _spawn(["qmd", "status"]);
    if (result.exitCode !== 0) {
      return {
        online: false,
        error:
          result.stderr.trim() ||
          `qmd status exited with code ${result.exitCode}`,
      };
    }
    return { online: true };
  } catch (err: unknown) {
    return {
      online: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * QMD Client - Typed wrapper around the QMD CLI.
 *
 * Stub implementation for US-005. Full implementation in US-008.
 */

export interface QmdStatusResult {
  online: boolean;
  error?: string;
}

export interface QmdCommandResult {
  success: boolean;
  error?: string;
}

/**
 * Trigger `qmd update` to refresh the index.
 */
export async function update(): Promise<QmdCommandResult> {
  // Stub: full Bun.spawn implementation in US-008
  return { success: true };
}

/**
 * Run `qmd collection add <path> --name <name>`.
 */
export async function collectionAdd(
  path: string,
  name: string
): Promise<QmdCommandResult> {
  // Stub: full Bun.spawn implementation in US-008
  return { success: true };
}

/**
 * Run `qmd status` and return a typed result.
 */
export async function status(): Promise<QmdStatusResult> {
  // Stub: full Bun.spawn implementation in US-008
  return { online: false, error: "stub: not implemented" };
}

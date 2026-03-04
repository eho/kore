/**
 * Utility functions for Apple Notes Exporter.
 */

/** Offset in seconds between Unix epoch (1970-01-01) and Mac Absolute Time epoch (2001-01-01). */
export const CORETIME_OFFSET = 978307200;

/**
 * Convert an Apple CoreData timestamp (Mac Absolute Time, seconds since 2001-01-01)
 * to a Unix timestamp in milliseconds.
 */
export function decodeTime(timestamp: number | null | undefined): number {
  if (!timestamp || timestamp < 1) return Date.now();
  return Math.floor((timestamp + CORETIME_OFFSET) * 1000);
}

/**
 * Sanitize a string to be safe for use as a filename.
 * Removes characters that are invalid on macOS/Linux/Windows.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a file path into its name (without extension) and extension.
 * e.g., "photo.jpeg" → ["photo", "jpeg"]
 */
export function splitExt(filename: string): [string, string] {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return [filename, ''];
  return [filename.slice(0, dotIndex), filename.slice(dotIndex + 1)];
}

/**
 * Convert a Uint8Array UUID to a hex string.
 */
export function uuidToHex(uuid: Uint8Array): string {
  return Buffer.from(uuid).toString('hex');
}

/**
 * Convert color channels (0-1 float) to a CSS hex color string.
 */
export function colorToHex(red: number, green: number, blue: number): string {
  const r = Math.floor(red * 255).toString(16).padStart(2, '0');
  const g = Math.floor(green * 255).toString(16).padStart(2, '0');
  const b = Math.floor(blue * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

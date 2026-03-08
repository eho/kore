/**
 * Slugify a string per data_schema.md §1.1:
 * Lowercase, replace whitespace/special chars with _, strip non-alnum except _,
 * collapse consecutive underscores, truncate to 50 chars.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s\W]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);
}

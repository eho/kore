/**
 * Slugify a string per data_schema.md §1.1:
 * Lowercase, replace whitespace/special chars with -, strip non-alnum except -,
 * collapse consecutive hyphens, truncate to 50 chars.
 *
 * Uses hyphens to match QMD's internal handelize() normalization, so on-disk
 * filenames align with the virtual paths QMD returns in search results.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s\W]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

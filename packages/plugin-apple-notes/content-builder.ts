const MAX_CONTENT_LENGTH = 8_000;
const TRUNCATION_NOTICE = "\n\n[Content truncated for extraction]";
const LOCAL_ATTACHMENT_RE = /!\[(?:[^\]]*)\]\(\.\.\/attachments\/([^)]+)\)/g;

/**
 * Extracts folder hierarchy from a relative note path.
 * e.g. "notes/Work/Projects/Q1 Planning.md" → "Work / Projects"
 * Returns null if the note is at the root (no intermediate folders).
 */
export function extractFolderHierarchy(relativePath: string): string | null {
  // Split path, remove first segment ("notes") and last segment (filename)
  const segments = relativePath.split("/");
  if (segments.length <= 2) return null; // root-level note, no folder hierarchy
  const folders = segments.slice(1, -1); // skip "notes" prefix and filename
  return folders.join(" / ");
}

/**
 * Strips local attachment image references and replaces with [Attachment: filename].
 * Preserves URL-based images.
 */
export function stripLocalAttachments(content: string): string {
  return content.replace(LOCAL_ATTACHMENT_RE, (_match, filename) => {
    // Decode URI-encoded filenames for readability
    const decodedName = decodeURIComponent(filename);
    return `[Attachment: ${decodedName}]`;
  });
}

/**
 * Transforms an exported Apple Notes Markdown file into LLM-ready content.
 *
 * @param absoluteNotePath - Absolute filesystem path to the note file
 * @param relativeNotePath - Relative path from the staging directory (e.g., "notes/Work/Projects/Q1 Planning.md")
 * @param title - Note title from the manifest (sourced from ZTITLE1 in Apple Notes DB)
 * @returns LLM-ready content string, or null if the file is empty/unreadable
 */
export async function buildIngestContent(
  absoluteNotePath: string,
  relativeNotePath: string,
  title?: string,
): Promise<string | null> {
  let raw: string;
  try {
    const file = Bun.file(absoluteNotePath);
    raw = await file.text();
  } catch {
    return null;
  }

  if (!raw || raw.trim().length === 0) {
    return null;
  }

  // Build header lines
  const headerLines: string[] = [];

  const folder = extractFolderHierarchy(relativeNotePath);
  if (folder) {
    headerLines.push(`Apple Notes Folder: ${folder}`);
  }

  if (title) {
    headerLines.push(`Title: ${title}`);
  }

  const header = headerLines.length > 0 ? headerLines.join("\n") + "\n\n" : "";

  // Process body: strip local attachments
  let body = stripLocalAttachments(raw);

  // Enforce character limit (accounting for header length)
  const availableBodyLength = MAX_CONTENT_LENGTH - header.length - TRUNCATION_NOTICE.length;
  let truncated = false;

  if (header.length + body.length > MAX_CONTENT_LENGTH) {
    body = body.slice(0, availableBodyLength);
    truncated = true;
  }

  let result = header + body;
  if (truncated) {
    result += TRUNCATION_NOTICE;
  }

  return result;
}

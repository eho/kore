/**
 * Attachment Resolution & File Copying.
 *
 * Resolves inline attachments from Apple Notes into Markdown.
 * Handles all attachment types: hashtags, mentions, URL cards, internal links,
 * tables, scans, drawings, and general media files.
 *
 * Ported from obsidian-importer's apple-notes.ts resolveAttachment (MIT License).
 */

import type { Database } from 'bun:sqlite';
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type {
  ANAttachmentInfo,
  EntityKeys,
  AttachmentRow,
  ANNote,
} from './types.ts';
import { ANAttachmentUTI } from './types.ts';
import { queryOne } from './db.ts';
import { decodeMergeableData } from './decoder.ts';
import { convertTableToMarkdown } from './table-converter.ts';
import { convertNoteToMarkdown } from './converter.ts';
import { convertScanToMarkdown } from './scan-converter.ts';
import { splitExt } from './utils.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const NOTE_FOLDER_PATH = 'Library/Group Containers/group.com.apple.notes';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Options for the attachment resolver.
 */
export type AttachmentResolverOptions = {
  db: Database;
  entityKeys: EntityKeys;
  accountPath: string;
  exportDest: string;
  /** Callback to resolve an internal note link UUID to a note title. */
  resolveNoteLink?: (uuid: string) => string | undefined;
  /** Whether to include handwriting OCR summaries. */
  includeHandwriting?: boolean;
};

/**
 * Create a resolveAttachment callback suitable for `ConverterOptions`.
 * This is a factory that closures over the DB/path context.
 */
export function createAttachmentResolver(
  opts: AttachmentResolverOptions,
): (info: ANAttachmentInfo) => Promise<string> {
  return (info: ANAttachmentInfo) => resolveAttachment(info, opts);
}

/**
 * Resolve an attachment to its Markdown representation.
 *
 * Dispatches on the attachment's `typeUti` to handle each type:
 * - Hashtag / Mention → plain text from ZALTTEXT
 * - InternalLink → [[Note Title]] via ZTOKENCONTENTIDENTIFIER
 * - Table → decode CRDT, convert to Markdown table
 * - UrlCard → [**Title**](url)
 * - Scan → decode CRDT, resolve scan pages
 * - ModifiedScan / Drawing → copy from FallbackPDFs / FallbackImages
 * - Default → copy from Media/
 */
async function resolveAttachment(
  info: ANAttachmentInfo,
  opts: AttachmentResolverOptions,
): Promise<string> {
  const { db, entityKeys, accountPath, exportDest, resolveNoteLink, includeHandwriting } = opts;

  switch (info.typeUti) {
    case ANAttachmentUTI.Hashtag:
    case ANAttachmentUTI.Mention: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT ZALTTEXT FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      return row?.ZALTTEXT ?? '';
    }

    case ANAttachmentUTI.InternalLink: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT ZTOKENCONTENTIDENTIFIER FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      if (!row?.ZTOKENCONTENTIDENTIFIER) return '';
      const title = resolveNoteLink?.(row.ZTOKENCONTENTIDENTIFIER);
      return title ? `[[${title}]]` : `[[${row.ZTOKENCONTENTIDENTIFIER}]]`;
    }

    case ANAttachmentUTI.Table: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT hex(zmergeabledata1) as ZHEXDATA FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      if (!row?.ZHEXDATA) return '**(empty table)**';
      const proto = decodeMergeableData(row.ZHEXDATA);
      const cellConverter = async (note: ANNote): Promise<string> => {
        return convertNoteToMarkdown(note, { omitFirstLine: false });
      };
      return convertTableToMarkdown(proto, cellConverter);
    }

    case ANAttachmentUTI.UrlCard: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT ZTITLE, ZURLSTRING FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      if (!row?.ZURLSTRING) return '';
      const title = row.ZTITLE ?? row.ZURLSTRING;
      return `[**${title}**](${row.ZURLSTRING})`;
    }

    case ANAttachmentUTI.Scan: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT hex(zmergeabledata1) as ZHEXDATA FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      if (!row?.ZHEXDATA) return '**(empty scan)**';
      const proto = decodeMergeableData(row.ZHEXDATA);
      return convertScanToMarkdown(proto, db, entityKeys, accountPath, exportDest);
    }

    case ANAttachmentUTI.ModifiedScan: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT Z_PK, ZIDENTIFIER, ZFALLBACKPDFGENERATION, ZHANDWRITINGSUMMARY,
                ZCREATIONDATE, ZMODIFICATIONDATE, ZNOTE
         FROM (SELECT *, NULL AS ZFALLBACKPDFGENERATION, NULL AS ZHANDWRITINGSUMMARY FROM ziccloudsyncingobject)
         WHERE Z_ENT = ? AND ZIDENTIFIER = ?`,
        entityKeys.ICAttachment,
        info.attachmentIdentifier,
      );
      if (!row) return '**(unknown attachment: modified scan)**';
      const sourcePath = buildAttachmentSourcePath(ANAttachmentUTI.ModifiedScan, row);
      const link = await copyAttachmentFile(sourcePath, accountPath, exportDest, 'Scan.pdf');
      return withHandwriting(link ?? '**(error reading attachment)**', row, includeHandwriting);
    }

    case ANAttachmentUTI.Drawing:
    case ANAttachmentUTI.DrawingLegacy:
    case ANAttachmentUTI.DrawingLegacy2: {
      const row = queryOne<AttachmentRow>(
        db,
        `SELECT Z_PK, ZIDENTIFIER, ZFALLBACKIMAGEGENERATION, ZHANDWRITINGSUMMARY,
                ZCREATIONDATE, ZMODIFICATIONDATE, ZNOTE
         FROM (SELECT *, NULL AS ZFALLBACKIMAGEGENERATION, NULL AS ZHANDWRITINGSUMMARY FROM ziccloudsyncingobject)
         WHERE Z_ENT = ? AND ZIDENTIFIER = ?`,
        entityKeys.ICAttachment,
        info.attachmentIdentifier,
      );
      if (!row) return '**(unknown attachment: drawing)**';
      const sourcePath = buildAttachmentSourcePath(ANAttachmentUTI.Drawing, row);
      const ext = row.ZFALLBACKIMAGEGENERATION ? 'png' : 'jpg';
      const link = await copyAttachmentFile(sourcePath, accountPath, exportDest, `Drawing.${ext}`);
      return withHandwriting(link ?? '**(error reading attachment)**', row, includeHandwriting);
    }

    default: {
      // General file attachment (image, audio, video, pdf, vcard, etc.)
      const attachRow = queryOne<AttachmentRow>(
        db,
        `SELECT ZMEDIA FROM ziccloudsyncingobject WHERE zidentifier = ?`,
        info.attachmentIdentifier,
      );
      if (!attachRow?.ZMEDIA) return ` **(unknown attachment: ${info.typeUti})** `;

      const mediaRow = queryOne<AttachmentRow>(
        db,
        `SELECT a.ZIDENTIFIER as ZIDENTIFIER, a.ZFILENAME as ZFILENAME,
                a.ZGENERATION1 as ZGENERATION1, b.ZCREATIONDATE as ZCREATIONDATE,
                b.ZMODIFICATIONDATE as ZMODIFICATIONDATE, b.ZNOTE as ZNOTE
         FROM (SELECT *, NULL AS ZGENERATION1 FROM ziccloudsyncingobject) AS a,
              ziccloudsyncingobject AS b
         WHERE a.Z_ENT = ? AND a.Z_PK = ? AND a.Z_PK = b.ZMEDIA`,
        entityKeys.ICMedia,
        attachRow.ZMEDIA,
      );
      if (!mediaRow?.ZFILENAME) return ` **(unknown attachment: ${info.typeUti})** `;

      const sourcePath = buildAttachmentSourcePath('default', mediaRow);
      const link = await copyAttachmentFile(
        sourcePath,
        accountPath,
        exportDest,
        mediaRow.ZFILENAME,
      );
      return link ?? '**(error reading attachment)**';
    }
  }
}

// ─── Source Path Construction ────────────────────────────────────────────────

/**
 * Build the on-disk source path for an attachment based on its type.
 *
 * @param uti - The attachment UTI or 'default' for general media.
 * @param row - Partial attachment row with the needed fields.
 * @returns Relative path within the Apple Notes data container.
 */
export function buildAttachmentSourcePath(
  uti: ANAttachmentUTI | 'default',
  row: Partial<AttachmentRow>,
): string {
  switch (uti) {
    case ANAttachmentUTI.ModifiedScan:
      return join(
        'FallbackPDFs',
        row.ZIDENTIFIER ?? '',
        row.ZFALLBACKPDFGENERATION ?? '',
        'FallbackPDF.pdf',
      );

    case ANAttachmentUTI.Scan:
      return join(
        'Previews',
        `${row.ZIDENTIFIER ?? ''}-1-${row.ZSIZEWIDTH ?? 0}x${row.ZSIZEHEIGHT ?? 0}-0.jpeg`,
      );

    case ANAttachmentUTI.Drawing:
    case ANAttachmentUTI.DrawingLegacy:
    case ANAttachmentUTI.DrawingLegacy2:
      if (row.ZFALLBACKIMAGEGENERATION) {
        // macOS 14 / iOS 17 and above
        return join(
          'FallbackImages',
          row.ZIDENTIFIER ?? '',
          row.ZFALLBACKIMAGEGENERATION,
          'FallbackImage.png',
        );
      }
      // Older macOS
      return join('FallbackImages', `${row.ZIDENTIFIER ?? ''}.jpg`);

    default:
      // General media: Media/<IDENTIFIER>/<GENERATION>/<FILENAME>
      return join(
        'Media',
        row.ZIDENTIFIER ?? '',
        row.ZGENERATION1 ?? '',
        row.ZFILENAME ?? '',
      );
  }
}

// ─── File Copying ────────────────────────────────────────────────────────────

/**
 * Copy an attachment file from the Apple Notes container to the export directory.
 *
 * Tries the account-specific path first, then falls back to the global path.
 *
 * @param sourcePath - Relative path within the Apple Notes data container.
 * @param accountPath - Absolute path to the account's data directory.
 * @param exportDest - Absolute path to the export destination directory.
 * @param outFilename - Desired filename in the attachments directory.
 * @returns Markdown image/link string, or null if the file could not be found.
 */
export async function copyAttachmentFile(
  sourcePath: string,
  accountPath: string,
  exportDest: string,
  outFilename: string,
): Promise<string | null> {
  const binary = getAttachmentBinary(accountPath, sourcePath);
  if (!binary) return null;

  // Ensure unique filename in attachments directory
  const attachmentsDir = join(exportDest, 'attachments');
  mkdirSync(attachmentsDir, { recursive: true });

  const uniqueName = getUniqueFilename(attachmentsDir, outFilename);
  const destPath = join(attachmentsDir, uniqueName);

  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(destPath, binary);
  } catch {
    return null;
  }

  const [, ext] = splitExt(uniqueName);
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(
    ext.toLowerCase(),
  );

  return isImage
    ? `![](attachments/${uniqueName})`
    : `[${uniqueName}](attachments/${uniqueName})`;
}

/**
 * Read an attachment binary from disk, trying account path first then global path.
 */
export function getAttachmentBinary(
  accountPath: string,
  sourcePath: string,
): Buffer | null {
  const accountFullPath = join(accountPath, sourcePath);
  if (existsSync(accountFullPath)) {
    try {
      return readFileSync(accountFullPath) as Buffer;
    } catch {
      // Fall through to global path
    }
  }

  const globalPath = join(homedir(), NOTE_FOLDER_PATH, sourcePath);
  if (existsSync(globalPath)) {
    try {
      return readFileSync(globalPath) as Buffer;
    } catch {
      return null;
    }
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get a unique filename in the target directory, appending a number if needed.
 */
function getUniqueFilename(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return filename;

  const [name, ext] = splitExt(filename);
  let counter = 1;
  let unique = ext ? `${name} ${counter}.${ext}` : `${name} ${counter}`;

  while (existsSync(join(dir, unique))) {
    counter++;
    unique = ext ? `${name} ${counter}.${ext}` : `${name} ${counter}`;
  }

  return unique;
}

/**
 * Append handwriting OCR summary if enabled and present.
 */
function withHandwriting(
  link: string,
  row: Partial<AttachmentRow>,
  includeHandwriting?: boolean,
): string {
  if (!includeHandwriting || !row.ZHANDWRITINGSUMMARY) return link;
  const summary = row.ZHANDWRITINGSUMMARY.replace(/\n/g, '\n> ');
  return `\n> [!Handwriting]-\n> ${summary}${link}`;
}

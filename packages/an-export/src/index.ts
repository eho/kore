/**
 * Apple Notes Exporter — Public Library API
 *
 * Usage:
 *   import { exportNotes, syncNotes } from 'an-export';
 *   await exportNotes({ dest: './my-notes' });
 *   await syncNotes({ dest: './my-notes' });
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExportOptions,
  SyncOptions,
  ExportResult,
  NoteRow,
  EntityKeys,
  ANAccount,
  ResolvedFolder,
  AccountRow,
} from './types.ts';
import type { Database } from 'bun:sqlite';
import { openNotesDatabase, queryAll, queryOne } from './db.ts';
import { decodeNoteData } from './decoder.ts';
import { convertNoteToMarkdown } from './converter.ts';
import { createAttachmentResolver } from './attachments.ts';
import { resolveAccounts, resolveFolders } from './folders.ts';
import {
  createEmptyManifest,
  loadManifest,
  saveManifest,
  computeNoteSyncDecisions,
  applyDeletions,
  buildNoteManifestEntry,
} from './sync.ts';
import { sanitizeFileName } from './utils.ts';

export type { ExportOptions, SyncOptions, ExportResult, SyncManifest } from './types.ts';
export { decodeTime, sanitizeFileName } from './utils.ts';

// ─── Note Query ──────────────────────────────────────────────────────────────

/** SQL to query all notes with their content blobs. */
const NOTES_QUERY = `
  SELECT
    nd.z_pk AS Z_PK,
    hex(nd.zdata) AS ZHEXDATA,
    zcso.ztitle1 AS ZTITLE1,
    zcso.zfolder AS ZFOLDER,
    zcso.zcreationdate1 AS ZCREATIONDATE1,
    zcso.zmodificationdate1 AS ZMODIFICATIONDATE1,
    zcso.zispasswordprotected AS ZISPASSWORDPROTECTED,
    zcso.zidentifier AS ZIDENTIFIER
  FROM
    zicnotedata AS nd,
    ziccloudsyncingobject AS zcso
  WHERE
    zcso.z_ent = ? AND zcso.z_pk = nd.znote
`;

// ─── Internal: Note Link Resolver ────────────────────────────────────────────

function buildNoteLinkResolver(
  db: Database,
  entityKeys: EntityKeys,
): (uuid: string) => string | undefined {
  return (uuid: string): string | undefined => {
    const row = queryOne<{ ZTITLE1: string }>(
      db,
      `SELECT ZTITLE1 FROM ziccloudsyncingobject WHERE Z_ENT = ? AND ZIDENTIFIER = ?`,
      entityKeys.ICNote,
      uuid,
    );
    return row?.ZTITLE1 ?? undefined;
  };
}

// ─── Internal: Build Account Lookup ──────────────────────────────────────────

/**
 * Build a Map from account Z_PK → ANAccount for quick lookup by folder owner.
 */
function buildAccountByPk(
  db: Database,
  entityKeys: EntityKeys,
  accounts: ANAccount[],
): Map<number, ANAccount> {
  const rows = queryAll<AccountRow>(
    db,
    'SELECT Z_PK, ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?',
    entityKeys.ICAccount,
  );
  const map = new Map<number, ANAccount>();
  for (const row of rows) {
    const account = accounts.find((a) => a.uuid === row.ZIDENTIFIER);
    if (account) map.set(row.Z_PK, account);
  }
  return map;
}

// ─── Internal: Export a Single Note ──────────────────────────────────────────

type ExportNoteContext = {
  db: Database;
  entityKeys: EntityKeys;
  accounts: ANAccount[];
  accountByPk: Map<number, ANAccount>;
  folderMap: Map<number, ResolvedFolder>;
  exportDest: string;
  resolveNoteLink: (uuid: string) => string | undefined;
  options: ExportOptions;
};

/**
 * Export a single note: decode, convert to Markdown, write to disk.
 * Returns the absolute path of the written .md file, or null if failed.
 */
async function exportSingleNote(
  noteRow: NoteRow,
  ctx: ExportNoteContext,
): Promise<{ filePath: string } | null> {
  const { db, entityKeys, accounts, accountByPk, folderMap, exportDest, resolveNoteLink, options } =
    ctx;

  // Decode protobuf
  const doc = decodeNoteData(noteRow.ZHEXDATA);
  if (!doc?.note) return null;

  // Resolve folder output path
  const folder = folderMap.get(noteRow.ZFOLDER);
  const outputDir = folder?.outputPath ?? exportDest;

  // Determine account path for attachment resolution
  const ownerAccount = folder ? accountByPk.get(folder.ownerAccountId) : undefined;
  const accountPath = ownerAccount?.path ?? accounts[0]?.path ?? '';

  // Create attachment resolver
  const resolveAttachment = createAttachmentResolver({
    db,
    entityKeys,
    accountPath,
    exportDest,
    resolveNoteLink,
    includeHandwriting: options.includeHandwriting,
    dbDir: options.dbDir,
    outputDir,
  });

  // Build filename from title
  const title = noteRow.ZTITLE1 || 'Untitled';
  const filename = `${sanitizeFileName(title)}.md`;

  // Apple Notes strips URLs into just the title if they're the only thing on the first line.
  // We should preserve the URL in the markdown body.
  const isUrlTitle = title.startsWith('http://') || title.startsWith('https://');

  // Convert to Markdown
  const markdown = await convertNoteToMarkdown(doc.note, {
    omitFirstLine: isUrlTitle ? false : (options.omitFirstLine ?? true),
    resolveAttachment,
    resolveNoteLink,
  });

  const filePath = join(outputDir, filename);

  // Write the markdown file
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(filePath, markdown, 'utf-8');

  return { filePath };
}

// ─── Shared: Run export pipeline ─────────────────────────────────────────────

type PipelineResult = {
  result: ExportResult;
};

async function runExportPipeline(
  options: ExportOptions,
  isSync: boolean,
  onProgress?: (message: string) => void,
): Promise<ExportResult> {
  const { dest } = options;
  mkdirSync(dest, { recursive: true });

  const { db, entityKeys, close } = openNotesDatabase(options.dbDir);

  try {
    const accounts = resolveAccounts(db, entityKeys, options.dbDir);
    const folderMap = resolveFolders(db, entityKeys, accounts, dest, {
      includeTrashed: options.includeTrashed,
    });
    const resolveNoteLink = buildNoteLinkResolver(db, entityKeys);
    const accountByPk = buildAccountByPk(db, entityKeys, accounts);

    // Load or create manifest
    const manifest = isSync ? loadManifest(dest) : createEmptyManifest();

    // Query all notes
    const noteRows = queryAll<NoteRow>(db, NOTES_QUERY, entityKeys.ICNote);

    // Compute sync decisions (for sync mode) or treat all as "new" (for export mode)
    const decisions = isSync
      ? computeNoteSyncDecisions(noteRows, manifest)
      : noteRows.map((nr) => ({
          zpk: nr.Z_PK,
          action: 'new' as const,
          noteRow: nr,
        }));

    const result: ExportResult = { exported: 0, skipped: 0, deleted: 0, failed: [] };

    for (const decision of decisions) {
      if (decision.action === 'deleted') continue; // handled below
      if (decision.action === 'unchanged') {
        result.skipped++;
        continue;
      }

      const noteRow = decision.noteRow;
      if (!noteRow) continue;

      // Skip password-protected notes
      if (noteRow.ZISPASSWORDPROTECTED === 1) {
        onProgress?.(`⚠ Skipping password-protected note: ${noteRow.ZTITLE1 ?? 'Untitled'}`);
        result.skipped++;
        continue;
      }

      try {
        const exported = await exportSingleNote(noteRow, {
          db,
          entityKeys,
          accounts,
          accountByPk,
          folderMap,
          exportDest: dest,
          resolveNoteLink,
          options,
        });

        if (exported) {
          manifest.notes[noteRow.Z_PK] = buildNoteManifestEntry(dest, exported.filePath, noteRow);
          result.exported++;
          const verb = decision.action === 'new' ? 'Exported' : 'Updated';
          onProgress?.(
            `${verb} ${result.exported}/${noteRows.length}: ${noteRow.ZTITLE1 ?? 'Untitled'}`,
          );
        } else {
          result.failed.push(noteRow.ZTITLE1 ?? `Note Z_PK=${noteRow.Z_PK}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed.push(`${noteRow.ZTITLE1 ?? 'Untitled'}: ${msg}`);
      }
    }

    // Apply deletions (only meaningful in sync mode)
    if (isSync) {
      const deleted = applyDeletions(dest, decisions, manifest, 'notes');
      result.deleted = deleted;
      if (deleted > 0) {
        onProgress?.(`Deleted ${deleted} removed note(s)`);
      }
    }

    // Save manifest
    saveManifest(dest, manifest);

    return result;
  } finally {
    close();
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Export all Apple Notes to Markdown files in the specified destination directory.
 */
export async function exportNotes(
  options: ExportOptions,
  onProgress?: (message: string) => void,
): Promise<ExportResult> {
  return runExportPipeline(options, false, onProgress);
}

/**
 * Sync Apple Notes — incremental export that only processes new/updated notes
 * and deletes notes that were removed from Apple Notes.
 */
export async function syncNotes(
  options: SyncOptions,
  onProgress?: (message: string) => void,
): Promise<ExportResult> {
  return runExportPipeline(options, true, onProgress);
}

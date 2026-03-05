/**
 * Sync Manifest & Incremental Sync.
 *
 * Manages the sync manifest (an-export-manifest.json) and implements
 * incremental sync logic: detect new, updated, unchanged, and deleted notes.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  SyncManifest,
  ManifestNoteEntry,
  ManifestAttachmentEntry,
  NoteRow,
} from './types.ts';
import { decodeTime } from './utils.ts';

/** The manifest filename, stored in the export root directory. */
export const MANIFEST_FILENAME = 'an-export-manifest.json';

// ─── Sync Decision Types ─────────────────────────────────────────────────────

export type SyncAction = 'new' | 'updated' | 'unchanged' | 'deleted';

export type NoteSyncDecision = {
  zpk: number;
  action: SyncAction;
  /** The DB row, present for new/updated/unchanged */
  noteRow?: NoteRow;
  /** The existing manifest entry, present for updated/unchanged/deleted */
  manifestEntry?: ManifestNoteEntry;
};

export type AttachmentSyncDecision = {
  zpk: number;
  action: SyncAction;
  manifestEntry?: ManifestAttachmentEntry;
};

// ─── Manifest I/O ────────────────────────────────────────────────────────────

/**
 * Create a fresh, empty sync manifest.
 */
export function createEmptyManifest(): SyncManifest {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: {},
    attachments: {},
  };
}

/**
 * Load an existing sync manifest from the export root.
 * Returns a fresh empty manifest if the file doesn't exist.
 */
export function loadManifest(exportDest: string): SyncManifest {
  const manifestPath = join(exportDest, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return createEmptyManifest();
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as SyncManifest;

  // Basic validation
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported manifest version: ${parsed.version}. Expected version 1.`,
    );
  }

  return parsed;
}

/**
 * Write the sync manifest to the export root.
 */
export function saveManifest(exportDest: string, manifest: SyncManifest): void {
  const manifestPath = join(exportDest, MANIFEST_FILENAME);
  manifest.exportedAt = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

// ─── Sync Decisions ──────────────────────────────────────────────────────────

/**
 * Compare current DB notes against the existing manifest to determine
 * which notes are new, updated, unchanged, or deleted.
 *
 * @param dbNotes    Array of NoteRow objects from the current DB query.
 * @param manifest   The existing sync manifest.
 * @returns          An array of sync decisions for each note.
 */
export function computeNoteSyncDecisions(
  dbNotes: NoteRow[],
  manifest: SyncManifest,
): NoteSyncDecision[] {
  const decisions: NoteSyncDecision[] = [];
  const seenPks = new Set<number>();

  for (const noteRow of dbNotes) {
    const zpk = noteRow.Z_PK;
    seenPks.add(zpk);

    const existing = manifest.notes[zpk];
    if (!existing) {
      // New note — not in manifest
      decisions.push({ zpk, action: 'new', noteRow });
    } else {
      // Compare modification times
      const dbMtime = decodeTime(noteRow.ZMODIFICATIONDATE1);
      if (dbMtime > existing.mtime) {
        decisions.push({
          zpk,
          action: 'updated',
          noteRow,
          manifestEntry: existing,
        });
      } else {
        decisions.push({
          zpk,
          action: 'unchanged',
          noteRow,
          manifestEntry: existing,
        });
      }
    }
  }

  // Notes in manifest but no longer in DB → deleted
  for (const zpkStr of Object.keys(manifest.notes)) {
    const zpk = Number(zpkStr);
    if (!seenPks.has(zpk)) {
      decisions.push({
        zpk,
        action: 'deleted',
        manifestEntry: manifest.notes[zpk],
      });
    }
  }

  return decisions;
}

/**
 * Compare current DB attachments against the existing manifest to determine
 * which attachments are new, updated, unchanged, or deleted.
 *
 * @param dbAttachmentPks  Array of { Z_PK, ZMODIFICATIONDATE } from DB.
 * @param manifest         The existing sync manifest.
 * @returns                An array of sync decisions for each attachment.
 */
export function computeAttachmentSyncDecisions(
  dbAttachments: Array<{ Z_PK: number; ZMODIFICATIONDATE: number | null }>,
  manifest: SyncManifest,
): AttachmentSyncDecision[] {
  const decisions: AttachmentSyncDecision[] = [];
  const seenPks = new Set<number>();

  for (const att of dbAttachments) {
    const zpk = att.Z_PK;
    seenPks.add(zpk);

    const existing = manifest.attachments[zpk];
    if (!existing) {
      decisions.push({ zpk, action: 'new' });
    } else {
      const dbMtime = decodeTime(att.ZMODIFICATIONDATE);
      if (dbMtime > existing.mtime) {
        decisions.push({ zpk, action: 'updated', manifestEntry: existing });
      } else {
        decisions.push({ zpk, action: 'unchanged', manifestEntry: existing });
      }
    }
  }

  // Attachments in manifest but no longer in DB → deleted
  for (const zpkStr of Object.keys(manifest.attachments)) {
    const zpk = Number(zpkStr);
    if (!seenPks.has(zpk)) {
      decisions.push({
        zpk,
        action: 'deleted',
        manifestEntry: manifest.attachments[zpk],
      });
    }
  }

  return decisions;
}

// ─── Manifest Entry Builders ─────────────────────────────────────────────────

/**
 * Build a ManifestNoteEntry for a successfully exported note.
 *
 * @param exportDest  The export root directory (for computing relative paths).
 * @param filePath    The absolute path to the exported .md file.
 * @param noteRow     The note's database row.
 * @returns           A ManifestNoteEntry to store in the manifest.
 */
export function buildNoteManifestEntry(
  exportDest: string,
  filePath: string,
  noteRow: NoteRow,
): ManifestNoteEntry {
  return {
    path: relative(exportDest, filePath),
    mtime: decodeTime(noteRow.ZMODIFICATIONDATE1),
    identifier: noteRow.ZIDENTIFIER ?? '',
  };
}

/**
 * Build a ManifestAttachmentEntry for a successfully exported attachment.
 */
export function buildAttachmentManifestEntry(
  exportDest: string,
  filePath: string,
  mtime: number,
): ManifestAttachmentEntry {
  return {
    path: relative(exportDest, filePath),
    mtime,
  };
}

// ─── Deletion ────────────────────────────────────────────────────────────────

/**
 * Delete exported files for notes/attachments that are no longer in the DB.
 * Silently ignores files that have already been removed from disk.
 *
 * @param exportDest  The export root directory.
 * @param decisions   Array of sync decisions (only 'deleted' entries are processed).
 * @param manifest    The manifest to update (entries are removed in-place).
 * @param kind        'notes' or 'attachments'.
 * @returns           The number of files successfully deleted.
 */
export function applyDeletions(
  exportDest: string,
  decisions: Array<NoteSyncDecision | AttachmentSyncDecision>,
  manifest: SyncManifest,
  kind: 'notes' | 'attachments',
): number {
  let deleted = 0;

  for (const decision of decisions) {
    if (decision.action !== 'deleted') continue;

    const entry = decision.manifestEntry;
    if (entry && 'path' in entry) {
      const filePath = join(exportDest, entry.path);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        deleted++;
      } catch {
        // Best-effort deletion — skip files we can't remove
      }
    }

    // Remove from manifest regardless
    delete manifest[kind][decision.zpk];
  }

  return deleted;
}

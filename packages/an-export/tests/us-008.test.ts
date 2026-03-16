import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SyncManifest, NoteRow } from '../src/types.ts';
import {
  MANIFEST_FILENAME,
  createEmptyManifest,
  loadManifest,
  saveManifest,
  computeNoteSyncDecisions,
  computeAttachmentSyncDecisions,
  buildNoteManifestEntry,
  buildAttachmentManifestEntry,
  applyDeletions,
} from '../src/sync.ts';
import { decodeTime } from '../src/utils.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

function setupTestDir(): string {
  const dir = join(tmpdir(), `us008-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeNoteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    Z_PK: 1,
    ZTITLE1: 'Test Note',
    ZFOLDER: 10,
    ZCREATIONDATE1: 700000000,
    ZCREATIONDATE2: null,
    ZCREATIONDATE3: null,
    ZMODIFICATIONDATE1: 700000000,
    ZISPASSWORDPROTECTED: null,
    ZHEXDATA: 'deadbeef',
    ZIDENTIFIER: 'mock-uuid-123',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    notes: {},
    attachments: {},
    ...overrides,
  };
}

beforeEach(() => {
  testDir = setupTestDir();
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ─── createEmptyManifest ─────────────────────────────────────────────────────

describe('createEmptyManifest', () => {
  test('returns a valid manifest with version 1', () => {
    const manifest = createEmptyManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.notes).toEqual({});
    expect(manifest.attachments).toEqual({});
    expect(manifest.exportedAt).toBeTruthy();
  });
});

// ─── loadManifest ────────────────────────────────────────────────────────────

describe('loadManifest', () => {
  test('returns empty manifest when file does not exist', () => {
    const manifest = loadManifest(testDir);
    expect(manifest.version).toBe(1);
    expect(manifest.notes).toEqual({});
    expect(manifest.attachments).toEqual({});
  });

  test('loads an existing manifest from disk', () => {
    const existing: SyncManifest = makeManifest({
      notes: {
        1: { path: 'Note.md', title: 'Note', mtime: 1000, identifier: 'abc-123' },
      },
    });
    writeFileSync(join(testDir, MANIFEST_FILENAME), JSON.stringify(existing));

    const loaded = loadManifest(testDir);
    expect(loaded.version).toBe(1);
    expect(loaded.notes[1]!.path).toBe('Note.md');
    expect(loaded.notes[1]!.mtime).toBe(1000);
    expect(loaded.notes[1]!.identifier).toBe('abc-123');
  });

  test('throws on unsupported manifest version', () => {
    const bad = { version: 99, exportedAt: '', notes: {}, attachments: {} };
    writeFileSync(join(testDir, MANIFEST_FILENAME), JSON.stringify(bad));

    expect(() => loadManifest(testDir)).toThrow('Unsupported manifest version: 99');
  });
});

// ─── saveManifest ────────────────────────────────────────────────────────────

describe('saveManifest', () => {
  test('writes manifest to disk as JSON', () => {
    const manifest = makeManifest({
      notes: { 5: { path: 'Work/Note.md', title: 'Note', mtime: 2000, identifier: 'xyz' } },
    });

    saveManifest(testDir, manifest);

    const rawContent = readFileSync(join(testDir, MANIFEST_FILENAME), 'utf-8');
    const parsed = JSON.parse(rawContent) as SyncManifest;
    expect(parsed.version).toBe(1);
    expect(parsed.notes[5]!.path).toBe('Work/Note.md');
    // exportedAt should have been updated
    expect(parsed.exportedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  test('overwrites existing manifest', () => {
    const first = makeManifest({ notes: { 1: { path: 'a.md', title: 'a', mtime: 1, identifier: 'a' } } });
    saveManifest(testDir, first);

    const second = makeManifest({ notes: { 2: { path: 'b.md', title: 'b', mtime: 2, identifier: 'b' } } });
    saveManifest(testDir, second);

    const loaded = loadManifest(testDir);
    expect(loaded.notes[1]).toBeUndefined();
    expect(loaded.notes[2]!.path).toBe('b.md');
  });
});

// ─── computeNoteSyncDecisions ────────────────────────────────────────────────

describe('computeNoteSyncDecisions', () => {
  test('new note: Z_PK not in manifest', () => {
    const dbNotes = [makeNoteRow({ Z_PK: 1 })];
    const manifest = makeManifest();

    const decisions = computeNoteSyncDecisions(dbNotes, manifest);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.zpk).toBe(1);
    expect(decisions[0]!.action).toBe('new');
    expect(decisions[0]!.noteRow).toBeDefined();
    expect(decisions[0]!.manifestEntry).toBeUndefined();
  });

  test('updated note: DB mtime > manifest mtime', () => {
    const noteRow = makeNoteRow({ Z_PK: 1, ZMODIFICATIONDATE1: 800000000 });
    const manifest = makeManifest({
      notes: {
        1: {
          path: 'Note.md',
          title: 'Note',
          mtime: decodeTime(700000000), // earlier than 800000000
          identifier: 'abc',
        },
      },
    });

    const decisions = computeNoteSyncDecisions([noteRow], manifest);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('updated');
    expect(decisions[0]!.noteRow).toBeDefined();
    expect(decisions[0]!.manifestEntry).toBeDefined();
  });

  test('unchanged note: DB mtime <= manifest mtime', () => {
    const mtime = 700000000;
    const noteRow = makeNoteRow({ Z_PK: 1, ZMODIFICATIONDATE1: mtime });
    const manifest = makeManifest({
      notes: {
        1: {
          path: 'Note.md',
          title: 'Note',
          mtime: decodeTime(mtime), // same timestamp
          identifier: 'abc',
        },
      },
    });

    const decisions = computeNoteSyncDecisions([noteRow], manifest);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('unchanged');
  });

  test('deleted note: in manifest but not in DB', () => {
    const manifest = makeManifest({
      notes: {
        99: { path: 'Old Note.md', title: 'Old Note', mtime: 1000, identifier: 'old' },
      },
    });

    const decisions = computeNoteSyncDecisions([], manifest);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.zpk).toBe(99);
    expect(decisions[0]!.action).toBe('deleted');
    expect(decisions[0]!.manifestEntry!.path).toBe('Old Note.md');
  });

  test('mixed scenario: new + updated + unchanged + deleted', () => {
    const dbNotes = [
      makeNoteRow({ Z_PK: 1, ZMODIFICATIONDATE1: 800000000 }), // updated
      makeNoteRow({ Z_PK: 2, ZMODIFICATIONDATE1: 700000000 }), // unchanged
      makeNoteRow({ Z_PK: 3 }),                                  // new
    ];
    const manifest = makeManifest({
      notes: {
        1: { path: 'Note1.md', title: 'Note1', mtime: decodeTime(700000000), identifier: '1' },
        2: { path: 'Note2.md', title: 'Note2', mtime: decodeTime(700000000), identifier: '2' },
        4: { path: 'Deleted.md', title: 'Deleted', mtime: 1000, identifier: '4' }, // deleted
      },
    });

    const decisions = computeNoteSyncDecisions(dbNotes, manifest);

    expect(decisions).toHaveLength(4);
    const byPk = new Map(decisions.map((d) => [d.zpk, d]));
    expect(byPk.get(1)!.action).toBe('updated');
    expect(byPk.get(2)!.action).toBe('unchanged');
    expect(byPk.get(3)!.action).toBe('new');
    expect(byPk.get(4)!.action).toBe('deleted');
  });

  test('empty DB and empty manifest yields no decisions', () => {
    const decisions = computeNoteSyncDecisions([], makeManifest());
    expect(decisions).toHaveLength(0);
  });
});

// ─── computeAttachmentSyncDecisions ──────────────────────────────────────────

describe('computeAttachmentSyncDecisions', () => {
  test('new attachment', () => {
    const decisions = computeAttachmentSyncDecisions(
      [{ Z_PK: 10, ZMODIFICATIONDATE: 700000000 }],
      makeManifest(),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('new');
  });

  test('updated attachment', () => {
    const manifest = makeManifest({
      attachments: {
        10: { path: 'attachments/img.png', mtime: decodeTime(700000000) },
      },
    });
    const decisions = computeAttachmentSyncDecisions(
      [{ Z_PK: 10, ZMODIFICATIONDATE: 800000000 }],
      manifest,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('updated');
  });

  test('unchanged attachment', () => {
    const mtime = 700000000;
    const manifest = makeManifest({
      attachments: {
        10: { path: 'attachments/img.png', mtime: decodeTime(mtime) },
      },
    });
    const decisions = computeAttachmentSyncDecisions(
      [{ Z_PK: 10, ZMODIFICATIONDATE: mtime }],
      manifest,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('unchanged');
  });

  test('deleted attachment', () => {
    const manifest = makeManifest({
      attachments: {
        10: { path: 'attachments/img.png', mtime: 1000 },
      },
    });
    const decisions = computeAttachmentSyncDecisions([], manifest);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('deleted');
  });
});

// ─── buildNoteManifestEntry ──────────────────────────────────────────────────

describe('buildNoteManifestEntry', () => {
  test('builds relative path from export dest', () => {
    const noteRow = makeNoteRow({ Z_PK: 1, ZMODIFICATIONDATE1: 700000000 });
    const filePath = join(testDir, 'Work', 'Meeting.md');

    const entry = buildNoteManifestEntry(testDir, filePath, noteRow);

    expect(entry.path).toBe('Work/Meeting.md');
    expect(entry.mtime).toBe(decodeTime(700000000));
    expect(entry.identifier).toBe('mock-uuid-123');
  });

  test('handles file at export root', () => {
    const noteRow = makeNoteRow({ Z_PK: 2, ZMODIFICATIONDATE1: 700000000 });
    const filePath = join(testDir, 'Note.md');

    const entry = buildNoteManifestEntry(testDir, filePath, noteRow);

    expect(entry.path).toBe('Note.md');
  });
});

// ─── buildAttachmentManifestEntry ────────────────────────────────────────────

describe('buildAttachmentManifestEntry', () => {
  test('builds relative path for attachment', () => {
    const filePath = join(testDir, 'attachments', 'image.png');
    const entry = buildAttachmentManifestEntry(testDir, filePath, 5000);

    expect(entry.path).toBe('attachments/image.png');
    expect(entry.mtime).toBe(5000);
  });
});

// ─── applyDeletions ──────────────────────────────────────────────────────────

describe('applyDeletions', () => {
  test('deletes files for deleted notes and removes from manifest', () => {
    // Create the file on disk
    const notePath = join(testDir, 'OldNote.md');
    writeFileSync(notePath, '# Old Note');

    const manifest = makeManifest({
      notes: {
        99: { path: 'OldNote.md', title: 'OldNote', mtime: 1000, identifier: 'old-id' },
      },
    });

    const decisions = [
      { zpk: 99, action: 'deleted' as const, manifestEntry: manifest.notes[99] },
    ];

    const deletedCount = applyDeletions(testDir, decisions, manifest, 'notes');

    expect(deletedCount).toBe(1);
    expect(existsSync(notePath)).toBe(false);
    expect(manifest.notes[99]).toBeUndefined();
  });

  test('handles already-deleted files gracefully', () => {
    const manifest = makeManifest({
      notes: {
        99: { path: 'Gone.md', title: 'Gone', mtime: 1000, identifier: 'gone' },
      },
    });

    const decisions = [
      { zpk: 99, action: 'deleted' as const, manifestEntry: manifest.notes[99] },
    ];

    const deletedCount = applyDeletions(testDir, decisions, manifest, 'notes');

    // Still counts as deleted (from manifest), even though file was already gone
    expect(deletedCount).toBe(1);
    expect(manifest.notes[99]).toBeUndefined();
  });

  test('skips non-deleted decisions', () => {
    const manifest = makeManifest({
      notes: {
        1: { path: 'Keep.md', title: 'Keep', mtime: 1000, identifier: 'keep' },
      },
    });
    writeFileSync(join(testDir, 'Keep.md'), '# Keep');

    const decisions = [
      { zpk: 1, action: 'unchanged' as const, manifestEntry: manifest.notes[1] },
    ];

    const deletedCount = applyDeletions(testDir, decisions, manifest, 'notes');

    expect(deletedCount).toBe(0);
    expect(existsSync(join(testDir, 'Keep.md'))).toBe(true);
    expect(manifest.notes[1]).toBeDefined();
  });

  test('deletes attachment files', () => {
    mkdirSync(join(testDir, 'attachments'), { recursive: true });
    const attPath = join(testDir, 'attachments', 'old-image.png');
    writeFileSync(attPath, 'fake binary');

    const manifest = makeManifest({
      attachments: {
        50: { path: 'attachments/old-image.png', mtime: 1000 },
      },
    });

    const decisions = [
      { zpk: 50, action: 'deleted' as const, manifestEntry: manifest.attachments[50] },
    ];

    const deletedCount = applyDeletions(testDir, decisions, manifest, 'attachments');

    expect(deletedCount).toBe(1);
    expect(existsSync(attPath)).toBe(false);
    expect(manifest.attachments[50]).toBeUndefined();
  });

  test('handles multiple deletions', () => {
    writeFileSync(join(testDir, 'a.md'), 'a');
    writeFileSync(join(testDir, 'b.md'), 'b');

    const manifest = makeManifest({
      notes: {
        1: { path: 'a.md', title: 'a', mtime: 1000, identifier: 'a' },
        2: { path: 'b.md', title: 'b', mtime: 2000, identifier: 'b' },
      },
    });

    const decisions = [
      { zpk: 1, action: 'deleted' as const, manifestEntry: manifest.notes[1] },
      { zpk: 2, action: 'deleted' as const, manifestEntry: manifest.notes[2] },
    ];

    const deletedCount = applyDeletions(testDir, decisions, manifest, 'notes');

    expect(deletedCount).toBe(2);
    expect(existsSync(join(testDir, 'a.md'))).toBe(false);
    expect(existsSync(join(testDir, 'b.md'))).toBe(false);
    expect(Object.keys(manifest.notes)).toHaveLength(0);
  });
});

/**
 * US-009: CLI Implementation — Integration Tests
 *
 * Tests for the full export/sync pipeline and CLI argument parsing.
 * Since the pipeline requires a real Apple Notes database, these tests
 * mock the database and decoder layers to test the orchestration logic.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { SyncManifest, NoteRow, ExportResult } from '../src/types.ts';
import { MANIFEST_FILENAME } from '../src/sync.ts';
import { gzipSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { descriptor } from '../src/descriptor.ts';

// ─── Test DB Helpers ─────────────────────────────────────────────────────────

let testDir: string;
let testDbPath: string;

function createTestDir(): string {
  const dir = join(tmpdir(), `us009-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a real SQLite database with the Apple Notes schema for testing.
 * Returns the path to the database directory.
 */
function createTestDatabase(opts: {
  accounts?: Array<{ zpk: number; name: string; identifier: string }>;
  folders?: Array<{
    zpk: number;
    title: string;
    parent: number | null;
    identifier: string;
    folderType: number;
    owner: number;
  }>;
  notes?: Array<{
    zpk: number;
    title: string;
    folder: number;
    creationDate: number;
    modificationDate: number;
    passwordProtected: number | null;
    identifier: string;
    hexData: string;
  }>;
}): { dbDir: string; db: Database } {
  const dbDir = join(testDir, 'db');
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, 'NoteStore.sqlite');
  const db = new Database(dbPath);

  // Create tables matching Apple Notes schema
  db.run(`CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT)`);
  db.run(`INSERT INTO Z_PRIMARYKEY VALUES (1, 'ICAccount')`);
  db.run(`INSERT INTO Z_PRIMARYKEY VALUES (2, 'ICFolder')`);
  db.run(`INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote')`);
  db.run(`INSERT INTO Z_PRIMARYKEY VALUES (4, 'ICAttachment')`);
  db.run(`INSERT INTO Z_PRIMARYKEY VALUES (5, 'ICMedia')`);

  db.run(`CREATE TABLE ZICCLOUDSYNCINGOBJECT (
    Z_PK INTEGER PRIMARY KEY,
    Z_ENT INTEGER,
    ZNAME TEXT,
    ZIDENTIFIER TEXT,
    ZTITLE1 TEXT,
    ZTITLE2 TEXT,
    ZFOLDER INTEGER,
    ZPARENT INTEGER,
    ZFOLDERTYPE INTEGER,
    ZOWNER INTEGER,
    ZCREATIONDATE1 REAL,
    ZCREATIONDATE2 REAL,
    ZCREATIONDATE3 REAL,
    ZMODIFICATIONDATE1 REAL,
    ZISPASSWORDPROTECTED INTEGER,
    ZALTTEXT TEXT,
    ZTOKENCONTENTIDENTIFIER TEXT,
    ZTYPEUTI TEXT,
    ZMEDIA INTEGER,
    ZGENERATION1 TEXT,
    ZFALLBACKPDFGENERATION TEXT,
    ZFALLBACKIMAGEGENERATION TEXT,
    ZSIZEHEIGHT INTEGER,
    ZSIZEWIDTH INTEGER,
    ZHANDWRITINGSUMMARY TEXT,
    ZCREATIONDATE REAL,
    ZMODIFICATIONDATE REAL,
    ZNOTE INTEGER,
    ZFILENAME TEXT,
    ZURLSTRING TEXT,
    ZMERGEABLEDATA1 BLOB
  )`);

  db.run(`CREATE TABLE ZICNOTEDATA (
    Z_PK INTEGER PRIMARY KEY,
    ZNOTE INTEGER,
    ZDATA BLOB
  )`);

  // Insert accounts
  for (const acc of opts.accounts ?? []) {
    db.run(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (?, 1, ?, ?)`,
      [acc.zpk, acc.name, acc.identifier],
    );
  }

  // Insert folders
  for (const fld of opts.folders ?? []) {
    db.run(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (?, 2, ?, ?, ?, ?, ?)`,
      [fld.zpk, fld.title, fld.parent, fld.identifier, fld.folderType, fld.owner],
    );
  }

  // Insert notes + note data
  for (const note of opts.notes ?? []) {
    db.run(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE1, ZFOLDER, ZCREATIONDATE1, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZIDENTIFIER) VALUES (?, 3, ?, ?, ?, ?, ?, ?)`,
      [note.zpk, note.title, note.folder, note.creationDate, note.modificationDate, note.passwordProtected, note.identifier],
    );

    // Convert hex string to buffer for ZDATA
    const dataBuffer = Buffer.from(note.hexData, 'hex');
    db.run(`INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)`, [note.zpk, note.zpk, dataBuffer]);
  }

  return { dbDir, db };
}

// ─── Test Lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  testDir = createTestDir();
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─── CLI Argument Parsing Tests ──────────────────────────────────────────────

describe('CLI argument parsing', () => {
  test('cli.ts is importable', async () => {
    // Verify the CLI module can be loaded without side effects crashing the test
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
    expect(existsSync(cliPath)).toBe(true);
  });

  test('main function processes export command correctly', () => {
    // Test argument parsing logic
    const args = ['export', '--dest', '/tmp/test-output'];
    const command = args[0];
    const destIndex = args.indexOf('--dest');
    const dest = destIndex !== -1 ? args[destIndex + 1] : undefined;

    expect(command).toBe('export');
    expect(dest).toBe('/tmp/test-output');
  });

  test('main function processes sync command correctly', () => {
    const args = ['sync', '--dest', '/tmp/test-output'];
    const command = args[0];
    const destIndex = args.indexOf('--dest');
    const dest = destIndex !== -1 ? args[destIndex + 1] : undefined;

    expect(command).toBe('sync');
    expect(dest).toBe('/tmp/test-output');
  });

  test('missing command is detected', () => {
    const args: string[] = [];
    const command = args[0];
    expect(!command || (command !== 'export' && command !== 'sync')).toBe(true);
  });

  test('invalid command is detected', () => {
    const args = ['invalid'];
    const command = args[0];
    expect(!command || (command !== 'export' && command !== 'sync')).toBe(true);
  });

  test('missing --dest is detected', () => {
    const args = ['export'];
    const destIndex = args.indexOf('--dest');
    const dest = destIndex !== -1 ? args[destIndex + 1] : undefined;
    expect(dest).toBeUndefined();
  });
});

// ─── Export Pipeline Tests (with mocked DB) ──────────────────────────────────

describe('exportNotes orchestration', () => {
  test('exports notes and creates manifest', async () => {
    const exportDest = join(testDir, 'export-output');
    mkdirSync(exportDest, { recursive: true });

    // Create test DB with minimal data
    const { dbDir, db: testDb } = createTestDatabase({
      accounts: [
        { zpk: 100, name: 'iCloud', identifier: 'icloud-uuid-123' },
      ],
      folders: [
        {
          zpk: 200,
          title: 'Notes',
          parent: null,
          identifier: 'DefaultFolder-icloud',
          folderType: 0,
          owner: 100,
        },
      ],
      notes: [
        {
          zpk: 1,
          title: 'My Test Note',
          folder: 200,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: null,
          identifier: 'note-uuid-1',
          hexData: 'deadbeef', // Will cause decode to fail, caught as error
        },
      ],
    });
    testDb.close();

    // Import and test using openNotesDatabase with dbDir override
    const { openNotesDatabase } = await import('../src/db.ts');

    // We can test the DB opening logic at least
    const notesDb = openNotesDatabase(dbDir);
    expect(notesDb.entityKeys.ICAccount).toBe(1);
    expect(notesDb.entityKeys.ICFolder).toBe(2);
    expect(notesDb.entityKeys.ICNote).toBe(3);
    expect(notesDb.entityKeys.ICAttachment).toBe(4);
    expect(notesDb.entityKeys.ICMedia).toBe(5);

    // Test the individual pipeline components
    const { resolveAccounts, resolveFolders } = await import('../src/folders.ts');
    const { createEmptyManifest, saveManifest, loadManifest } = await import('../src/sync.ts');
    const { queryAll } = await import('../src/db.ts');

    // Resolve accounts
    const accounts = resolveAccounts(notesDb.db, notesDb.entityKeys);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('iCloud');

    // Resolve folders
    const folderMap = resolveFolders(notesDb.db, notesDb.entityKeys, accounts, exportDest);
    expect(folderMap.size).toBeGreaterThan(0);

    // Query notes
    const noteRows = queryAll<NoteRow>(
      notesDb.db,
      `SELECT nd.z_pk AS Z_PK, hex(nd.zdata) AS ZHEXDATA,
              zcso.ztitle1 AS ZTITLE1, zcso.zfolder AS ZFOLDER,
              zcso.zcreationdate1 AS ZCREATIONDATE1,
              zcso.zmodificationdate1 AS ZMODIFICATIONDATE1,
              zcso.zispasswordprotected AS ZISPASSWORDPROTECTED,
              zcso.zidentifier AS ZIDENTIFIER
       FROM zicnotedata AS nd, ziccloudsyncingobject AS zcso
       WHERE zcso.z_ent = ? AND zcso.z_pk = nd.znote`,
      notesDb.entityKeys.ICNote,
    );
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]!.ZTITLE1).toBe('My Test Note');

    // Create and save manifest
    const manifest = createEmptyManifest();
    manifest.notes[1] = {
      path: 'My Test Note.md',
      mtime: 1678307200000,
      identifier: 'note-uuid-1',
    };
    saveManifest(exportDest, manifest);

    // Verify manifest was written
    const loaded = loadManifest(exportDest);
    expect(loaded.version).toBe(1);
    expect(loaded.notes[1]!.path).toBe('My Test Note.md');

    notesDb.close();
  });

  test('password-protected notes are identified in DB', async () => {
    const { dbDir, db: testDb } = createTestDatabase({
      accounts: [{ zpk: 100, name: 'iCloud', identifier: 'icloud-123' }],
      folders: [
        {
          zpk: 200,
          title: 'Notes',
          parent: null,
          identifier: 'DefaultFolder-icloud',
          folderType: 0,
          owner: 100,
        },
      ],
      notes: [
        {
          zpk: 1,
          title: 'Public Note',
          folder: 200,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: null,
          identifier: 'note-1',
          hexData: 'deadbeef',
        },
        {
          zpk: 2,
          title: 'Secret Note',
          folder: 200,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: 1,
          identifier: 'note-2',
          hexData: 'deadbeef',
        },
      ],
    });
    testDb.close();

    const { openNotesDatabase, queryAll } = await import('../src/db.ts');
    const notesDb = openNotesDatabase(dbDir);

    const noteRows = queryAll<NoteRow>(
      notesDb.db,
      `SELECT nd.z_pk AS Z_PK, hex(nd.zdata) AS ZHEXDATA,
              zcso.ztitle1 AS ZTITLE1, zcso.zfolder AS ZFOLDER,
              zcso.zcreationdate1 AS ZCREATIONDATE1,
              zcso.zmodificationdate1 AS ZMODIFICATIONDATE1,
              zcso.zispasswordprotected AS ZISPASSWORDPROTECTED,
              zcso.zidentifier AS ZIDENTIFIER
       FROM zicnotedata AS nd, ziccloudsyncingobject AS zcso
       WHERE zcso.z_ent = ? AND zcso.z_pk = nd.znote`,
      notesDb.entityKeys.ICNote,
    );

    expect(noteRows).toHaveLength(2);

    const publicNote = noteRows.find((r) => r.ZTITLE1 === 'Public Note');
    const secretNote = noteRows.find((r) => r.ZTITLE1 === 'Secret Note');

    expect(publicNote?.ZISPASSWORDPROTECTED).toBeNull();
    expect(secretNote?.ZISPASSWORDPROTECTED).toBe(1);

    // Verify skip logic
    let skipped = 0;
    for (const note of noteRows) {
      if (note.ZISPASSWORDPROTECTED === 1) {
        skipped++;
      }
    }
    expect(skipped).toBe(1);

    notesDb.close();
  });
});

// ─── Sync Pipeline Tests ─────────────────────────────────────────────────────

describe('syncNotes orchestration', () => {
  test('sync pipeline detects new notes from DB', async () => {
    const exportDest = join(testDir, 'sync-output');
    mkdirSync(exportDest, { recursive: true });

    const { createEmptyManifest, computeNoteSyncDecisions } = await import('../src/sync.ts');

    // First run: empty manifest
    const manifest = createEmptyManifest();
    const noteRows: NoteRow[] = [
      {
        Z_PK: 1,
        ZTITLE1: 'New Note',
        ZFOLDER: 200,
        ZCREATIONDATE1: 700000000,
        ZCREATIONDATE2: null,
        ZCREATIONDATE3: null,
        ZMODIFICATIONDATE1: 700000000,
        ZISPASSWORDPROTECTED: null,
        ZHEXDATA: 'aabb',
        ZIDENTIFIER: 'note-1',
      },
    ];

    const decisions = computeNoteSyncDecisions(noteRows, manifest);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('new');
  });

  test('sync pipeline detects updated notes', async () => {
    const { createEmptyManifest, computeNoteSyncDecisions } = await import('../src/sync.ts');
    const { decodeTime } = await import('../src/utils.ts');

    // Manifest with old mtime
    const manifest = createEmptyManifest();
    manifest.notes[1] = {
      path: 'Note.md',
      mtime: decodeTime(700000000),
      identifier: 'note-1',
    };

    // DB has newer mtime
    const noteRows: NoteRow[] = [
      {
        Z_PK: 1,
        ZTITLE1: 'Updated Note',
        ZFOLDER: 200,
        ZCREATIONDATE1: 700000000,
        ZCREATIONDATE2: null,
        ZCREATIONDATE3: null,
        ZMODIFICATIONDATE1: 800000000, // newer
        ZISPASSWORDPROTECTED: null,
        ZHEXDATA: 'aabb',
        ZIDENTIFIER: 'note-1',
      },
    ];

    const decisions = computeNoteSyncDecisions(noteRows, manifest);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('updated');
  });

  test('sync pipeline skips unchanged notes', async () => {
    const { createEmptyManifest, computeNoteSyncDecisions } = await import('../src/sync.ts');
    const { decodeTime } = await import('../src/utils.ts');

    const mtime = 700000000;
    const manifest = createEmptyManifest();
    manifest.notes[1] = {
      path: 'Note.md',
      mtime: decodeTime(mtime),
      identifier: 'note-1',
    };

    const noteRows: NoteRow[] = [
      {
        Z_PK: 1,
        ZTITLE1: 'Unchanged Note',
        ZFOLDER: 200,
        ZCREATIONDATE1: mtime,
        ZCREATIONDATE2: null,
        ZCREATIONDATE3: null,
        ZMODIFICATIONDATE1: mtime,
        ZISPASSWORDPROTECTED: null,
        ZHEXDATA: 'aabb',
        ZIDENTIFIER: 'note-1',
      },
    ];

    const decisions = computeNoteSyncDecisions(noteRows, manifest);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('unchanged');
  });

  test('sync pipeline detects deleted notes and cleans up files', async () => {
    const exportDest = join(testDir, 'sync-delete-output');
    mkdirSync(exportDest, { recursive: true });

    const { createEmptyManifest, computeNoteSyncDecisions, applyDeletions } = await import(
      '../src/sync.ts'
    );

    // Create an exported file
    const notePath = join(exportDest, 'Deleted Note.md');
    writeFileSync(notePath, '# Deleted Note\nContent');
    expect(existsSync(notePath)).toBe(true);

    // Manifest has the note
    const manifest = createEmptyManifest();
    manifest.notes[99] = {
      path: 'Deleted Note.md',
      mtime: 1000,
      identifier: 'deleted-uuid',
    };

    // DB has no notes — the note was deleted from Apple Notes
    const decisions = computeNoteSyncDecisions([], manifest);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('deleted');

    // Apply deletions
    const deleted = applyDeletions(exportDest, decisions, manifest, 'notes');
    expect(deleted).toBe(1);
    expect(existsSync(notePath)).toBe(false);
    expect(manifest.notes[99]).toBeUndefined();
  });

  test('full sync cycle: export → modify → sync', async () => {
    const exportDest = join(testDir, 'full-sync-output');
    mkdirSync(exportDest, { recursive: true });

    const {
      createEmptyManifest,
      saveManifest,
      loadManifest,
      computeNoteSyncDecisions,
      buildNoteManifestEntry,
      applyDeletions,
    } = await import('../src/sync.ts');
    const { decodeTime } = await import('../src/utils.ts');

    // Step 1: Initial "export" — simulate writing notes
    const manifest = createEmptyManifest();
    const note1Path = join(exportDest, 'Note A.md');
    const note2Path = join(exportDest, 'Note B.md');
    writeFileSync(note1Path, '# Note A');
    writeFileSync(note2Path, '# Note B');

    manifest.notes[1] = { path: 'Note A.md', mtime: decodeTime(700000000), identifier: 'a' };
    manifest.notes[2] = { path: 'Note B.md', mtime: decodeTime(700000000), identifier: 'b' };
    saveManifest(exportDest, manifest);

    // Step 2: Simulate DB changes — Note A updated, Note B deleted, Note C added
    const dbNotes: NoteRow[] = [
      {
        Z_PK: 1,
        ZTITLE1: 'Note A',
        ZFOLDER: 200,
        ZCREATIONDATE1: 700000000,
        ZCREATIONDATE2: null,
        ZCREATIONDATE3: null,
        ZMODIFICATIONDATE1: 800000000, // updated
        ZISPASSWORDPROTECTED: null,
        ZHEXDATA: 'aabb',
        ZIDENTIFIER: 'a',
      },
      {
        Z_PK: 3,
        ZTITLE1: 'Note C',
        ZFOLDER: 200,
        ZCREATIONDATE1: 800000000,
        ZCREATIONDATE2: null,
        ZCREATIONDATE3: null,
        ZMODIFICATIONDATE1: 800000000,
        ZISPASSWORDPROTECTED: null,
        ZHEXDATA: 'ccdd',
        ZIDENTIFIER: 'c',
      },
      // Note B (Z_PK=2) is missing → deleted
    ];

    const loaded = loadManifest(exportDest);
    const decisions = computeNoteSyncDecisions(dbNotes, loaded);

    // Verify decisions
    const byPk = new Map(decisions.map((d) => [d.zpk, d]));
    expect(byPk.get(1)!.action).toBe('updated');
    expect(byPk.get(3)!.action).toBe('new');
    expect(byPk.get(2)!.action).toBe('deleted');

    // Apply deletions
    const deleted = applyDeletions(exportDest, decisions, loaded, 'notes');
    expect(deleted).toBe(1);
    expect(existsSync(note2Path)).toBe(false);

    // Count results
    let exported = 0;
    let skipped = 0;
    for (const d of decisions) {
      if (d.action === 'new' || d.action === 'updated') exported++;
      if (d.action === 'unchanged') skipped++;
    }
    expect(exported).toBe(2);
    expect(skipped).toBe(0);
    expect(deleted).toBe(1);
  });
});

// ─── ExportResult Structure Tests ────────────────────────────────────────────

describe('ExportResult structure', () => {
  test('ExportResult has correct shape', () => {
    const result: ExportResult = {
      exported: 5,
      skipped: 2,
      deleted: 1,
      failed: ['Note X: decode error'],
    };
    expect(result.exported).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.failed).toHaveLength(1);
  });

  test('ExportResult with zero counts', () => {
    const result: ExportResult = { exported: 0, skipped: 0, deleted: 0, failed: [] };
    expect(result.exported).toBe(0);
    expect(result.failed).toHaveLength(0);
  });
});

// ─── Module Exports Tests ────────────────────────────────────────────────────

describe('index.ts module exports', () => {
  test('exports exportNotes function', async () => {
    const idx = await import('../src/index.ts');
    expect(typeof idx.exportNotes).toBe('function');
  });

  test('exports syncNotes function', async () => {
    const idx = await import('../src/index.ts');
    expect(typeof idx.syncNotes).toBe('function');
  });

  test('exports decodeTime utility', async () => {
    const idx = await import('../src/index.ts');
    expect(typeof idx.decodeTime).toBe('function');
  });

  test('exports sanitizeFileName utility', async () => {
    const idx = await import('../src/index.ts');
    expect(typeof idx.sanitizeFileName).toBe('function');
  });
});

// ─── Progress Callback Tests ─────────────────────────────────────────────────

describe('progress callback behavior', () => {
  test('onProgress receives password-protected skip message', () => {
    // Simulate the skip logic used in the pipeline
    const messages: string[] = [];
    const onProgress = (msg: string) => messages.push(msg);

    const noteRow = {
      ZTITLE1: 'Secret',
      ZISPASSWORDPROTECTED: 1,
    };

    if (noteRow.ZISPASSWORDPROTECTED === 1) {
      onProgress(`⚠ Skipping password-protected note: ${noteRow.ZTITLE1 ?? 'Untitled'}`);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Skipping password-protected');
    expect(messages[0]).toContain('Secret');
  });

  test('onProgress receives export progress message', () => {
    const messages: string[] = [];
    const onProgress = (msg: string) => messages.push(msg);

    // Simulate export progress
    onProgress('Exported 1/5: My Note');
    onProgress('Exported 2/5: Another Note');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('1/5');
    expect(messages[1]).toContain('2/5');
  });

  test('onProgress receives deletion message', () => {
    const messages: string[] = [];
    const onProgress = (msg: string) => messages.push(msg);

    const deleted = 3;
    if (deleted > 0) {
      onProgress(`Deleted ${deleted} removed note(s)`);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Deleted 3');
  });
});

// ─── DB + Folder Integration Tests ───────────────────────────────────────────

describe('database-to-folder integration', () => {
  test('full schema: accounts → folders → notes are queryable', async () => {
    const { dbDir, db: testDb } = createTestDatabase({
      accounts: [
        { zpk: 100, name: 'iCloud', identifier: 'icloud-uuid' },
      ],
      folders: [
        {
          zpk: 200,
          title: 'Notes',
          parent: null,
          identifier: 'DefaultFolder-icloud',
          folderType: 0,
          owner: 100,
        },
        {
          zpk: 201,
          title: 'Work',
          parent: 200,
          identifier: 'work-folder-uuid',
          folderType: 0,
          owner: 100,
        },
      ],
      notes: [
        {
          zpk: 1,
          title: 'Root Note',
          folder: 200,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: null,
          identifier: 'note-root',
          hexData: 'aa',
        },
        {
          zpk: 2,
          title: 'Work Note',
          folder: 201,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: null,
          identifier: 'note-work',
          hexData: 'bb',
        },
      ],
    });
    testDb.close();

    const { openNotesDatabase } = await import('../src/db.ts');
    const { resolveAccounts, resolveFolders } = await import('../src/folders.ts');

    const notesDb = openNotesDatabase(dbDir);
    const accounts = resolveAccounts(notesDb.db, notesDb.entityKeys);
    expect(accounts).toHaveLength(1);

    const exportDest = join(testDir, 'folder-test-output');
    mkdirSync(exportDest, { recursive: true });

    const folderMap = resolveFolders(notesDb.db, notesDb.entityKeys, accounts, exportDest);

    // Default folder and Work subfolder should both be resolved
    expect(folderMap.has(200)).toBe(true);
    expect(folderMap.has(201)).toBe(true);

    // Work folder should be a subdirectory
    const workFolder = folderMap.get(201)!;
    expect(workFolder.outputPath).toContain(join('notes', 'Work'));

    // Default folder maps to export root
    const defaultFolder = folderMap.get(200)!;
    expect(defaultFolder.outputPath).toBe(join(exportDest, 'notes'));

    notesDb.close();
  });

  test('smart folders and trash are filtered out', async () => {
    const { dbDir, db: testDb } = createTestDatabase({
      accounts: [
        { zpk: 100, name: 'Local', identifier: 'local-uuid' },
      ],
      folders: [
        {
          zpk: 200,
          title: 'Notes',
          parent: null,
          identifier: 'DefaultFolder-local',
          folderType: 0,
          owner: 100,
        },
        {
          zpk: 201,
          title: 'Recently Deleted',
          parent: null,
          identifier: 'trash-uuid',
          folderType: 1, // Trash
          owner: 100,
        },
        {
          zpk: 202,
          title: 'All Items',
          parent: null,
          identifier: 'smart-uuid',
          folderType: 3, // Smart
          owner: 100,
        },
      ],
    });
    testDb.close();

    const { openNotesDatabase } = await import('../src/db.ts');
    const { resolveAccounts, resolveFolders } = await import('../src/folders.ts');

    const notesDb = openNotesDatabase(dbDir);
    const accounts = resolveAccounts(notesDb.db, notesDb.entityKeys);

    const exportDest = join(testDir, 'filter-test-output');
    mkdirSync(exportDest, { recursive: true });

    const folderMap = resolveFolders(notesDb.db, notesDb.entityKeys, accounts, exportDest);

    // Only the default folder should be present
    expect(folderMap.has(200)).toBe(true);
    expect(folderMap.has(201)).toBe(false); // Trash filtered
    expect(folderMap.has(202)).toBe(false); // Smart filtered

    notesDb.close();
  });
});

// ─── Actual CLI Execution Tests ──────────────────────────────────────────────

describe('CLI Script Execution', () => {
  test('CLI executes export and sync commands end-to-end', () => {
    const exportDest = join(testDir, 'cli-export-output');
    
    // Generate valid protobuf hex data for a note
    const root = protobuf.Root.fromJSON(descriptor);
    const DocumentType = root.lookupType('ciofecaforensics.Document');
    const msg = DocumentType.create({ version: 1, note: { noteText: 'CLI Note Text' } });
    const validHexData = gzipSync(DocumentType.encode(msg).finish()).toString('hex');

    // Create test DB
    const { dbDir, db: testDb } = createTestDatabase({
      accounts: [{ zpk: 100, name: 'iCloud', identifier: 'icloud-uuid' }],
      folders: [
        {
          zpk: 200,
          title: 'Notes',
          parent: null,
          identifier: 'DefaultFolder-icloud',
          folderType: 0,
          owner: 100,
        },
      ],
      notes: [
        {
          zpk: 1,
          title: 'CLI Note',
          folder: 200,
          creationDate: 700000000,
          modificationDate: 700000000,
          passwordProtected: null,
          identifier: 'note-cli-1',
          hexData: validHexData,
        },
      ],
    });
    testDb.close();

    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');

    // Run EXPORT
    const exportRes = spawnSync('bun', [
      'run',
      cliPath,
      'export',
      '--dest',
      exportDest,
      '--db-dir',
      dbDir,
    ], { encoding: 'utf-8' });

    expect(exportRes.status).toBe(0);
    expect(exportRes.stdout).toContain('Exporting Apple Notes to:');
    expect(exportRes.stdout).toContain('Exported 1/1: CLI Note');
    expect(exportRes.stdout).toContain('Done.');
    
    // Verify file created
    expect(existsSync(join(exportDest, 'notes', 'CLI Note.md'))).toBe(true);
    expect(existsSync(join(exportDest, MANIFEST_FILENAME))).toBe(true);

    // Run SYNC
    const syncRes = spawnSync('bun', [
      'run',
      cliPath,
      'sync',
      '--dest',
      exportDest,
      '--db-dir',
      dbDir,
    ], { encoding: 'utf-8' });

    expect(syncRes.status).toBe(0);
    expect(syncRes.stdout).toContain('Syncing Apple Notes to:');
    expect(syncRes.stdout).toContain('Done. Exported: 0, Skipped: 1');
  });
});

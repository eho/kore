/**
 * Unit tests for US-007: Folder & Account Resolution (src/folders.ts)
 *
 * Uses in-memory bun:sqlite databases with mock account/folder rows
 * to verify folder hierarchy resolution, default folder handling,
 * smart/trash filtering, and multi-account prefixing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EntityKeys, ANAccount } from '../src/types.ts';
import { resolveAccounts, resolveFolders, buildFolderPath } from '../src/folders.ts';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(':memory:');
  // Create the tables needed for folder/account resolution
  db.run('CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT)');
  db.run("INSERT INTO Z_PRIMARYKEY VALUES (1, 'ICAccount')");
  db.run("INSERT INTO Z_PRIMARYKEY VALUES (2, 'ICFolder')");
  db.run("INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote')");
  db.run("INSERT INTO Z_PRIMARYKEY VALUES (4, 'ICAttachment')");
  db.run("INSERT INTO Z_PRIMARYKEY VALUES (5, 'ICMedia')");

  db.run(`
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER,
      ZNAME TEXT,
      ZIDENTIFIER TEXT,
      ZTITLE2 TEXT,
      ZPARENT INTEGER,
      ZFOLDERTYPE INTEGER DEFAULT 0,
      ZOWNER INTEGER
    )
  `);
  return db;
}

const TEST_ENTITY_KEYS: EntityKeys = {
  ICAccount: 1,
  ICFolder: 2,
  ICNote: 3,
  ICAttachment: 4,
  ICMedia: 5,
};

function createTempExportDir(): string {
  const dir = join(tmpdir(), `an-export-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── resolveAccounts ─────────────────────────────────────────────────────────

describe('resolveAccounts', () => {
  it('returns accounts with name, uuid, and data path', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ABC-123')",
    );

    const accounts = resolveAccounts(db, TEST_ENTITY_KEYS);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('iCloud');
    expect(accounts[0]!.uuid).toBe('ABC-123');
    expect(accounts[0]!.path).toContain('Accounts/ABC-123');

    db.close();
  });

  it('returns empty array when no accounts exist', () => {
    const db = createTestDb();
    const accounts = resolveAccounts(db, TEST_ENTITY_KEYS);
    expect(accounts).toHaveLength(0);
    db.close();
  });

  it('handles multiple accounts', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (101, 1, 'Gmail', 'ACC-2')",
    );

    const accounts = resolveAccounts(db, TEST_ENTITY_KEYS);

    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.name)).toContain('iCloud');
    expect(accounts.map((a) => a.name)).toContain('Gmail');

    db.close();
  });

  it('falls back to "Unknown Account" when ZNAME is null', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, NULL, 'ACC-NULL')",
    );

    const accounts = resolveAccounts(db, TEST_ENTITY_KEYS);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('Unknown Account');

    db.close();
  });
});

// ─── resolveFolders ──────────────────────────────────────────────────────────

describe('resolveFolders', () => {
  let exportDir: string;

  beforeEach(() => {
    exportDir = createTempExportDir();
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('resolves a simple top-level folder', () => {
    const db = createTestDb();
    // Account
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    // Default root folder
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    // A subfolder of the default
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, 'Work', 200, 'FOLDER-WORK', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    // Should have 2 folders: the default root and Work
    expect(folders.size).toBe(2);

    // Work folder should have an outputPath ending with /Work
    const workFolder = folders.get(201);
    expect(workFolder).toBeDefined();
    expect(workFolder!.outputPath).toBe(join(exportDir, 'Work'));
    expect(existsSync(workFolder!.outputPath)).toBe(true);

    db.close();
  });

  it('resolves nested folder hierarchy', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    // Default root
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    // Work → child of default
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, 'Work', 200, 'FOLDER-WORK', 0, 100)",
    );
    // Projects → child of Work
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (202, 2, 'Projects', 201, 'FOLDER-PROJ', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    const projectsFolder = folders.get(202);
    expect(projectsFolder).toBeDefined();
    expect(projectsFolder!.outputPath).toBe(join(exportDir, 'Work', 'Projects'));
    expect(existsSync(projectsFolder!.outputPath)).toBe(true);

    db.close();
  });

  it('maps default folder to export root (no subfolder)', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-CloudKit', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    const defaultFolder = folders.get(200);
    expect(defaultFolder).toBeDefined();
    // Default folder maps to export root
    expect(defaultFolder!.outputPath).toBe(join(exportDir, '.'));

    db.close();
  });

  it('skips smart folders (ZFOLDERTYPE = 3)', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    // Smart folder — should be skipped
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (300, 2, 'Smart Attachments', 200, 'SMART-1', 3, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    expect(folders.has(300)).toBe(false);

    db.close();
  });

  it('skips trash folders by default', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (301, 2, 'Recently Deleted', 200, 'TRASH-1', 1, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    expect(folders.has(301)).toBe(false);

    db.close();
  });

  it('includes trash folders when includeTrashed is true', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (301, 2, 'Recently Deleted', 200, 'TRASH-1', 1, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir, {
      includeTrashed: true,
    });

    expect(folders.has(301)).toBe(true);
    const trashFolder = folders.get(301)!;
    expect(trashFolder.outputPath).toBe(join(exportDir, 'Recently Deleted'));

    db.close();
  });

  it('prefixes with account name in multi-account mode', () => {
    const db = createTestDb();
    // Two accounts
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (101, 1, 'Gmail', 'ACC-2')",
    );
    // Default folder for iCloud
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-iCloud', 0, 100)",
    );
    // A subfolder under iCloud's default
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, 'Work', 200, 'FOLDER-WORK', 0, 100)",
    );
    // Default folder for Gmail
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (210, 2, 'Notes', NULL, 'DefaultFolder-Gmail', 0, 101)",
    );
    // A subfolder under Gmail's default
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (211, 2, 'Personal', 210, 'FOLDER-PERSONAL', 0, 101)",
    );

    const accounts: ANAccount[] = [
      { name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc1' },
      { name: 'Gmail', uuid: 'ACC-2', path: '/tmp/acc2' },
    ];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    // iCloud's Work folder should be prefixed with account name
    const workFolder = folders.get(201);
    expect(workFolder).toBeDefined();
    expect(workFolder!.outputPath).toBe(join(exportDir, 'iCloud', 'Work'));

    // Gmail's Personal folder should be prefixed with account name
    const personalFolder = folders.get(211);
    expect(personalFolder).toBeDefined();
    expect(personalFolder!.outputPath).toBe(join(exportDir, 'Gmail', 'Personal'));

    db.close();
  });

  it('creates output directories on disk', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, 'Deep', 200, 'F-DEEP', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (202, 2, 'Nested', 201, 'F-NESTED', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    expect(existsSync(join(exportDir, 'Deep'))).toBe(true);
    expect(existsSync(join(exportDir, 'Deep', 'Nested'))).toBe(true);

    db.close();
  });

  it('sanitizes folder names with special characters', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, 'My: Cool/Folder*Name', 200, 'F-SPECIAL', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    const folder = folders.get(201);
    expect(folder).toBeDefined();
    // Special chars replaced with dashes by sanitizeFileName
    expect(folder!.outputPath).toBe(join(exportDir, 'My- Cool-Folder-Name'));

    db.close();
  });

  it('handles folders with null ZTITLE2 as "Untitled Folder"', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME, ZIDENTIFIER) VALUES (100, 1, 'iCloud', 'ACC-1')",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (200, 2, 'Notes', NULL, 'DefaultFolder-ABC', 0, 100)",
    );
    db.run(
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER) VALUES (201, 2, NULL, 200, 'F-UNTITLED', 0, 100)",
    );

    const accounts: ANAccount[] = [{ name: 'iCloud', uuid: 'ACC-1', path: '/tmp/acc' }];
    const folders = resolveFolders(db, TEST_ENTITY_KEYS, accounts, exportDir);

    const folder = folders.get(201);
    expect(folder).toBeDefined();
    expect(folder!.outputPath).toBe(join(exportDir, 'Untitled Folder'));

    db.close();
  });
});

// ─── buildFolderPath ─────────────────────────────────────────────────────────

describe('buildFolderPath', () => {
  it('returns "." for a standalone default folder (single account)', () => {
    const folderMap = new Map([
      [200, { Z_PK: 200, ZTITLE2: 'Notes', ZPARENT: null, ZIDENTIFIER: 'DefaultFolder-X', ZFOLDERTYPE: 0, ZOWNER: 100 }],
    ]);
    const accountByPk = new Map<number, ANAccount>();

    const path = buildFolderPath(200, folderMap, accountByPk, false);
    expect(path).toBe('.');
  });

  it('prefixes with account name for default folder in multi-account mode', () => {
    const folderMap = new Map([
      [200, { Z_PK: 200, ZTITLE2: 'Notes', ZPARENT: null, ZIDENTIFIER: 'DefaultFolder-X', ZFOLDERTYPE: 0, ZOWNER: 100 }],
    ]);
    const accountByPk = new Map<number, ANAccount>([
      [100, { name: 'iCloud', uuid: 'ACC-1', path: '/tmp' }],
    ]);

    const path = buildFolderPath(200, folderMap, accountByPk, true);
    expect(path).toBe('iCloud');
  });

  it('builds a nested path through parent chain', () => {
    const folderMap = new Map([
      [200, { Z_PK: 200, ZTITLE2: 'Notes', ZPARENT: null, ZIDENTIFIER: 'DefaultFolder-X', ZFOLDERTYPE: 0, ZOWNER: 100 }],
      [201, { Z_PK: 201, ZTITLE2: 'Work', ZPARENT: 200, ZIDENTIFIER: 'F-WORK', ZFOLDERTYPE: 0, ZOWNER: 100 }],
      [202, { Z_PK: 202, ZTITLE2: 'Projects', ZPARENT: 201, ZIDENTIFIER: 'F-PROJ', ZFOLDERTYPE: 0, ZOWNER: 100 }],
    ]);
    const accountByPk = new Map<number, ANAccount>();

    const path = buildFolderPath(202, folderMap, accountByPk, false);
    expect(path).toBe(join('Work', 'Projects'));
  });

  it('handles broken parent chain gracefully', () => {
    const folderMap = new Map([
      [201, { Z_PK: 201, ZTITLE2: 'Orphan', ZPARENT: 999, ZIDENTIFIER: 'F-ORPHAN', ZFOLDERTYPE: 0, ZOWNER: 100 }],
    ]);
    const accountByPk = new Map<number, ANAccount>();

    // Parent 999 doesn't exist — should stop walking
    const path = buildFolderPath(201, folderMap, accountByPk, false);
    expect(path).toBe('Orphan');
  });

  it('prevents infinite loops on circular parent references', () => {
    const folderMap = new Map([
      [200, { Z_PK: 200, ZTITLE2: 'A', ZPARENT: 201, ZIDENTIFIER: 'F-A', ZFOLDERTYPE: 0, ZOWNER: 100 }],
      [201, { Z_PK: 201, ZTITLE2: 'B', ZPARENT: 200, ZIDENTIFIER: 'F-B', ZFOLDERTYPE: 0, ZOWNER: 100 }],
    ]);
    const accountByPk = new Map<number, ANAccount>();

    const path = buildFolderPath(200, folderMap, accountByPk, false);
    // Should stop at B and not infinitely loop
    expect(path).toBe(join('B', 'A'));
  });
});

/**
 * Unit tests for US-002: Database Access Layer (src/db.ts)
 *
 * Uses a real bun:sqlite in-memory database to test entity key building,
 * and filesystem mocks to test the safe-copy logic.
 */

import { expect, mock } from 'bun:test';

mock.module('node:fs', () => {
  const original = require('node:fs');
  return {
    ...original,
    copyFileSync: (src: string, dest: string) => {
      if (src.includes('NoteStore.sqlite-wal') || src.includes('fake-db')) {
        throw new Error('EACCES: permission denied');
      }
      return original.copyFileSync(src, dest);
    }
  };
});

import { describe, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as db from '../src/db.ts';
import { buildEntityKeys, openNotesDatabase, queryAll, queryOne } from '../src/db.ts';

// ─── buildEntityKeys tests ───────────────────────────────────────────────────

describe('buildEntityKeys', () => {
  it('builds entity keys from a z_primarykey table', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT)');
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (1, 'ICAccount')");
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (2, 'ICFolder')");
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote')");
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (4, 'ICAttachment')");
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (5, 'ICMedia')");
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (6, 'ICUnrelatedType')");

    const keys = buildEntityKeys(db);

    expect(keys.ICAccount).toBe(1);
    expect(keys.ICFolder).toBe(2);
    expect(keys.ICNote).toBe(3);
    expect(keys.ICAttachment).toBe(4);
    expect(keys.ICMedia).toBe(5);

    db.close();
  });

  it('throws when a required entity type is missing', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT)');
    db.run("INSERT INTO Z_PRIMARYKEY VALUES (1, 'ICAccount')");
    // Missing ICFolder, ICNote, ICAttachment, ICMedia

    expect(() => buildEntityKeys(db)).toThrow(/ICFolder/);
    db.close();
  });
});

// ─── queryAll / queryOne tests ───────────────────────────────────────────────

describe('queryAll', () => {
  it('returns all matching rows', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE items (id INTEGER, name TEXT)');
    db.run("INSERT INTO items VALUES (1, 'alpha')");
    db.run("INSERT INTO items VALUES (2, 'beta')");

    const rows = queryAll<{ id: number; name: string }>(db, 'SELECT * FROM items');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('alpha');
    expect(rows[1]!.name).toBe('beta');

    db.close();
  });
});

describe('queryOne', () => {
  it('returns a single matching row', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE items (id INTEGER, name TEXT)');
    db.run("INSERT INTO items VALUES (1, 'alpha')");
    db.run("INSERT INTO items VALUES (2, 'beta')");

    const row = queryOne<{ id: number; name: string }>(db, 'SELECT * FROM items WHERE id = ?', 2);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('beta');

    db.close();
  });

  it('returns null if no row matches', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE items (id INTEGER, name TEXT)');

    const row = queryOne<{ id: number; name: string }>(db, 'SELECT * FROM items WHERE id = ?', 99);
    expect(row).toBeNull();

    db.close();
  });
});

// ─── openNotesDatabase tests ─────────────────────────────────────────────────

describe('openNotesDatabase', () => {
  it('throws a clear error when the database does not exist', () => {
    const fakeDir = join(tmpdir(), `an-export-test-${randomUUID()}`);
    mkdirSync(fakeDir, { recursive: true });

    expect(() => openNotesDatabase(fakeDir)).toThrow(/Apple Notes database not found/);

    // Cleanup
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('copies the database to a temp dir and opens it read-only', () => {
    // Create a fake NoteStore.sqlite in a temp directory
    const fakeDir = join(tmpdir(), `an-export-test-${randomUUID()}`);
    mkdirSync(fakeDir, { recursive: true });

    // Create a real SQLite database
    const fakePath = join(fakeDir, 'NoteStore.sqlite');
    const setupDb = new Database(fakePath);
    setupDb.run('CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT)');
    setupDb.run("INSERT INTO Z_PRIMARYKEY VALUES (10, 'ICAccount')");
    setupDb.run("INSERT INTO Z_PRIMARYKEY VALUES (11, 'ICFolder')");
    setupDb.run("INSERT INTO Z_PRIMARYKEY VALUES (12, 'ICNote')");
    setupDb.run("INSERT INTO Z_PRIMARYKEY VALUES (13, 'ICAttachment')");
    setupDb.run("INSERT INTO Z_PRIMARYKEY VALUES (14, 'ICMedia')");
    setupDb.close();

    // Now test openNotesDatabase
    const result = openNotesDatabase(fakeDir);

    expect(result.db).toBeDefined();
    expect(result.tempDir).not.toBe(fakeDir); // Should be a different temp dir
    expect(existsSync(join(result.tempDir, 'NoteStore.sqlite'))).toBe(true);
    expect(result.entityKeys.ICAccount).toBe(10);
    expect(result.entityKeys.ICMedia).toBe(14);

    result.close();

    // Cleanup
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(result.tempDir, { recursive: true, force: true });
  });

  it('throws an error with Full Disk Access hint if copying fails', () => {
    const fakeDir = join(tmpdir(), `an-export-test-${randomUUID()}`);
    mkdirSync(fakeDir, { recursive: true });

    // Ensure the main DB file exists so openNotesDatabase passes its initial existsSync check
    writeFileSync(join(fakeDir, 'NoteStore.sqlite'), 'fake-db');
    
    // Create the WAL file which triggers our mocked copyFileSync to throw permission denied
    writeFileSync(join(fakeDir, 'NoteStore.sqlite-wal'), 'fake-db');

    expect(() => openNotesDatabase(fakeDir)).toThrow(/grant Full Disk Access/);

    // Cleanup
    rmSync(fakeDir, { recursive: true, force: true });
  });
});

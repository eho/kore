/**
 * Apple Notes Database Access Layer.
 *
 * Safely copies the Apple Notes SQLite database to a temp directory,
 * opens it in read-only mode, and provides typed query helpers.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EntityKeys, DbRow } from './types.ts';

/**
 * The standard path to the Apple Notes NoteStore database on macOS.
 */
export const NOTES_DB_PATH = join(
  homedir(),
  'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite',
);

/**
 * WAL-mode companion files that must also be copied.
 */
const DB_FILES = ['NoteStore.sqlite', 'NoteStore.sqlite-shm', 'NoteStore.sqlite-wal'] as const;

/**
 * Open result returned by `openNotesDatabase`.
 */
export type NotesDatabase = {
  /** The bun:sqlite Database instance (read-only, on the temp copy). */
  db: Database;
  /** Path to the temporary copy of the database. */
  tempDir: string;
  /** Entity type lookup map, e.g. { ICNote: 14, ICFolder: 9, ... }. */
  entityKeys: EntityKeys;
  /** Close the database and clean-up. */
  close: () => void;
};

/**
 * Copy the Apple Notes database to a temp directory and open it read-only.
 *
 * @param dbDir Optional override for the directory containing NoteStore.sqlite
 *              (useful for testing). Defaults to the standard macOS location.
 * @returns A `NotesDatabase` handle with DB access and entity keys.
 * @throws If the database doesn't exist or can't be read.
 */
export function openNotesDatabase(dbDir?: string): NotesDatabase {
  const sourceDir =
    dbDir ?? join(homedir(), 'Library/Group Containers/group.com.apple.notes');

  const sourcePath = join(sourceDir, 'NoteStore.sqlite');

  if (!existsSync(sourcePath)) {
    throw new Error(
      `Apple Notes database not found at: ${sourcePath}\n` +
        'Make sure you are running on macOS with Apple Notes installed.',
    );
  }

  // Copy all WAL-mode files to a temp directory
  const tempDir = join(tmpdir(), `an-export-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  for (const file of DB_FILES) {
    const src = join(sourceDir, file);
    const dest = join(tempDir, file);
    if (existsSync(src)) {
      try {
        copyFileSync(src, dest);
      } catch (err) {
        throw new Error(
          `Failed to copy ${file}: ${err instanceof Error ? err.message : String(err)}\n` +
            'You may need to grant Full Disk Access to your terminal in System Settings → Privacy & Security.',
        );
      }
    }
  }

  // Open the copy in read-only mode
  const db = new Database(join(tempDir, 'NoteStore.sqlite'), { readonly: true });

  // Build entity keys lookup
  const entityKeys = buildEntityKeys(db);

  const close = () => {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
  };

  return { db, tempDir, entityKeys, close };
}

/**
 * Query `z_primarykey` to build a mapping from entity name → numeric entity ID.
 * This is required to filter `ziccloudsyncingobject` rows by entity type.
 */
export function buildEntityKeys(db: Database): EntityKeys {
  const rows = db
    .query('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY')
    .all() as Array<{ Z_ENT: number; Z_NAME: string }>;

  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.Z_NAME] = row.Z_ENT;
  }

  // Validate required entity types are present
  const required: Array<keyof EntityKeys> = [
    'ICAccount',
    'ICFolder',
    'ICNote',
    'ICAttachment',
    'ICMedia',
  ];

  for (const name of required) {
    if (!(name in map)) {
      throw new Error(
        `Entity type '${name}' not found in Z_PRIMARYKEY. ` +
          'The Apple Notes database schema may have changed.',
      );
    }
  }

  return {
    ICAccount: map['ICAccount']!,
    ICFolder: map['ICFolder']!,
    ICNote: map['ICNote']!,
    ICAttachment: map['ICAttachment']!,
    ICMedia: map['ICMedia']!,
  };
}

/**
 * Helper to run a typed all-rows query on the database.
 */
export function queryAll<T extends DbRow>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query(sql).all(...params) as T[];
}

/**
 * Helper to run a typed single-row query on the database.
 */
export function queryOne<T extends DbRow>(
  db: Database,
  sql: string,
  ...params: SQLQueryBindings[]
): T | null {
  return (db.query(sql).get(...params) as T | null) ?? null;
}

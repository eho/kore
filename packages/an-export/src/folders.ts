/**
 * Folder & Account Resolution.
 *
 * Resolves Apple Notes accounts and folder hierarchy from the database
 * and maps them to output directory paths for export.
 */

import type { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EntityKeys, AccountRow, FolderRow, ANAccount, ResolvedFolder } from './types.ts';
import { ANFolderType } from './types.ts';
import { queryAll } from './db.ts';
import { sanitizeFileName } from './utils.ts';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Query all Apple Notes accounts from the database.
 *
 * @returns An array of ANAccount objects with name, uuid, and data directory path.
 */
export function resolveAccounts(
  db: Database,
  entityKeys: EntityKeys,
  dbDir?: string,
): ANAccount[] {
  const rows = queryAll<AccountRow>(
    db,
    'SELECT Z_PK, ZNAME, ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?',
    entityKeys.ICAccount,
  );

  const basePath = dbDir ?? join(homedir(), 'Library/Group Containers/group.com.apple.notes');

  return rows.map((row) => ({
    name: row.ZNAME ?? 'Unknown Account',
    uuid: row.ZIDENTIFIER,
    path: join(basePath, 'Accounts', row.ZIDENTIFIER),
  }));
}

type ResolveFoldersOptions = {
  includeTrashed?: boolean;
};

/**
 * Resolve Apple Notes folder hierarchy to output directory paths.
 *
 * Queries all folders, filters out smart/trash folders (unless opted-in),
 * recursively resolves parent chains to build full paths, and creates
 * the output directories on disk.
 *
 * @returns A Map from folder Z_PK to its ResolvedFolder (output path + owner account ID).
 */
export function resolveFolders(
  db: Database,
  entityKeys: EntityKeys,
  accounts: ANAccount[],
  exportDest: string,
  opts?: ResolveFoldersOptions,
): Map<number, ResolvedFolder> {
  const rows = queryAll<FolderRow>(
    db,
    'SELECT Z_PK, ZTITLE2, ZPARENT, ZIDENTIFIER, ZFOLDERTYPE, ZOWNER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?',
    entityKeys.ICFolder,
  );

  // Build a lookup map from Z_PK → FolderRow for parent chain walking
  const folderMap = new Map<number, FolderRow>();
  for (const row of rows) {
    folderMap.set(row.Z_PK, row);
  }

  // Build account lookup by Z_PK → ANAccount (ZOWNER references account Z_PK indirectly)
  // We need to also map account Z_PKs for multi-account prefix logic
  const accountRows = queryAll<AccountRow>(
    db,
    'SELECT Z_PK, ZNAME, ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?',
    entityKeys.ICAccount,
  );
  const accountByPk = new Map<number, ANAccount>();
  for (const aRow of accountRows) {
    const account = accounts.find((a) => a.uuid === aRow.ZIDENTIFIER);
    if (account) {
      accountByPk.set(aRow.Z_PK, account);
    }
  }

  const multiAccount = accounts.length > 1;
  const result = new Map<number, ResolvedFolder>();

  for (const row of rows) {
    // Skip smart folders
    if (row.ZFOLDERTYPE === ANFolderType.Smart) continue;

    // Skip trash folders unless opted-in
    if (row.ZFOLDERTYPE === ANFolderType.Trash && !opts?.includeTrashed) continue;

    // Build the relative path for this folder. We nest notes under a 'notes' subdirectory.
    const relativePath = join('notes', buildFolderPath(row.Z_PK, folderMap, accountByPk, multiAccount));
    const outputPath = join(exportDest, relativePath);

    // Create the directory on disk
    mkdirSync(outputPath, { recursive: true });

    result.set(row.Z_PK, {
      outputPath,
      ownerAccountId: row.ZOWNER,
    });
  }

  return result;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Recursively build the relative output path for a folder by walking
 * the ZPARENT chain up to the root.
 *
 * - Default folders (ZIDENTIFIER starts with "DefaultFolder") map to the export root.
 * - Multi-account mode prefixes each tree with the account name.
 */
export function buildFolderPath(
  folderPk: number,
  folderMap: Map<number, FolderRow>,
  accountByPk: Map<number, ANAccount>,
  multiAccount: boolean,
): string {
  const segments: string[] = [];
  let currentPk: number | null = folderPk;
  const seenPks = new Set<number>();

  while (currentPk !== null) {
    if (seenPks.has(currentPk)) {
      // Prevent infinite loops on corrupted databases with circular references
      break;
    }
    seenPks.add(currentPk);

    const folder = folderMap.get(currentPk);
    if (!folder) break;

    // Default folder maps to the export root — don't add a path segment
    if (folder.ZIDENTIFIER?.startsWith('DefaultFolder')) {
      // If multi-account, still prefix with account name
      if (multiAccount) {
        const account = accountByPk.get(folder.ZOWNER);
        if (account) {
          segments.push(sanitizeFileName(account.name));
        }
      }
      break;
    }

    // Add this folder's title as a path segment
    const title = folder.ZTITLE2 ?? 'Untitled Folder';
    segments.push(sanitizeFileName(title));

    // Walk up to the parent
    currentPk = folder.ZPARENT;
  }

  // Segments were accumulated leaf→root, so reverse for root→leaf
  segments.reverse();
  return join(...(segments.length > 0 ? segments : ['.']));
}

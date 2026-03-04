/**
 * Scan Converter — CRDT Scan Document → Markdown attachment links.
 *
 * Apple Notes stores scanned documents as CRDT structures (MergableDataProto).
 * Each scan page's UUID is extracted from the CRDT, queried against the DB
 * to resolve on-disk paths, and converted to Markdown image links.
 *
 * Ported from obsidian-importer's convert-scan.ts (MIT License).
 */

import type { Database } from 'bun:sqlite';
import type {
  ANMergableDataProto,
  EntityKeys,
  AttachmentRow,
} from './types.ts';
import { ANAttachmentUTI } from './types.ts';
import { queryOne } from './db.ts';
import {
  buildAttachmentSourcePath,
  copyAttachmentFile,
} from './attachments.ts';

/**
 * Convert a decoded scan document (MergableDataProto) to Markdown image links.
 *
 * Each page of the scanned document is resolved as:
 * 1. A preview JPEG (Previews/<ID>-1-<W>x<H>-0.jpeg) — the cropped version
 * 2. Fallback to raw media if the preview isn't available
 *
 * @param proto - The decoded CRDT protobuf for the scan.
 * @param db - The bun:sqlite Database instance.
 * @param entityKeys - Entity type lookup map.
 * @param accountPath - Absolute path to the account's data directory.
 * @param exportDest - Absolute path to the export destination directory.
 * @returns Markdown string with image links for each scan page.
 */
export async function convertScanToMarkdown(
  proto: ANMergableDataProto,
  db: Database,
  entityKeys: EntityKeys,
  accountPath: string,
  exportDest: string,
): Promise<string> {
  const objects = proto.mergableDataObject.mergeableDataObjectData.mergeableDataObjectEntry;
  const links: string[] = [];

  for (const object of objects) {
    if (!object.customMap) continue;

    const imageUuid = object.customMap.mapEntry[0]?.value.stringValue;
    if (!imageUuid) continue;

    // Query attachment info for this scan page
    const row = queryOne<AttachmentRow>(
      db,
      `SELECT Z_PK, ZMEDIA, ZTYPEUTI, ZIDENTIFIER, ZSIZEHEIGHT, ZSIZEWIDTH,
              ZCREATIONDATE, ZMODIFICATIONDATE, ZNOTE
       FROM ziccloudsyncingobject
       WHERE zidentifier = ?`,
      imageUuid,
    );

    if (!row) {
      links.push('**(cannot decode scan page)**');
      continue;
    }

    // Try the cropped preview version first
    const scanSourcePath = buildAttachmentSourcePath(ANAttachmentUTI.Scan, {
      ZIDENTIFIER: row.ZIDENTIFIER,
      ZSIZEWIDTH: row.ZSIZEWIDTH,
      ZSIZEHEIGHT: row.ZSIZEHEIGHT,
    });

    const scanLink = await copyAttachmentFile(
      scanSourcePath,
      accountPath,
      exportDest,
      `Scan Page.jpg`,
    );

    if (scanLink) {
      links.push(scanLink);
      continue;
    }

    // Fallback to raw media if cropped version fails
    if (row.ZMEDIA) {
      const mediaRow = queryOne<AttachmentRow>(
        db,
        `SELECT ZIDENTIFIER, ZFILENAME, ZGENERATION1
         FROM (SELECT *, NULL AS ZGENERATION1 FROM ziccloudsyncingobject)
         WHERE Z_ENT = ? AND Z_PK = ?`,
        entityKeys.ICMedia,
        row.ZMEDIA,
      );

      if (mediaRow?.ZFILENAME) {
        const mediaSourcePath = buildAttachmentSourcePath('default', {
          ZIDENTIFIER: mediaRow.ZIDENTIFIER,
          ZGENERATION1: mediaRow.ZGENERATION1,
          ZFILENAME: mediaRow.ZFILENAME,
        });

        const mediaLink = await copyAttachmentFile(
          mediaSourcePath,
          accountPath,
          exportDest,
          mediaRow.ZFILENAME,
        );

        if (mediaLink) {
          links.push(mediaLink);
          continue;
        }
      }
    }

    links.push('**(cannot decode scan page)**');
  }

  if (links.length === 0) return '';
  return `\n${links.join('\n')}\n`;
}

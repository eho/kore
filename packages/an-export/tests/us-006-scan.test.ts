import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { convertScanToMarkdown } from '../src/scan-converter.ts';
import type { EntityKeys, ANMergableDataProto } from '../src/types.ts';

let tempDir: string;
let db: Database;
let entityKeys: EntityKeys;

function setupTestDb(): void {
  tempDir = join(tmpdir(), `scan-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  db = new Database(join(tempDir, 'test.db'));
  db.run(`CREATE TABLE ziccloudsyncingobject (
    Z_PK INTEGER PRIMARY KEY,
    Z_ENT INTEGER,
    ZIDENTIFIER TEXT,
    ZFILENAME TEXT,
    ZTYPEUTI TEXT,
    ZGENERATION1 TEXT,
    ZSIZEHEIGHT INTEGER,
    ZSIZEWIDTH INTEGER,
    ZMEDIA INTEGER,
    ZCREATIONDATE REAL,
    ZMODIFICATIONDATE REAL,
    ZNOTE INTEGER
  )`);

  entityKeys = {
    ICAccount: 1,
    ICFolder: 2,
    ICNote: 3,
    ICAttachment: 4,
    ICMedia: 5,
  };
}

function cleanupTestDb(): void {
  try { db.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

function buildMockScanProto(pageUuids: string[]): ANMergableDataProto {
  return {
    mergableDataObject: {
      mergeableDataObjectData: {
        mergeableDataObjectEntry: pageUuids.map(uuid => ({
          customMap: {
            mapEntry: [{ value: { stringValue: uuid } }]
          }
        }))
      }
    }
  } as any;
}

describe('Scan Converter', () => {
  beforeEach(setupTestDb);
  afterEach(cleanupTestDb);

  test('resolves scan page using cropped preview', async () => {
    // Insert scan page attachment
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZSIZEWIDTH, ZSIZEHEIGHT)
       VALUES (1, 4, 'page1', 800, 600)`
    );

    const proto = buildMockScanProto(['page1']);
    
    // Create the dummy preview file
    const accountDir = join(tempDir, 'account');
    const previewsDir = join(accountDir, 'Previews');
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, 'page1-1-800x600-0.jpeg'), 'preview-data');

    const exportDest = join(tempDir, 'export');
    
    const result = await convertScanToMarkdown(proto, db, entityKeys, accountDir, exportDest, undefined, exportDest);
    
    expect(result).toBe('\n![](attachments/Scan%20Page.jpg)\n');
    expect(existsSync(join(exportDest, 'attachments', 'Scan Page.jpg'))).toBe(true);
  });

  test('falls back to raw media if cropped preview is missing', async () => {
    // Insert scan page attachment pointing to generic media
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZSIZEWIDTH, ZSIZEHEIGHT, ZMEDIA)
       VALUES (1, 4, 'page1', 800, 600, 2)`
    );
    // Insert media row
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1)
       VALUES (2, 5, 'media-uuid', 'raw-scan.jpg', 'gen1')`
    );

    const proto = buildMockScanProto(['page1']);
    
    // Do NOT create the preview file. Instead create the raw media file.
    const accountDir = join(tempDir, 'account');
    const mediaDir = join(accountDir, 'Media', 'media-uuid', 'gen1');
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, 'raw-scan.jpg'), 'raw-data');

    const exportDest = join(tempDir, 'export');
    
    const result = await convertScanToMarkdown(proto, db, entityKeys, accountDir, exportDest, undefined, exportDest);
    
    expect(result).toBe('\n![](attachments/raw-scan.jpg)\n');
    expect(existsSync(join(exportDest, 'attachments', 'raw-scan.jpg'))).toBe(true);
  });

  test('returns cannot decode if DB row missing', async () => {
    const proto = buildMockScanProto(['missing-page']);
    const result = await convertScanToMarkdown(proto, db, entityKeys, tempDir, tempDir, undefined, tempDir);
    expect(result).toBe('\n**(cannot decode scan page)**\n');
  });

  test('returns cannot decode if raw media file is missing', async () => {
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZSIZEWIDTH, ZSIZEHEIGHT, ZMEDIA)
       VALUES (1, 4, 'page1', 800, 600, 2)`
    );
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1)
       VALUES (2, 5, 'media-uuid', 'missing.jpg', 'gen1')`
    );
    const proto = buildMockScanProto(['page1']);
    // Do NOT create the preview or media file
    const result = await convertScanToMarkdown(proto, db, entityKeys, tempDir, tempDir, undefined, tempDir);
    expect(result).toBe('\n**(cannot decode scan page)**\n');
  });

  test('returns cannot decode if both preview and media are missing', async () => {
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZSIZEWIDTH, ZSIZEHEIGHT)
       VALUES (1, 4, 'page1', 800, 600)`
    );

    const proto = buildMockScanProto(['page1']);
    // Notice we don't create any files in the temp directory.
    const result = await convertScanToMarkdown(proto, db, entityKeys, tempDir, tempDir, undefined, tempDir);
    
    expect(result).toBe('\n**(cannot decode scan page)**\n');
  });

  test('returns empty string if no valid objects found', async () => {
    const proto: ANMergableDataProto = {
      mergableDataObject: {
        mergeableDataObjectData: {
          mergeableDataObjectEntry: [
            // No customMap
            { customMap: null } as any
          ]
        }
      }
    };
    const result = await convertScanToMarkdown(proto, db, entityKeys, tempDir, tempDir, undefined, tempDir);
    expect(result).toBe('');
  });
});

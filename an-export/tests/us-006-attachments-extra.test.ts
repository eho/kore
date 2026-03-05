
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

import {
  createAttachmentResolver,
  getAttachmentBinary,
} from '../src/attachments.ts';
import type { EntityKeys } from '../src/types.ts';
import { ANAttachmentUTI } from '../src/types.ts';

let tempDir: string;
let db: Database;
let entityKeys: EntityKeys;

function setupTestDb(): void {
  tempDir = join(tmpdir(), `attach-extra-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  db = new Database(join(tempDir, 'test.db'));
  db.run(`CREATE TABLE ziccloudsyncingobject (
    Z_PK INTEGER PRIMARY KEY,
    Z_ENT INTEGER,
    ZIDENTIFIER TEXT,
    ZALTTEXT TEXT,
    ZTOKENCONTENTIDENTIFIER TEXT,
    ZTITLE TEXT,
    ZURLSTRING TEXT,
    ZMEDIA INTEGER,
    ZFILENAME TEXT,
    ZTYPEUTI TEXT,
    ZGENERATION1 TEXT,
    ZFALLBACKPDFGENERATION TEXT,
    ZFALLBACKIMAGEGENERATION TEXT,
    ZSIZEHEIGHT INTEGER,
    ZSIZEWIDTH INTEGER,
    ZHANDWRITINGSUMMARY TEXT,
    ZCREATIONDATE REAL,
    ZMODIFICATIONDATE REAL,
    ZNOTE INTEGER,
    ZMERGEABLEDATA1 BLOB
  )`);

  entityKeys = { ICAccount: 1, ICFolder: 2, ICNote: 3, ICAttachment: 4, ICMedia: 5 };
}

function cleanupTestDb(): void {
  try { db.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

describe('Attachment Edge Cases', () => {
  beforeEach(setupTestDb);
  afterEach(cleanupTestDb);

  test('InternalLink returns empty if ZTOKENCONTENTIDENTIFIER missing', async () => {
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'link1')`
    );
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'link1', typeUti: ANAttachmentUTI.InternalLink })).toBe('');
  });

  test('Table returns (empty table) if ZHEXDATA missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'table1')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'table1', typeUti: ANAttachmentUTI.Table })).toBe('**(empty table)**');
  });

  test('Table decodes table when hex data is provided', async () => {
    const validGzipBuffer = Buffer.from('1f8b0800000000000013958eb10ac230144593a8f1993ae813111f0ed2d1a1847c8150171787ea0fd812c492b6d22aeefe89e0874a5044dc1ccf3def712f3e04dd05f573059c24301403f6078d922106cdb13c383bcfac730b0101f58d52a084162874fb432d14ba43b31b9faab1ea620718728d2fc7d05fb31fbb7c5b8efe9bd12c2760af6add25093e0792e07b6428b33aa9ae4dd8cbeab87297a26cc2c04f7ac362925545b43f9d9c8dcaea6c9b681deff6a9b3df224e56bb68b3dd5c8ad4d6866bc397860f0c9f3f01edf5e15a27010000', 'hex');
    db.run(
      `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZMERGEABLEDATA1) VALUES (1, 4, 'table1', ?)`,
      [validGzipBuffer]
    );
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    const result = await resolve({ attachmentIdentifier: 'table1', typeUti: ANAttachmentUTI.Table });
    expect(result).toBe('\n|  |\n| -- |\n\n');
  });

  test('UrlCard returns empty if ZURLSTRING missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'url1')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'url1', typeUti: ANAttachmentUTI.UrlCard })).toBe('');
  });

  test('Scan falls back to ModifiedScan if ZHEXDATA missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'scan1')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'scan1', typeUti: ANAttachmentUTI.Scan })).toBe('**(error reading attachment)**');
  });

  test('Scan decodes when hex data is provided', async () => {
    const validGzipBuffer = Buffer.from('1f8b0800000000000013958eb10ac230144593a8f1993ae813111f0ed2d1a1847c8150171787ea0fd812c492b6d22aeefe89e0874a5044dc1ccf3def712f3e04dd05f573059c24301403f6078d922106cdb13c383bcfac730b0101f58d52a084162874fb432d14ba43b31b9faab1ea620718728d2fc7d05fb31fbb7c5b8efe9bd12c2760af6add25093e0792e07b6428b33aa9ae4dd8cbeab87297a26cc2c04f7ac362925545b43f9d9c8dcaea6c9b681deff6a9b3df224e56bb68b3dd5c8ad4d6866bc397860f0c9f3f01edf5e15a27010000', 'hex');
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZMERGEABLEDATA1) VALUES (1, 4, 'scan1', ?)`, [validGzipBuffer]);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'scan1', typeUti: ANAttachmentUTI.Scan })).toBe('');
  });

  test('ModifiedScan returns unknown if row missing', async () => {
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'modscan1', typeUti: ANAttachmentUTI.ModifiedScan })).toBe('**(unknown attachment: modified scan)**');
  });

  test('ModifiedScan returns error if file copy fails (missing source)', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'modscan1')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'modscan1', typeUti: ANAttachmentUTI.ModifiedScan })).toBe('**(error reading attachment)**');
  });

  test('ModifiedScan returns copied file link with handwriting summary', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFALLBACKPDFGENERATION, ZHANDWRITINGSUMMARY)
            VALUES (1, 4, 'modscan2', 'gen1', 'Hello\nWorld')`);
    const pdfDir = join(tempDir, 'FallbackPDFs', 'modscan2', 'gen1');
    mkdirSync(pdfDir, { recursive: true });
    writeFileSync(join(pdfDir, 'FallbackPDF.pdf'), 'fake');
    const exportDest = join(tempDir, 'export');
    mkdirSync(exportDest, { recursive: true });

    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest, includeHandwriting: true, outputDir: exportDest });
    const result = await resolve({ attachmentIdentifier: 'modscan2', typeUti: ANAttachmentUTI.ModifiedScan });
    expect(result).toBe('\n> [!Handwriting]-\n> Hello\n> World[Scan.pdf](attachments/Scan.pdf)');
  });

  test('Drawing returns unknown if row missing', async () => {
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'draw1', typeUti: ANAttachmentUTI.Drawing })).toBe('**(unknown attachment: drawing)**');
  });

  test('Drawing copies file and applies handwriting', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFALLBACKIMAGEGENERATION, ZHANDWRITINGSUMMARY)
            VALUES (1, 4, 'draw2', 'genX', 'Drawn stuff')`);
    const drawDir = join(tempDir, 'FallbackImages', 'draw2', 'genX');
    mkdirSync(drawDir, { recursive: true });
    writeFileSync(join(drawDir, 'FallbackImage.png'), 'fake-png');
    const exportDest = join(tempDir, 'export');

    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest, includeHandwriting: true, outputDir: exportDest });
    const result = await resolve({ attachmentIdentifier: 'draw2', typeUti: ANAttachmentUTI.Drawing });
    expect(result).toBe('\n> [!Handwriting]-\n> Drawn stuff![](attachments/Drawing.png)');
  });

  test('General media returns unknown if ZMEDIA missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (1, 4, 'media1')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'media1', typeUti: 'public.jpeg' })).toBe(' **(unknown attachment: public.jpeg)** ');
  });

  test('General media returns unknown if ZFILENAME missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZMEDIA) VALUES (1, 4, 'media2', 2)`);
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER) VALUES (2, 5, 'icmedia')`); // no ZFILENAME
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'media2', typeUti: 'public.jpeg' })).toBe(' **(unknown attachment: public.jpeg)** ');
  });

  test('General media returns error if source file is missing', async () => {
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZMEDIA) VALUES (1, 4, 'media3', 3)`);
    db.run(`INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME) VALUES (3, 5, 'icmedia', 'test.jpg')`);
    const resolve = createAttachmentResolver({ db, entityKeys, accountPath: tempDir, exportDest: tempDir, outputDir: tempDir });
    expect(await resolve({ attachmentIdentifier: 'media3', typeUti: 'public.jpeg' })).toBe('**(error reading attachment)**');
  });

  test('getAttachmentBinary gracefully handles readFileSync throwing (eACCES or similar)', () => {
    const dir = join(tempDir, 'invalid-dir');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'test.txt');
    // Write a directory where a file should be to force a read error
    mkdirSync(filePath);
    
    // Test accountPath error branch
    const buf = getAttachmentBinary(dir, 'test.txt');
    expect(buf).toBeNull(); // Should catch the EISDIR and fall through to global which also fails
  });
});

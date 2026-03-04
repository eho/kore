/**
 * Unit tests for US-006: Attachment Extraction.
 *
 * Tests the attachment resolution logic with mocked DB queries and filesystem,
 * covering all attachment UTI types and source path construction.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildAttachmentSourcePath,
  copyAttachmentFile,
  getAttachmentBinary,
  createAttachmentResolver,
} from '../src/attachments.ts';
import type { AttachmentRow, EntityKeys, ANAttachmentInfo } from '../src/types.ts';
import { ANAttachmentUTI } from '../src/types.ts';

// ─── Test Helpers ────────────────────────────────────────────────────────────

let tempDir: string;
let db: Database;
let entityKeys: EntityKeys;

function setupTestDb(): void {
  tempDir = join(tmpdir(), `us006-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  db = new Database(join(tempDir, 'test.db'));

  // Create minimal tables needed for attachment queries
  // Column names must be uppercase to match Apple Notes CoreData schema
  // (bun:sqlite returns column names using the casing from the schema)
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

  entityKeys = {
    ICAccount: 1,
    ICFolder: 2,
    ICNote: 3,
    ICAttachment: 4,
    ICMedia: 5,
  };
}

function cleanupTestDb(): void {
  try {
    db.close();
  } catch {
    // ignore
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('US-006: Attachment Extraction', () => {
  // ── buildAttachmentSourcePath ──

  describe('buildAttachmentSourcePath', () => {
    test('builds ModifiedScan path: FallbackPDFs/<ID>/<GEN>/FallbackPDF.pdf', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.ModifiedScan, {
        ZIDENTIFIER: 'abc-123',
        ZFALLBACKPDFGENERATION: 'gen1',
      });
      expect(path).toBe(join('FallbackPDFs', 'abc-123', 'gen1', 'FallbackPDF.pdf'));
    });

    test('builds ModifiedScan path without generation', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.ModifiedScan, {
        ZIDENTIFIER: 'abc-123',
        ZFALLBACKPDFGENERATION: null,
      });
      expect(path).toBe(join('FallbackPDFs', 'abc-123', '', 'FallbackPDF.pdf'));
    });

    test('builds Scan path: Previews/<ID>-1-<W>x<H>-0.jpeg', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.Scan, {
        ZIDENTIFIER: 'scan-uuid',
        ZSIZEWIDTH: 1024,
        ZSIZEHEIGHT: 768,
      });
      expect(path).toBe(join('Previews', 'scan-uuid-1-1024x768-0.jpeg'));
    });

    test('builds Drawing path with generation (newer macOS)', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.Drawing, {
        ZIDENTIFIER: 'draw-uuid',
        ZFALLBACKIMAGEGENERATION: 'gen2',
      });
      expect(path).toBe(
        join('FallbackImages', 'draw-uuid', 'gen2', 'FallbackImage.png'),
      );
    });

    test('builds Drawing path without generation (older macOS)', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.Drawing, {
        ZIDENTIFIER: 'draw-uuid',
        ZFALLBACKIMAGEGENERATION: null,
      });
      expect(path).toBe(join('FallbackImages', 'draw-uuid.jpg'));
    });

    test('builds DrawingLegacy path same as Drawing', () => {
      const path = buildAttachmentSourcePath(ANAttachmentUTI.DrawingLegacy, {
        ZIDENTIFIER: 'legacy-draw',
        ZFALLBACKIMAGEGENERATION: null,
      });
      expect(path).toBe(join('FallbackImages', 'legacy-draw.jpg'));
    });

    test('builds default media path: Media/<ID>/<GEN>/<FILENAME>', () => {
      const path = buildAttachmentSourcePath('default', {
        ZIDENTIFIER: 'media-uuid',
        ZGENERATION1: 'gen1',
        ZFILENAME: 'photo.jpeg',
      });
      expect(path).toBe(join('Media', 'media-uuid', 'gen1', 'photo.jpeg'));
    });

    test('builds default media path without generation', () => {
      const path = buildAttachmentSourcePath('default', {
        ZIDENTIFIER: 'media-uuid',
        ZGENERATION1: null,
        ZFILENAME: 'audio.m4a',
      });
      expect(path).toBe(join('Media', 'media-uuid', '', 'audio.m4a'));
    });
  });

  // ── getAttachmentBinary ──

  describe('getAttachmentBinary', () => {
    beforeEach(setupTestDb);
    afterEach(cleanupTestDb);

    test('reads from account path when file exists', () => {
      const accountDir = join(tempDir, 'account');
      const mediaDir = join(accountDir, 'Media', 'uuid1');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'test.jpg'), 'fake-image-data');

      const binary = getAttachmentBinary(
        accountDir,
        join('Media', 'uuid1', 'test.jpg'),
      );
      expect(binary).not.toBeNull();
      expect(binary!.toString()).toBe('fake-image-data');
    });

    test('returns null when file does not exist in either path', () => {
      const binary = getAttachmentBinary(
        join(tempDir, 'nonexistent'),
        'Media/uuid1/test.jpg',
      );
      expect(binary).toBeNull();
    });
  });

  // ── copyAttachmentFile ──

  describe('copyAttachmentFile', () => {
    beforeEach(setupTestDb);
    afterEach(cleanupTestDb);

    test('copies file to <dest>/attachments/ and returns markdown image link', async () => {
      // Set up source file in account path
      const accountDir = join(tempDir, 'account');
      const mediaDir = join(accountDir, 'Media', 'uuid1');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'photo.jpg'), 'fake-jpeg-data');

      const exportDest = join(tempDir, 'export');
      mkdirSync(exportDest, { recursive: true });

      const result = await copyAttachmentFile(
        join('Media', 'uuid1', 'photo.jpg'),
        accountDir,
        exportDest,
        'photo.jpg',
      );

      expect(result).toBe('![](attachments/photo.jpg)');
      expect(existsSync(join(exportDest, 'attachments', 'photo.jpg'))).toBe(true);
    });

    test('returns file link for non-image files', async () => {
      const accountDir = join(tempDir, 'account');
      const mediaDir = join(accountDir, 'FallbackPDFs', 'uuid1');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'FallbackPDF.pdf'), 'fake-pdf');

      const exportDest = join(tempDir, 'export');
      mkdirSync(exportDest, { recursive: true });

      const result = await copyAttachmentFile(
        join('FallbackPDFs', 'uuid1', 'FallbackPDF.pdf'),
        accountDir,
        exportDest,
        'Scan.pdf',
      );

      expect(result).toBe('[Scan.pdf](attachments/Scan.pdf)');
    });

    test('returns null when source file not found', async () => {
      const exportDest = join(tempDir, 'export');
      mkdirSync(exportDest, { recursive: true });

      const result = await copyAttachmentFile(
        'Media/nonexistent/file.jpg',
        join(tempDir, 'nonexistent-account'),
        exportDest,
        'file.jpg',
      );

      expect(result).toBeNull();
    });

    test('generates unique filename when file already exists', async () => {
      const accountDir = join(tempDir, 'account');
      const mediaDir = join(accountDir, 'Media', 'uuid1');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'photo.jpg'), 'image-data');

      const exportDest = join(tempDir, 'export');
      const attachDir = join(exportDest, 'attachments');
      mkdirSync(attachDir, { recursive: true });
      // Pre-create the file
      writeFileSync(join(attachDir, 'photo.jpg'), 'existing');

      const result = await copyAttachmentFile(
        join('Media', 'uuid1', 'photo.jpg'),
        accountDir,
        exportDest,
        'photo.jpg',
      );

      expect(result).toBe('![](attachments/photo 1.jpg)');
      expect(existsSync(join(attachDir, 'photo 1.jpg'))).toBe(true);
    });
  });

  // ── createAttachmentResolver ──

  describe('createAttachmentResolver', () => {
    beforeEach(setupTestDb);
    afterEach(cleanupTestDb);

    test('resolves hashtag to plain text from ZALTTEXT', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZALTTEXT)
         VALUES (1, 4, 'hashtag-uuid', '#MyTag')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'hashtag-uuid',
        typeUti: ANAttachmentUTI.Hashtag,
      });
      expect(result).toBe('#MyTag');
    });

    test('resolves mention to plain text from ZALTTEXT', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZALTTEXT)
         VALUES (1, 4, 'mention-uuid', '@JohnDoe')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'mention-uuid',
        typeUti: ANAttachmentUTI.Mention,
      });
      expect(result).toBe('@JohnDoe');
    });

    test('resolves internal link with resolveNoteLink callback', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZTOKENCONTENTIDENTIFIER)
         VALUES (1, 4, 'link-uuid', 'target-note-uuid')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
        resolveNoteLink: (uuid) =>
          uuid === 'target-note-uuid' ? 'My Important Note' : undefined,
      });

      const result = await resolve({
        attachmentIdentifier: 'link-uuid',
        typeUti: ANAttachmentUTI.InternalLink,
      });
      expect(result).toBe('[[My Important Note]]');
    });

    test('resolves internal link falls back to UUID when title not found', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZTOKENCONTENTIDENTIFIER)
         VALUES (1, 4, 'link-uuid', 'unknown-note-uuid')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'link-uuid',
        typeUti: ANAttachmentUTI.InternalLink,
      });
      expect(result).toBe('[[unknown-note-uuid]]');
    });

    test('resolves URL card to [**Title**](url)', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE, ZURLSTRING)
         VALUES (1, 4, 'url-uuid', 'Example', 'https://example.com')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'url-uuid',
        typeUti: ANAttachmentUTI.UrlCard,
      });
      expect(result).toBe('[**Example**](https://example.com)');
    });

    test('URL card falls back to URL when title is null', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZURLSTRING)
         VALUES (1, 4, 'url-uuid', 'https://no-title.com')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'url-uuid',
        typeUti: ANAttachmentUTI.UrlCard,
      });
      expect(result).toBe('[**https://no-title.com**](https://no-title.com)');
    });

    test('returns unknown attachment for unrecognized type with no media', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER)
         VALUES (1, 4, 'unknown-uuid')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'unknown-uuid',
        typeUti: 'com.apple.unknown',
      });
      expect(result).toContain('unknown attachment');
      expect(result).toContain('com.apple.unknown');
    });

    test('resolves general media attachment with correct path', async () => {
      // Create attachment row pointing to media
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZMEDIA)
         VALUES (10, 4, 'attach-uuid', 20)`,
      );
      // Create media row
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1, ZMEDIA)
         VALUES (20, 5, 'media-uuid', 'vacation.jpg', 'gen1', 20)`,
      );

      // Create the source file
      const accountDir = join(tempDir, 'account');
      const mediaDir = join(accountDir, 'Media', 'media-uuid', 'gen1');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'vacation.jpg'), 'jpeg-binary');

      const exportDest = join(tempDir, 'export');
      mkdirSync(exportDest, { recursive: true });

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: accountDir,
        exportDest,
      });

      const result = await resolve({
        attachmentIdentifier: 'attach-uuid',
        typeUti: 'public.jpeg',
      });

      expect(result).toBe('![](attachments/vacation.jpg)');
      expect(existsSync(join(exportDest, 'attachments', 'vacation.jpg'))).toBe(true);
    });

    test('returns empty string for hashtag with missing ZALTTEXT', async () => {
      db.run(
        `INSERT INTO ziccloudsyncingobject (Z_PK, Z_ENT, ZIDENTIFIER)
         VALUES (1, 4, 'hashtag-uuid')`,
      );

      const resolve = createAttachmentResolver({
        db,
        entityKeys,
        accountPath: tempDir,
        exportDest: tempDir,
      });

      const result = await resolve({
        attachmentIdentifier: 'hashtag-uuid',
        typeUti: ANAttachmentUTI.Hashtag,
      });
      expect(result).toBe('');
    });
  });
});

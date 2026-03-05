import { describe, it, expect } from 'bun:test';
import { decodeNoteData } from '../src/decoder.ts';
import { gzipSync, deflateSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { descriptor } from '../src/descriptor.ts';

describe('decodeNoteData', () => {
  it('decodes GZIP compressed protobuf data', async () => {
    const root = protobuf.Root.fromJSON(descriptor);
    const DocumentType = root.lookupType('ciofecaforensics.Document');
    const msg = DocumentType.create({ version: 1, note: { noteText: 'Hello GZIP' } });
    const buffer = gzipSync(DocumentType.encode(msg).finish());
    
    const result = await decodeNoteData(buffer.toString('hex'));
    expect(result.note.noteText).toBe('Hello GZIP');
  });

  it('decodes ZLIB compressed protobuf data', async () => {
    const root = protobuf.Root.fromJSON(descriptor);
    const DocumentType = root.lookupType('ciofecaforensics.Document');
    const msg = DocumentType.create({ version: 1, note: { noteText: 'Hello ZLIB' } });
    const buffer = deflateSync(DocumentType.encode(msg).finish());
    
    const result = await decodeNoteData(buffer.toString('hex'));
    expect(result.note.noteText).toBe('Hello ZLIB');
  });

  it('returns an empty document for gracefully handled corrupted data', async () => {
    // 1f8b indicates GZIP but payload is corrupted
    const corruptedHex = '1f8b000000000000deadbeef';
    const result = await decodeNoteData(corruptedHex);
    expect(result).toBeDefined();
    expect(result.note.noteText).toBe('');
    expect(result.note.attributeRun).toEqual([]);
  });
});

import { gunzipSync, inflateSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { descriptor } from './descriptor';
import type { ANDocument, ANMergableDataProto } from './types';

// Initialize protobuf root
const root = protobuf.Root.fromJSON(descriptor);

// Lookup the message types
const DocumentType = root.lookupType('ciofecaforensics.Document');
const MergableDataProtoType = root.lookupType('ciofecaforensics.MergableDataProto');

/**
 * Decodes GZIP-compressed protobuf hex string into an ANDocument object.
 */
export function decodeNoteData(hexData: string): ANDocument {
  if (!hexData) return { note: { noteText: '', attributeRun: [] } } as unknown as ANDocument;

  const buf = Buffer.from(hexData, 'hex');

  // GZIP magic number: 1F 8B (31, 139)
  // ZLIB deflate magic number commonly used by Apple Notes: 78 9C (120, 156)
  let unzipped: Buffer;
  try {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      unzipped = gunzipSync(buf);
    } else if (buf.length >= 2 && buf[0] === 0x78 && buf[1] === 0x9c) {
      unzipped = inflateSync(buf);
    } else {
      unzipped = buf; // Try raw if no compression headers found
    }
  } catch (err: any) {
    if (err.message && err.message.includes('unexpected end of file')) {
      return { note: { noteText: '', attributeRun: [] } } as unknown as ANDocument;
    }
    throw err;
  }

  const message = DocumentType.decode(unzipped);
  return DocumentType.toObject(message, {
    longs: Number,
    enums: Number,
    bytes: Buffer,
  }) as unknown as ANDocument;
}

/**
 * Decodes GZIP-compressed protobuf hex string into an ANMergableDataProto object
 * (used for tables, scans, etc.).
 */
export function decodeMergeableData(hexdata: string): ANMergableDataProto {
  const buffer = Buffer.from(hexdata, 'hex');
  const isZlib = buffer[0] === 0x78;
  const decompressed = isZlib ? inflateSync(buffer) : gunzipSync(buffer);
  const message = MergableDataProtoType.decode(decompressed);
  return MergableDataProtoType.toObject(message, {
    longs: Number,
    enums: Number,
    bytes: Buffer,
  }) as unknown as ANMergableDataProto;
}

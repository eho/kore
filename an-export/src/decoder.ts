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
export function decodeNoteData(hexdata: string): ANDocument {
  const buffer = Buffer.from(hexdata, 'hex');
  const isZlib = buffer[0] === 0x78;
  const decompressed = isZlib ? inflateSync(buffer) : gunzipSync(buffer);
  const message = DocumentType.decode(decompressed);
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

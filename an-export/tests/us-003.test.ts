import { describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { descriptor } from '../src/descriptor';
import { decodeNoteData, decodeMergeableData } from '../src/decoder';

const root = protobuf.Root.fromJSON(descriptor);
const DocumentType = root.lookupType('ciofecaforensics.Document');
const MergableDataProtoType = root.lookupType('ciofecaforensics.MergableDataProto');

describe('US-003: Protobuf Schema and Decoder', () => {
  it('should successfully decode a mock GZIP-compressed note document', () => {
    const mockNote = {
      version: 1,
      note: {
        noteText: 'Hello, World!',
        attributeRun: [
          {
            length: 13,
            fontWeight: 1,
          }
        ]
      }
    };

    // Create the message and verify it
    const message = DocumentType.create(mockNote);
    const encoded = DocumentType.encode(message).finish();
    const gzipped = gzipSync(encoded);
    const hexdata = gzipped.toString('hex');

    // Decode using our function
    const decoded = decodeNoteData(hexdata);

    // Assert structure
    expect(decoded).toBeDefined();
    expect(decoded.note).toBeDefined();
    expect(decoded.note.noteText).toBe('Hello, World!');
    expect(decoded.note.attributeRun).toBeArray();
    expect(decoded.note.attributeRun.length).toBe(1);
    expect(decoded.note.attributeRun[0]!.length).toBe(13);
    expect(decoded.note.attributeRun[0]!.fontWeight).toBe(1);
  });

  it('should successfully decode a mock GZIP-compressed mergeable data object', () => {
    const mockMergableData = {
      mergableDataObject: {
        version: 1,
        mergeableDataObjectData: {
          mergeableDataObjectKeyItem: ['crRows'],
          mergeableDataObjectTypeItem: ['com.apple.notes.ICTable']
        }
      }
    };

    const message = MergableDataProtoType.create(mockMergableData);
    const encoded = MergableDataProtoType.encode(message).finish();
    const gzipped = gzipSync(encoded);
    const hexdata = gzipped.toString('hex');

    const decoded = decodeMergeableData(hexdata);

    expect(decoded).toBeDefined();
    expect(decoded.mergableDataObject).toBeDefined();
    expect(decoded.mergableDataObject.mergeableDataObjectData.mergeableDataObjectKeyItem).toEqual(['crRows']);
    expect(decoded.mergableDataObject.mergeableDataObjectData.mergeableDataObjectTypeItem).toEqual(['com.apple.notes.ICTable']);
  });
});

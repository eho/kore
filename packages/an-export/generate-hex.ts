import { gzipSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { descriptor } from './src/descriptor.ts';
import { ANTableKey, ANTableType } from './src/types.ts';

const root = protobuf.Root.fromJSON(descriptor);
const MergableDataProtoType = root.lookupType('ciofecaforensics.MergableDataProto');

function uuid(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

function buildMockTableProto() {
  const rowOrderResolver = { customMap: { type: 1, mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(0) } }] } };
  const colOrderResolver = { customMap: { type: 1, mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(1) } }] } };
  const rowValueResolver = { customMap: { type: 1, mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(2) } }] } };
  const colValueResolver = { customMap: { type: 1, mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(3) } }] } };

  const cellNote = { note: { noteText: 'single cell', attributeRun: [{ length: 11 }] } };

  const rowData = { dictionary: { element: [{ key: { objectIndex: 2 }, value: { objectIndex: 4 } }] } };
  const cellCols = { dictionary: { element: [{ key: { objectIndex: 3 }, value: { objectIndex: 5 } }] } };

  const rowsOrderedSet = {
    orderedSet: {
      ordering: {
        array: { attachment: [{ index: 0, uuid: uuid('30') }] },
        contents: { element: [{ key: { objectIndex: 0 }, value: { objectIndex: 2 } }] }
      },
      elements: { element: [] }
    }
  };

  const colsOrderedSet = {
    orderedSet: {
      ordering: {
        array: { attachment: [{ index: 0, uuid: uuid('40') }] },
        contents: { element: [{ key: { objectIndex: 1 }, value: { objectIndex: 3 } }] }
      },
      elements: { element: [] }
    }
  };

  const rootTable = {
    customMap: {
      type: 0,
      mapEntry: [
        { key: 0, value: { objectIndex: 7 } },
        { key: 1, value: { objectIndex: 8 } },
        { key: 2, value: { objectIndex: 6 } }
      ]
    }
  };

  return {
    mergableDataObject: {
      mergeableDataObjectData: {
        mergeableDataObjectKeyItem: [ANTableKey.Rows, ANTableKey.Columns, ANTableKey.CellColumns],
        mergeableDataObjectTypeItem: [ANTableType.ICTable, ANTableType.Number],
        mergeableDataObjectUuidItem: [uuid('30'), uuid('40'), uuid('10'), uuid('20')],
        mergeableDataObjectEntry: [
          rowOrderResolver, colOrderResolver, rowValueResolver, colValueResolver,
          cellNote, rowData, cellCols, rowsOrderedSet, colsOrderedSet, rootTable
        ]
      }
    }
  };
}

const mockMergableData = buildMockTableProto();
const message = MergableDataProtoType.create(mockMergableData);
const encoded = MergableDataProtoType.encode(message).finish();
const gzipped = gzipSync(encoded);
const hexdata = gzipped.toString('hex');
console.log('HEX_FULL:', hexdata);

/**
 * Unit tests for US-005: Table Conversion.
 *
 * Tests the CRDT table → Markdown table conversion with mock structures
 * that replicate the Apple Notes CRDT indirection pattern.
 */

import { describe, expect, test } from 'bun:test';
import {
  convertTableToMarkdown,
  findLocations,
  getTargetUuid,
  formatTable,
} from '../src/table-converter.ts';
import type {
  ANMergableDataProto,
  ANTableObject,
  ANNote,
  ANObjectID,
} from '../src/types.ts';
import { ANTableKey, ANTableType } from '../src/types.ts';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Builds a UUID buffer from a simple hex string like "aabb".
 */
function uuid(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

/**
 * Creates a simple cell converter that extracts noteText directly.
 */
const simpleCellConverter = async (note: ANNote): Promise<string> => {
  return note.noteText.trim();
};

/**
 * Build a mock CRDT table proto with the given cell content.
 *
 * The structure mirrors Apple Notes' CRDT indirection:
 * - objects[0] = root ICTable with mapEntry referencing rows, columns, cellColumns
 * - objects[1] = rows OrderedSet
 * - objects[2] = columns OrderedSet
 * - objects[3] = cellColumns Dictionary
 * - objects[4..N] = UUID resolution objects + row dictionaries + cell Note objects
 */
function buildMockTableProto(
  rowContents: string[][],
): ANMergableDataProto {
  const numRows = rowContents.length;
  const numCols = numRows > 0 ? rowContents[0]!.length : 0;

  // Generate row and column UUIDs
  const rowUuids = Array.from({ length: numRows }, (_, i) =>
    uuid((0x10 + i).toString(16).padStart(2, '0')),
  );
  const colUuids = Array.from({ length: numCols }, (_, i) =>
    uuid((0x20 + i).toString(16).padStart(2, '0')),
  );

  // We need ordering UUIDs — these are the "key" UUIDs used in the ordering
  const rowOrderUuids = Array.from({ length: numRows }, (_, i) =>
    uuid((0x30 + i).toString(16).padStart(2, '0')),
  );
  const colOrderUuids = Array.from({ length: numCols }, (_, i) =>
    uuid((0x40 + i).toString(16).padStart(2, '0')),
  );

  // All UUIDs in the global list
  const allUuids = [
    ...rowOrderUuids,   // indices 0..numRows-1
    ...colOrderUuids,   // indices numRows..numRows+numCols-1
    ...rowUuids,        // indices numRows+numCols..numRows+numCols+numRows-1
    ...colUuids,        // indices numRows+numCols+numRows..end
  ];

  // Build objects array
  const objects: ANTableObject[] = [];

  // Helper: push an object and return its index
  const pushObj = (obj: ANTableObject): number => {
    objects.push(obj);
    return objects.length - 1;
  };

  // ── UUID resolution objects (one per UUID, maps to its index in allUuids) ──
  // For row order UUIDs
  const rowOrderResolvers: number[] = [];
  for (let i = 0; i < numRows; i++) {
    rowOrderResolvers.push(
      pushObj({
        customMap: {
          type: 1,
          mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(i) } }],
        },
        dictionary: null,
        orderedSet: null,
        note: null,
      }),
    );
  }

  // For column order UUIDs
  const colOrderResolvers: number[] = [];
  for (let i = 0; i < numCols; i++) {
    colOrderResolvers.push(
      pushObj({
        customMap: {
          type: 1,
          mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(numRows + i) } }],
        },
        dictionary: null,
        orderedSet: null,
        note: null,
      }),
    );
  }

  // For row value UUIDs (used in content mapping)
  const rowValueResolvers: number[] = [];
  for (let i = 0; i < numRows; i++) {
    rowValueResolvers.push(
      pushObj({
        customMap: {
          type: 1,
          mapEntry: [
            { key: 0, value: { unsignedIntegerValue: BigInt(numRows + numCols + i) } },
          ],
        },
        dictionary: null,
        orderedSet: null,
        note: null,
      }),
    );
  }

  // For column value UUIDs
  const colValueResolvers: number[] = [];
  for (let i = 0; i < numCols; i++) {
    colValueResolvers.push(
      pushObj({
        customMap: {
          type: 1,
          mapEntry: [
            {
              key: 0,
              value: {
                unsignedIntegerValue: BigInt(numRows + numCols + numRows + i),
              },
            },
          ],
        },
        dictionary: null,
        orderedSet: null,
        note: null,
      }),
    );
  }

  // ── Cell note objects ──
  const cellNoteIndices: number[][] = [];
  for (let r = 0; r < numRows; r++) {
    cellNoteIndices.push([]);
    for (let c = 0; c < numCols; c++) {
      cellNoteIndices[r]!.push(
        pushObj({
          customMap: null,
          dictionary: null,
          orderedSet: null,
          note: {
            noteText: rowContents[r]![c]!,
            attributeRun: [{ length: rowContents[r]![c]!.length }],
          },
        }),
      );
    }
  }

  // ── Row data dictionaries (one per column, containing row → cell mappings) ──
  const rowDataIndices: number[] = [];
  for (let c = 0; c < numCols; c++) {
    const elements = [];
    for (let r = 0; r < numRows; r++) {
      elements.push({
        key: { objectIndex: rowValueResolvers[r]! } as ANObjectID,
        value: { objectIndex: cellNoteIndices[r]![c]! } as ANObjectID,
      });
    }
    rowDataIndices.push(
      pushObj({
        customMap: null,
        dictionary: { element: elements },
        orderedSet: null,
        note: null,
      }),
    );
  }

  // ── CellColumns dictionary ──
  const cellColumnsElements = [];
  for (let c = 0; c < numCols; c++) {
    cellColumnsElements.push({
      key: { objectIndex: colValueResolvers[c]! } as ANObjectID,
      value: { objectIndex: rowDataIndices[c]! } as ANObjectID,
    });
  }
  const cellColumnsIdx = pushObj({
    customMap: null,
    dictionary: { element: cellColumnsElements },
    orderedSet: null,
    note: null,
  });

  // ── Rows OrderedSet ──
  const rowsIdx = pushObj({
    customMap: null,
    dictionary: null,
    orderedSet: {
      ordering: {
        array: {
          attachment: rowOrderUuids.map((u, i) => ({ index: i, uuid: u })),
        },
        contents: {
          element: rowOrderUuids.map((_, i) => ({
            key: { objectIndex: rowOrderResolvers[i]! } as ANObjectID,
            value: { objectIndex: rowValueResolvers[i]! } as ANObjectID,
          })),
        },
      },
      elements: { element: [] },
    },
    note: null,
  });

  // ── Columns OrderedSet ──
  const columnsIdx = pushObj({
    customMap: null,
    dictionary: null,
    orderedSet: {
      ordering: {
        array: {
          attachment: colOrderUuids.map((u, i) => ({ index: i, uuid: u })),
        },
        contents: {
          element: colOrderUuids.map((_, i) => ({
            key: { objectIndex: colOrderResolvers[i]! } as ANObjectID,
            value: { objectIndex: colValueResolvers[i]! } as ANObjectID,
          })),
        },
      },
      elements: { element: [] },
    },
    note: null,
  });

  // ── Key and Type arrays ──
  // keys: index 0 = Rows, 1 = Columns, 2 = CellColumns
  const keys = [ANTableKey.Rows, ANTableKey.Columns, ANTableKey.CellColumns];
  // types: index 0 = ICTable (root), index 1 = Number (used by resolvers)
  const types = [ANTableType.ICTable, ANTableType.Number];

  // ── Root ICTable object ──
  const rootIdx = pushObj({
    customMap: {
      type: 0, // types[0] = ICTable
      mapEntry: [
        { key: 0, value: { objectIndex: rowsIdx } },    // keys[0] = Rows
        { key: 1, value: { objectIndex: columnsIdx } },  // keys[1] = Columns
        { key: 2, value: { objectIndex: cellColumnsIdx } }, // keys[2] = CellColumns
      ],
    },
    dictionary: null,
    orderedSet: null,
    note: null,
  });

  return {
    mergableDataObject: {
      mergeableDataObjectData: {
        mergeableDataObjectKeyItem: keys as string[],
        mergeableDataObjectTypeItem: types as string[],
        mergeableDataObjectUuidItem: allUuids,
        mergeableDataObjectEntry: objects,
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('US-005: Table Conversion', () => {
  // ── formatTable ──

  describe('formatTable', () => {
    test('formats a 2×3 table correctly', () => {
      const cells = [
        ['A', 'B', 'C'],
        ['1', '2', '3'],
      ];

      const result = formatTable(cells);

      expect(result).toBe(
        '\n| A | B | C |\n| -- | -- | -- |\n| 1 | 2 | 3 |\n\n',
      );
    });

    test('formats a 3×2 table correctly', () => {
      const cells = [
        ['Name', 'Age'],
        ['Alice', '30'],
        ['Bob', '25'],
      ];

      const result = formatTable(cells);

      expect(result).toBe(
        '\n| Name | Age |\n| -- | -- |\n| Alice | 30 |\n| Bob | 25 |\n\n',
      );
    });

    test('returns empty string for empty cells array', () => {
      expect(formatTable([])).toBe('');
    });

    test('formats a 1×1 table', () => {
      const result = formatTable([['Only cell']]);
      expect(result).toBe('\n| Only cell |\n| -- |\n\n');
    });
  });

  // ── getTargetUuid ──

  describe('getTargetUuid', () => {
    test('dereferences object entry to resolve UUID', () => {
      const uuids = ['aabb', 'ccdd', 'eeff'];
      const objects: ANTableObject[] = [
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(2) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
      ];

      const result = getTargetUuid({ objectIndex: 0 }, objects, uuids);
      expect(result).toBe('eeff');
    });

    test('resolves first UUID when unsignedIntegerValue is 0', () => {
      const uuids = ['first', 'second'];
      const objects: ANTableObject[] = [
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(0) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
      ];

      const result = getTargetUuid({ objectIndex: 0 }, objects, uuids);
      expect(result).toBe('first');
    });
  });

  // ── findLocations ──

  describe('findLocations', () => {
    test('produces correct UUID→position mapping', () => {
      // Use hex-encoded UUIDs matching what uuidToHex produces from the Uint8Array buffers
      const orderA = uuid('aa');
      const orderB = uuid('bb');
      const valA = uuid('cc');
      const valB = uuid('dd');
      // uuids array: uuidToHex(orderA)='aa', uuidToHex(orderB)='bb', etc.
      const uuids = ['aa', 'bb', 'cc', 'dd'];

      // Resolver objects
      const objects: ANTableObject[] = [
        // obj 0: resolves to uuids[0] ('aa' = orderA)
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(0) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
        // obj 1: resolves to uuids[1] ('bb' = orderB)
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(1) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
        // obj 2: resolves to uuids[2] ('cc' = valA)
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(2) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
        // obj 3: resolves to uuids[3] ('dd' = valB)
        {
          customMap: {
            type: 0,
            mapEntry: [{ key: 0, value: { unsignedIntegerValue: BigInt(3) } }],
          },
          dictionary: null,
          orderedSet: null,
          note: null,
        },
      ];

      const orderedSetObj: ANTableObject = {
        customMap: null,
        dictionary: null,
        orderedSet: {
          ordering: {
            array: {
              attachment: [
                { index: 0, uuid: orderA },
                { index: 1, uuid: orderB },
              ],
            },
            contents: {
              element: [
                { key: { objectIndex: 0 }, value: { objectIndex: 2 } },
                { key: { objectIndex: 1 }, value: { objectIndex: 3 } },
              ],
            },
          },
          elements: { element: [] },
        },
        note: null,
      };

      const result = findLocations(orderedSetObj, objects, uuids);

      expect(result.count).toBe(2);
      // valA ('cc') maps to position 0 (where orderA appears in the ordering)
      expect(result.mapping['cc']).toBe(0);
      // valB ('dd') maps to position 1 (where orderB appears in the ordering)
      expect(result.mapping['dd']).toBe(1);
    });
  });

  // ── convertTableToMarkdown (end-to-end) ──

  describe('convertTableToMarkdown', () => {
    test('converts a 2×3 CRDT table to Markdown', async () => {
      const proto = buildMockTableProto([
        ['Name', 'Age', 'City'],
        ['Alice', '30', 'Sydney'],
      ]);

      const result = await convertTableToMarkdown(proto, simpleCellConverter);

      expect(result).toBe(
        '\n| Name | Age | City |\n| -- | -- | -- |\n| Alice | 30 | Sydney |\n\n',
      );
    });

    test('converts a 3×2 CRDT table to Markdown', async () => {
      const proto = buildMockTableProto([
        ['X', 'Y'],
        ['1', '2'],
        ['3', '4'],
      ]);

      const result = await convertTableToMarkdown(proto, simpleCellConverter);

      expect(result).toBe(
        '\n| X | Y |\n| -- | -- |\n| 1 | 2 |\n| 3 | 4 |\n\n',
      );
    });

    test('returns empty string when no ICTable root is found', async () => {
      const proto: ANMergableDataProto = {
        mergableDataObject: {
          mergeableDataObjectData: {
            mergeableDataObjectKeyItem: [],
            mergeableDataObjectTypeItem: [],
            mergeableDataObjectUuidItem: [],
            mergeableDataObjectEntry: [],
          },
        },
      };

      const result = await convertTableToMarkdown(proto, simpleCellConverter);
      expect(result).toBe('');
    });

    test('applies cell converter callback to format cell content', async () => {
      const proto = buildMockTableProto([
        ['hello', 'world'],
      ]);

      const uppercaseConverter = async (note: ANNote): Promise<string> => {
        return note.noteText.trim().toUpperCase();
      };

      const result = await convertTableToMarkdown(proto, uppercaseConverter);

      expect(result).toContain('HELLO');
      expect(result).toContain('WORLD');
    });

    test('handles 1×1 table', async () => {
      const proto = buildMockTableProto([['Single']]);

      const result = await convertTableToMarkdown(proto, simpleCellConverter);

      expect(result).toBe('\n| Single |\n| -- |\n\n');
    });

    test('returns empty string when cellData dictionary is missing', async () => {
      // Build a proto where the root references a cellColumns object with no dictionary
      const objects: ANTableObject[] = [];

      // Empty rows ordered set
      const rowsObj: ANTableObject = {
        customMap: null,
        dictionary: null,
        orderedSet: {
          ordering: {
            array: { attachment: [] },
            contents: { element: [] },
          },
          elements: { element: [] },
        },
        note: null,
      };
      objects.push(rowsObj); // index 0

      // Empty columns ordered set
      objects.push({ ...rowsObj }); // index 1

      // CellColumns with no dictionary
      objects.push({
        customMap: null,
        dictionary: null,
        orderedSet: null,
        note: null,
      }); // index 2

      // Root ICTable
      objects.push({
        customMap: {
          type: 0,
          mapEntry: [
            { key: 0, value: { objectIndex: 0 } },
            { key: 1, value: { objectIndex: 1 } },
            { key: 2, value: { objectIndex: 2 } },
          ],
        },
        dictionary: null,
        orderedSet: null,
        note: null,
      });

      const proto: ANMergableDataProto = {
        mergableDataObject: {
          mergeableDataObjectData: {
            mergeableDataObjectKeyItem: [
              ANTableKey.Rows,
              ANTableKey.Columns,
              ANTableKey.CellColumns,
            ],
            mergeableDataObjectTypeItem: [ANTableType.ICTable],
            mergeableDataObjectUuidItem: [],
            mergeableDataObjectEntry: objects,
          },
        },
      };

      const result = await convertTableToMarkdown(proto, simpleCellConverter);
      expect(result).toBe('');
    });
  });
});

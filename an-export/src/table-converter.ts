/**
 * Table Converter — CRDT Table → Markdown Table.
 *
 * Apple Notes stores tables as CRDT structures (MergableDataProto).
 * This module parses the CRDT indirection and produces a standard Markdown table.
 *
 * Ported from obsidian-importer's convert-table.ts (MIT License).
 */

import type {
  ANMergableDataProto,
  ANDataStore,
  ANTableObject,
  ANTableUuidMapping,
  ANObjectID,
  ANNote,
} from './types.ts';
import { ANTableKey, ANTableType } from './types.ts';
import { uuidToHex } from './utils.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

type CellConverter = (note: ANNote) => Promise<string>;

type ParsedTable = {
  cells: string[][];
};

type LocationResult = {
  mapping: ANTableUuidMapping;
  count: number;
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert a decoded ANMergableDataProto (CRDT table) to a Markdown table string.
 *
 * @param proto - The decoded protobuf table structure.
 * @param convertCell - Callback to convert each cell's ANNote content to Markdown.
 * @returns A Markdown table string, or empty string if the table cannot be parsed.
 */
export async function convertTableToMarkdown(
  proto: ANMergableDataProto,
  convertCell: CellConverter,
): Promise<string> {
  const data = proto.mergableDataObject.mergeableDataObjectData;

  const keys = data.mergeableDataObjectKeyItem as ANTableKey[];
  const types = data.mergeableDataObjectTypeItem as ANTableType[];
  const uuids = data.mergeableDataObjectUuidItem.map(uuidToHex);
  const objects = data.mergeableDataObjectEntry;

  const parsed = await parseTable(keys, types, uuids, objects, convertCell);
  if (!parsed) return '';

  return formatTable(parsed.cells);
}

// ─── Internal Functions ──────────────────────────────────────────────────────

/**
 * Parse the CRDT structure to extract a 2D cell array.
 */
async function parseTable(
  keys: ANTableKey[],
  types: ANTableType[],
  uuids: string[],
  objects: ANTableObject[],
  convertCell: CellConverter,
): Promise<ParsedTable | null> {
  // Find the root ICTable object
  const root = objects.find(
    (e) => e.customMap && types[e.customMap.type] === ANTableType.ICTable,
  );
  if (!root?.customMap) return null;

  let rowLocations: ANTableUuidMapping = {};
  let rowCount = 0;
  let columnLocations: ANTableUuidMapping = {};
  let columnCount = 0;
  let cellData: ANTableObject | null = null;

  // The root contains references to row locations, column locations, and cell data
  for (const entry of root.customMap.mapEntry) {
    const object = objects[entry.value.objectIndex!];
    if (!object) continue;

    switch (keys[entry.key]) {
      case ANTableKey.Rows: {
        const result = findLocations(object, objects, uuids);
        rowLocations = result.mapping;
        rowCount = result.count;
        break;
      }
      case ANTableKey.Columns: {
        const result = findLocations(object, objects, uuids);
        columnLocations = result.mapping;
        columnCount = result.count;
        break;
      }
      case ANTableKey.CellColumns:
        cellData = object;
        break;
    }
  }

  if (!cellData?.dictionary) return null;

  const cells = await computeCells(
    cellData,
    objects,
    uuids,
    rowLocations,
    columnLocations,
    rowCount,
    columnCount,
    convertCell,
  );

  return { cells };
}

/**
 * Compute the location of rows/columns from an OrderedSet.
 * Returns a mapping of UUID → position index, and the total count.
 */
export function findLocations(
  object: ANTableObject,
  objects: ANTableObject[],
  uuids: string[],
): LocationResult {
  const ordering: string[] = [];

  for (const element of object.orderedSet!.ordering.array.attachment) {
    ordering.push(uuidToHex(element.uuid));
  }

  const mapping: ANTableUuidMapping = {};

  for (const element of object.orderedSet!.ordering.contents.element) {
    const key = getTargetUuid(element.key, objects, uuids);
    const value = getTargetUuid(element.value, objects, uuids);
    mapping[value] = ordering.indexOf(key);
  }

  return { mapping, count: ordering.length };
}

/**
 * Dereference an object entry through the CRDT indirection to resolve its UUID.
 */
export function getTargetUuid(
  entry: ANObjectID,
  objects: ANTableObject[],
  uuids: string[],
): string {
  const reference = objects[entry.objectIndex!]!;
  const uuidIndex = reference.customMap!.mapEntry[0]!.value.unsignedIntegerValue!;
  return uuids[Number(uuidIndex)]!;
}

/**
 * Build the 2D cell array from the CRDT cell data.
 */
async function computeCells(
  cellData: ANTableObject,
  objects: ANTableObject[],
  uuids: string[],
  rowLocations: ANTableUuidMapping,
  columnLocations: ANTableUuidMapping,
  rowCount: number,
  columnCount: number,
  convertCell: CellConverter,
): Promise<string[][]> {
  // Initialize the 2D array
  const result: string[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => ''),
  );

  for (const column of cellData.dictionary!.element) {
    const columnLocation = columnLocations[getTargetUuid(column.key, objects, uuids)];
    const rowData = objects[column.value.objectIndex!];

    if (columnLocation === undefined || !rowData?.dictionary) continue;

    for (const row of rowData.dictionary.element) {
      const rowLocation = rowLocations[getTargetUuid(row.key, objects, uuids)];
      const rowContent = objects[row.value.objectIndex!];

      if (rowLocation === undefined || !rowContent?.note) continue;

      result[rowLocation]![columnLocation] = await convertCell(rowContent.note);
    }
  }

  return result;
}

/**
 * Format a 2D string array as a Markdown table with pipe separators and header row.
 */
export function formatTable(cells: string[][]): string {
  if (cells.length === 0) return '';

  let md = '\n';

  for (let i = 0; i < cells.length; i++) {
    md += `| ${cells[i]!.join(' | ')} |\n`;
    if (i === 0) {
      md += `|${' -- |'.repeat(cells[0]!.length)}\n`;
    }
  }

  return md + '\n';
}

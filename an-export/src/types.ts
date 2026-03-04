/**
 * All TypeScript types and enums for the Apple Notes Exporter.
 * Based on the obsidian-importer's apple-notes/models.ts (MIT License)
 */

// ─── Apple Notes Database Row Types ──────────────────────────────────────────

export type DbRow = Record<string, unknown>;

export type EntityKeys = {
  ICAccount: number;
  ICFolder: number;
  ICNote: number;
  ICAttachment: number;
  ICMedia: number;
};

export type AccountRow = {
  Z_PK: number;
  ZNAME: string;
  ZIDENTIFIER: string;
};

export type FolderRow = {
  Z_PK: number;
  ZTITLE2: string;
  ZPARENT: number | null;
  ZIDENTIFIER: string;
  ZFOLDERTYPE: number;
  ZOWNER: number;
};

export type NoteRow = {
  Z_PK: number;
  ZTITLE1: string;
  ZFOLDER: number;
  ZCREATIONDATE1: number | null;
  ZCREATIONDATE2: number | null;
  ZCREATIONDATE3: number | null;
  ZMODIFICATIONDATE1: number | null;
  ZISPASSWORDPROTECTED: number | null;
  ZHEXDATA: string;
};

export type AttachmentRow = {
  Z_PK: number;
  ZIDENTIFIER: string;
  ZFILENAME: string | null;
  ZTYPEUTI: string | null;
  ZMEDIA: number | null;
  ZGENERATION1: string | null;
  ZFALLBACKPDFGENERATION: string | null;
  ZFALLBACKIMAGEGENERATION: string | null;
  ZSIZEHEIGHT: number | null;
  ZSIZEWIDTH: number | null;
  ZHANDWRITINGSUMMARY: string | null;
  ZCREATIONDATE: number | null;
  ZMODIFICATIONDATE: number | null;
  ZNOTE: number | null;
  ZALTTEXT: string | null;
  ZTOKENCONTENTIDENTIFIER: string | null;
  ZTITLE: string | null;
  ZURLSTRING: string | null;
  ZHEXDATA: string | null;
};

// ─── Account / Folder Resolved Types ─────────────────────────────────────────

export type ANAccount = {
  name: string;
  uuid: string;
  /** Absolute path to the account's data directory on disk */
  path: string;
};

export type ResolvedFolder = {
  /** Absolute path of the output directory for this folder */
  outputPath: string;
  ownerAccountId: number;
};

// ─── Sync Manifest ────────────────────────────────────────────────────────────

export type ManifestNoteEntry = {
  /** Relative path from export root, e.g. "Work/Meeting Notes.md" */
  path: string;
  /** Apple Note ZMODIFICATIONDATE1 decoded to Unix ms */
  mtime: number;
  /** ZIDENTIFIER UUID */
  identifier: string;
};

export type ManifestAttachmentEntry = {
  /** Relative path, e.g. "attachments/image.png" */
  path: string;
  /** Apple attachment modification time in Unix ms */
  mtime: number;
};

export type SyncManifest = {
  version: 1;
  exportedAt: string;
  notes: Record<number, ManifestNoteEntry>;
  attachments: Record<number, ManifestAttachmentEntry>;
};

// ─── Folder Type Enum ─────────────────────────────────────────────────────────

export enum ANFolderType {
  Default = 0,
  Trash = 1,
  Smart = 3,
}

// ─── Attachment UTI Constants ─────────────────────────────────────────────────

export enum ANAttachmentUTI {
  Drawing = 'com.apple.paper',
  DrawingLegacy = 'com.apple.drawing',
  DrawingLegacy2 = 'com.apple.drawing.2',
  Hashtag = 'com.apple.notes.inlinetextattachment.hashtag',
  Mention = 'com.apple.notes.inlinetextattachment.mention',
  InternalLink = 'com.apple.notes.inlinetextattachment.link',
  ModifiedScan = 'com.apple.paper.doc.scan',
  Scan = 'com.apple.notes.gallery',
  Table = 'com.apple.notes.table',
  UrlCard = 'public.url',
}

// ─── Protobuf Decoded Types ───────────────────────────────────────────────────

export interface ANNote {
  noteText: string;
  attributeRun: ANAttributeRun[];
  version?: number;
}

export interface ANDocument {
  note: ANNote;
}

export interface ANAttributeRun {
  length: number;
  paragraphStyle?: ANParagraphStyle;
  font?: ANFont;
  fontWeight?: ANFontWeight;
  underlined?: number;
  strikethrough?: number;
  superscript?: ANBaseline;
  link?: string;
  color?: ANColor;
  attachmentInfo?: ANAttachmentInfo;
  [key: string]: unknown;
}

export interface ANParagraphStyle {
  styleType?: ANStyleType;
  alignment?: ANAlignment;
  indentAmount?: number;
  checklist?: ANChecklist;
  blockquote?: number;
}

export enum ANStyleType {
  Default = -1,
  Title = 0,
  Heading = 1,
  Subheading = 2,
  Monospaced = 4,
  DottedList = 100,
  DashedList = 101,
  NumberedList = 102,
  Checkbox = 103,
}

export enum ANAlignment {
  Left = 0,
  Centre = 1,
  Right = 2,
  Justify = 3,
}

export interface ANChecklist {
  done: number;
  uuid: Uint8Array;
}

export interface ANFont {
  fontName?: string;
  pointSize?: number;
  fontHints?: number;
}

export enum ANFontWeight {
  Regular = 0,
  Bold = 1,
  Italic = 2,
  BoldItalic = 3,
}

export enum ANBaseline {
  Sub = -1,
  Default = 0,
  Super = 1,
}

export interface ANColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface ANAttachmentInfo {
  attachmentIdentifier: string;
  typeUti: string;
}

// ─── CRDT / MergeableData Types ───────────────────────────────────────────────

export interface ANMergableDataProto {
  mergableDataObject: ANMergeableDataObject;
}

export interface ANMergeableDataObject {
  mergeableDataObjectData: ANDataStore;
}

export interface ANDataStore {
  mergeableDataObjectKeyItem: string[];
  mergeableDataObjectTypeItem: string[];
  mergeableDataObjectUuidItem: Uint8Array[];
  mergeableDataObjectEntry: ANTableObject[];
}

export interface ANTableObject {
  customMap: ANMergeableDataObjectMap | null;
  dictionary: ANDictionary | null;
  orderedSet: ANOrderedSet | null;
  note: ANNote | null;
}

export interface ANMergeableDataObjectMap {
  type: number;
  mapEntry: ANMapEntry[];
}

export interface ANMapEntry {
  key: number;
  value: ANObjectID;
}

export interface ANObjectID {
  unsignedIntegerValue?: bigint;
  stringValue?: string;
  objectIndex?: number;
}

export interface ANDictionary {
  element: ANDictionaryElement[];
}

export interface ANDictionaryElement {
  key: ANObjectID;
  value: ANObjectID;
}

export interface ANOrderedSet {
  ordering: ANOrderedSetOrdering;
  elements: ANDictionary;
}

export interface ANOrderedSetOrdering {
  array: ANOrderedSetOrderingArray;
  contents: ANDictionary;
}

export interface ANOrderedSetOrderingArray {
  attachment: ANOrderedSetOrderingArrayAttachment[];
}

export interface ANOrderedSetOrderingArrayAttachment {
  index: number;
  uuid: Uint8Array;
}

export type ANTableUuidMapping = Record<string, number>;

export enum ANTableKey {
  Identity = 'identity',
  Direction = 'crTableColumnDirection',
  Self = 'self',
  Rows = 'crRows',
  UUIDIndex = 'UUIDIndex',
  Columns = 'crColumns',
  CellColumns = 'cellColumns',
}

export enum ANTableType {
  Number = 'com.apple.CRDT.NSNumber',
  String = 'com.apple.CRDT.NSString',
  Uuid = 'com.apple.CRDT.NSUUID',
  Tuple = 'com.apple.CRDT.CRTuple',
  MultiValueLeast = 'com.apple.CRDT.CRRegisterMultiValueLeast',
  MultiValue = 'com.apple.CRDT.CRRegisterMultiValue',
  Tree = 'com.apple.CRDT.CRTree',
  Node = 'com.apple.CRDT.CRTreeNode',
  Table = 'com.apple.notes.CRTable',
  ICTable = 'com.apple.notes.ICTable',
}

// ─── Export Options ───────────────────────────────────────────────────────────

export type ExportOptions = {
  /** Absolute path to the output directory */
  dest: string;
  /** Whether to include notes in the Trash folder */
  includeTrashed?: boolean;
  /** Whether to omit the first line (used as title / filename) from the note body */
  omitFirstLine?: boolean;
  /** Whether to include handwriting OCR text for drawings */
  includeHandwriting?: boolean;
};

export type SyncOptions = ExportOptions;

// ─── Progress Reporting ───────────────────────────────────────────────────────

export type ExportResult = {
  exported: number;
  skipped: number;
  deleted: number;
  failed: string[];
};

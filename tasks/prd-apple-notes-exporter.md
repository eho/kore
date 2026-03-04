# PRD: Apple Notes Exporter (`an-export`)

## Introduction

Apple Notes stores data in a private SQLite database with protobuf-encoded note content. There is no public API for exporting notes. This project reverse-engineers the data format (based on the open-source [obsidian-importer](https://github.com/obsidianmd/obsidian-importer)) and builds a standalone TypeScript library and CLI tool that:

1. Extracts all notes from the local Apple Notes database on macOS.
2. Converts them to standard Markdown files with attachments.
3. Supports incremental one-way sync (re-running updates changed notes, adds new ones, deletes removed ones).

**Reference implementation:** The `src/formats/apple-notes.ts` and `src/formats/apple-notes/` directory in `obsidian-importer`. Our tool extracts the core logic from that Obsidian plugin and makes it a standalone Bun/TypeScript module with no Obsidian dependency.

---

## Goals

- Extract all non-password-protected notes from the local Apple Notes SQLite database.
- Preserve Apple Notes folder hierarchy in the exported directory structure.
- Convert note content (rich text, lists, tables, etc.) to standard Markdown.
- Export all attachments (images, PDFs, drawings, scans) to an `attachments/` directory and link them in the Markdown.
- Support incremental sync: detect new, updated, and deleted notes on subsequent runs.
- Provide both a programmatic library API and a CLI tool.

---

## Architecture Overview

```
src/
  cli.ts              # CLI entry point
  index.ts             # Library public API
  db.ts                # SQLite database access (copy, open, query)
  decoder.ts           # GZIP decompression + protobuf decoding
  descriptor.ts        # Protobuf schema definition (ported from obsidian-importer)
  converter.ts         # Main note-to-Markdown converter
  table-converter.ts   # CRDT table → Markdown table
  scan-converter.ts    # Scan document → attachment links
  attachments.ts       # Attachment resolution and file copying
  sync.ts              # Sync manifest management (new/updated/deleted detection)
  types.ts             # All TypeScript types and enums
  utils.ts             # Filename sanitization, date conversion, helpers
```

---

## Detailed Technical Specification

### 1. Apple Notes Database Location & Access

**Database path:**
```
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
```

The database has WAL mode enabled, so three files must be copied:
- `NoteStore.sqlite`
- `NoteStore.sqlite-shm`
- `NoteStore.sqlite-wal`

**Procedure:**
1. Copy all three files to a temporary directory (e.g., `os.tmpdir()`).
2. Open the copy in **read-only** mode using `bun:sqlite` (Bun's built-in SQLite).
3. Never write to or modify the original database.

### 2. Database Schema (CoreData)

Apple Notes uses CoreData, which prefixes all columns with `Z` and uses numeric entity IDs. The key tables are:

#### `z_primarykey` — Entity type lookup
Maps human-readable entity names to numeric IDs. Query this first:
```sql
SELECT z_ent, z_name FROM z_primarykey
```
Relevant entity names: `ICAccount`, `ICFolder`, `ICNote`, `ICAttachment`, `ICMedia`.

#### `ziccloudsyncingobject` — Main data table
This single table holds **all** entity types (accounts, folders, notes metadata, attachments). Filter by `z_ent` to get the right type.

**Account fields:** `z_pk`, `zname`, `zidentifier`
**Folder fields:** `z_pk`, `ztitle2`, `zparent`, `zidentifier`, `zfoldertype`, `zowner`
**Note fields:** `z_pk`, `ztitle1`, `zfolder`, `zcreationdate1`, `zcreationdate2`, `zcreationdate3`, `zmodificationdate1`, `zispasswordprotected`
**Attachment fields:** `z_pk`, `zidentifier`, `zfilename`, `ztypeuti`, `zmedia`, `zgeneration1`, `zfallbackpdfgeneration`, `zfallbackimagegeneration`, `zsizeheight`, `zsizewidth`, `zhandwritingsummary`, `zcreationdate`, `zmodificationdate`, `znote`, `zmergeabledata1`, `zalttext`, `ztokencontentidentifier`, `ztitle`, `zurlstring`

#### `zicnotedata` — Note content blobs
**Fields:** `z_pk`, `znote` (foreign key to note's `z_pk`), `zdata` (GZIP-compressed protobuf blob)

**Note content query:**
```sql
SELECT
  nd.z_pk, hex(nd.zdata) as zhexdata, zcso.ztitle1, zfolder,
  zcreationdate1, zcreationdate2, zcreationdate3,
  zmodificationdate1, zispasswordprotected
FROM
  zicnotedata AS nd,
  (SELECT *, NULL AS zcreationdate3, NULL AS zcreationdate2,
   NULL AS zispasswordprotected FROM ziccloudsyncingobject) AS zcso
WHERE
  zcso.z_pk = nd.znote AND zcso.z_pk = ?
```
> **Note:** The `NULL AS` columns are a compatibility trick — some of these columns only exist on newer macOS versions. Selecting them as NULL prevents errors on older systems.

### 3. Date Conversion

Apple uses **Mac Absolute Time** (seconds since Jan 1, 2001 00:00:00 UTC). To convert to Unix timestamp in milliseconds:

```typescript
const CORETIME_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01

function decodeTime(timestamp: number): number {
  if (!timestamp || timestamp < 1) return Date.now();
  return Math.floor((timestamp + CORETIME_OFFSET) * 1000);
}
```

Use the **most specific** creation date available: `ZCREATIONDATE3 || ZCREATIONDATE2 || ZCREATIONDATE1`.

### 4. Protobuf Decoding

Note content in `ZDATA` is **GZIP-compressed protobuf**. The decoding pipeline:

1. Convert hex string to Buffer: `Buffer.from(hexdata, 'hex')`
2. Decompress: `zlib.gunzipSync(buffer)`
3. Decode with protobufjs using the schema from `descriptor.ts`

**Two protobuf types are used:**
- `ciofecaforensics.Document` — for note content (has `.note.noteText` and `.note.attributeRun[]`)
- `ciofecaforensics.MergableDataProto` — for tables and scans (CRDT structure)

The full protobuf schema must be ported from the reference `descriptor.ts` (477 lines). It defines these message types:
`Color`, `AttachmentInfo`, `Font`, `ParagraphStyle`, `Checklist`, `DictionaryElement`, `Dictionary`, `ObjectID`, `RegisterLatest`, `MapEntry`, `AttributeRun`, `NoteStoreProto`, `Document`, `Note`, `MergableDataProto`, `MergableDataObject`, `MergeableDataObjectData`, `MergeableDataObjectEntry`, `UnknownMergeableDataObjectEntryMessage`, `MergeableDataObjectMap`, `OrderedSet`, `OrderedSetOrdering`, `OrderedSetOrderingArray`, `OrderedSetOrderingArrayAttachment`, `List`, `ListEntry`, `ListEntryDetails`, `ListEntryDetailsKey`.

### 5. Note Content → Markdown Conversion

A decoded `Document` contains:
- `note.noteText`: The full plaintext string of the note.
- `note.attributeRun[]`: An array of formatting runs, each with a `length` field indicating how many characters of `noteText` it covers.

**Conversion algorithm:**
1. Walk the `attributeRun` array, slicing `noteText` by cumulative `length` to get each fragment.
2. Merge adjacent runs with identical attributes.
3. Split fragments at newlines/spaces (Markdown doesn't like formatting crossing line boundaries).
4. For each fragment, apply formatting based on its attributes.

**Formatting rules (from `AttributeRun` fields):**

| Attribute | Markdown Output |
|---|---|
| `fontWeight = 1` (Bold) | `**text**` |
| `fontWeight = 2` (Italic) | `*text*` |
| `fontWeight = 3` (BoldItalic) | `***text***` |
| `strikethrough` | `~~text~~` |
| `underlined` | `<u>text</u>` |
| `superscript = 1` | `<sup>text</sup>` |
| `superscript = -1` | `<sub>text</sub>` |
| `link` (external URL) | `[text](url)` |
| `link` (internal `applenotes:note/UUID`) | `[[Other Note Title]]` |
| `color` (non-default) | `<span style="color:#hex">text</span>` |
| `font.fontName` (custom font) | `<span style="font-family:name">text</span>` |
| `font.pointSize` | `<span style="font-size:Npt">text</span>` |

**Paragraph styles (from `paragraphStyle.styleType`):**

| styleType | Markdown |
|---|---|
| `0` (Title) | `# text` |
| `1` (Heading) | `## text` |
| `2` (Subheading) | `### text` |
| `4` (Monospaced) | Fenced code block (` ``` `) wrapping consecutive monospaced runs |
| `100` (DottedList) | `- text` (with tab indentation for `indentAmount`) |
| `101` (DashedList) | `- text` |
| `102` (NumberedList) | `N. text` (auto-incrementing, resets on indent change) |
| `103` (Checkbox) | `- [ ] text` or `- [x] text` (from `checklist.done`) |

**Additional paragraph attributes:**
- `blockquote` → prefix with `> `
- `alignment` (Centre/Right/Justify) → wrap in `<p style="text-align:X;margin:0">` ... `</p>`
- `indentAmount` → tab-indent (`\t`) repeated N times

**First line handling:** Apple Notes uses the first line as the note title. The converter should **omit the first line** from the body since we use it as the filename.

### 6. Inline Attachment Types

Attachments are embedded in the text via `attachmentInfo` on an `AttributeRun`. Each has a `typeUti` string and an `attachmentIdentifier` UUID used to query more data.

| UTI / Type | Behavior |
|---|---|
| `com.apple.notes.inlinetextattachment.hashtag` | Query `zalttext` → insert as plain text |
| `com.apple.notes.inlinetextattachment.mention` | Query `zalttext` → insert as plain text |
| `com.apple.notes.inlinetextattachment.link` | Internal note link. Query `ztokencontentidentifier` → resolve to `[[Note Title]]` |
| `com.apple.notes.table` | Query `hex(zmergeabledata1)` → decode as `MergableDataProto`, convert via TableConverter |
| `public.url` | URL card. Query `ztitle`, `zurlstring` → `[**Title**](url)` |
| `com.apple.notes.gallery` | Scan document. Query `hex(zmergeabledata1)` → decode, resolve individual scan pages |
| `com.apple.paper.doc.scan` | Modified scan → resolve as PDF from `FallbackPDFs/` |
| `com.apple.paper` | Drawing → resolve as image from `FallbackImages/` |
| `com.apple.drawing` / `com.apple.drawing.2` | Legacy drawing formats → same as above |
| Any other UTI (e.g., `public.jpeg`) | General file attachment → resolve from `Media/` directory |

### 7. Table Conversion (CRDT)

Tables use Apple's CRDT format (`MergableDataProto`). The conversion algorithm:

1. Decode the protobuf into `MergeableDataObject`.
2. Extract the `keys[]`, `types[]`, `uuids[]`, and `objects[]` arrays from the data store.
3. Find the root table object (where `types[customMap.type] == 'com.apple.notes.ICTable'`).
4. From the root's `mapEntry`, locate:
   - **Rows** (key=`crRows`) → extract UUID ordering from `orderedSet`
   - **Columns** (key=`crColumns`) → extract UUID ordering from `orderedSet`
   - **CellColumns** (key=`cellColumns`) → the actual cell data
5. Build a 2D array `[rows][cols]` and fill cells by matching column/row UUIDs.
6. Each cell's content is itself a `Note` protobuf — recursively convert to Markdown.
7. Output as a Markdown table with `|` separators and `--` header row.

### 8. Attachment File Paths on Disk

Attachments are stored in subdirectories of the Apple Notes data container. The base path is:
```
~/Library/Group Containers/group.com.apple.notes/Accounts/<ACCOUNT_UUID>/
```
With a fallback to:
```
~/Library/Group Containers/group.com.apple.notes/
```

**File path patterns by type:**

| Type | Path Pattern |
|---|---|
| Modified Scan (PDF) | `FallbackPDFs/<IDENTIFIER>/<GENERATION>/FallbackPDF.pdf` |
| Scan Page (JPEG) | `Previews/<IDENTIFIER>-1-<WIDTH>x<HEIGHT>-0.jpeg` |
| Drawing (PNG, newer macOS) | `FallbackImages/<IDENTIFIER>/<GENERATION>/FallbackImage.png` |
| Drawing (JPG, older macOS) | `FallbackImages/<IDENTIFIER>.jpg` |
| General media (images, audio, etc.) | `Media/<IDENTIFIER>/<GENERATION>/<FILENAME>` |

### 9. Folder Resolution

Folders form a tree. Resolution algorithm:
1. Query all folders: `SELECT z_pk, ztitle2 FROM ziccloudsyncingobject WHERE z_ent = <ICFolder>`
2. For each folder, query its metadata: `ztitle2`, `zparent`, `zidentifier`, `zfoldertype`, `zowner`.
3. **Skip** Smart Folders (`zfoldertype = 3`).
4. **Skip** Trash folders (`zfoldertype = 1`) unless opted-in.
5. Recursively resolve parent folders to build the full path.
6. The **default "Notes" folder** (where `zidentifier` starts with `DefaultFolder`) maps to the export root — don't create a subfolder for it.
7. **Multi-account:** If more than one `ICAccount` exists, prefix each account's root with the account name.

### 10. Sync Manifest

To support incremental sync, the exporter writes a **manifest file** (`an-export-manifest.json`) in the export root directory. This file maps each Apple Note's stable `Z_PK` (integer primary key) to its exported file path and last-known modification timestamp.

**Manifest structure:**
```typescript
type SyncManifest = {
  version: 1;
  exportedAt: string; // ISO timestamp
  notes: Record<number, {
    path: string;         // relative path from export root, e.g. "Work/Meeting Notes.md"
    mtime: number;        // Apple Note ZMODIFICATIONDATE1 (decoded to Unix ms)
    identifier: string;   // ZIDENTIFIER UUID for the note
  }>;
  attachments: Record<number, {
    path: string;         // relative path, e.g. "attachments/image.png"
    mtime: number;
  }>;
};
```

**Sync algorithm on subsequent runs:**
1. Load existing manifest.
2. Query all active notes from the database.
3. For each note in the DB:
   - **New** (Z_PK not in manifest) → export and add to manifest.
   - **Updated** (DB `ZMODIFICATIONDATE` > manifest `mtime`) → re-export and update manifest.
   - **Unchanged** → skip.
4. For each entry in the manifest NOT in the DB → **delete** the local file and remove from manifest.
5. Write updated manifest.

---

## User Stories

### US-001: Project Setup and Scaffolding
**Description:** As a developer, I want the project initialized with Bun, strict TypeScript, and the basic module/CLI structure.

**Acceptance Criteria:**
- [ ] `bun init` with strict TypeScript (`"strict": true` in `tsconfig.json`).
- [ ] `src/index.ts` exports the public library API.
- [ ] `src/cli.ts` is the CLI entry point, runnable via `bun run src/cli.ts`.
- [ ] Dependencies installed: `protobufjs` (for protobuf decoding).
- [ ] Bun's built-in `bun:sqlite` used for database access (no external SQLite dependency).
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit test verifying the project builds and the CLI entry point is importable.

### US-002: Database Access Layer
**Description:** As a library user, I need the module to safely locate, copy, and open the Apple Notes database.

**Acceptance Criteria:**
- [ ] Locate DB at `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
- [ ] Copy `.sqlite`, `.sqlite-shm`, and `.sqlite-wal` to `os.tmpdir()`.
- [ ] Open with `bun:sqlite` in read-only mode.
- [ ] Query `z_primarykey` to build the entity type lookup map (`{ICNote: N, ICFolder: N, ...}`).
- [ ] Gracefully error if the DB doesn't exist or can't be read (permission denied).
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests mocking the filesystem to verify safe copy and that the entity lookup map is built correctly from mock `z_primarykey` rows.

### US-003: Protobuf Schema and Decoder
**Description:** As a library user, I need the module to decompress and decode `ZDATA` blobs into structured objects.

**Acceptance Criteria:**
- [ ] Port the `descriptor.ts` protobuf schema from the obsidian-importer (all 28 message types under `ciofecaforensics` namespace).
- [ ] Implement `decodeNoteData(hexdata: string)` that: hex→Buffer→gunzip→protobuf decode using `ciofecaforensics.Document`.
- [ ] Implement `decodeMergeableData(hexdata: string)` for tables/scans using `ciofecaforensics.MergableDataProto`.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests with a real GZIP+protobuf test fixture (or a mock hex payload) asserting the decoded structure has `note.noteText` and `note.attributeRun[]`.

### US-004: Note Content to Markdown Converter
**Description:** As a user, I want my note formatting preserved in the exported Markdown.

**Acceptance Criteria:**
- [ ] Walk `attributeRun[]` array, slice `noteText` by cumulative `length`, merge identical adjacent runs.
- [ ] Convert bold (`**`), italic (`*`), bold-italic (`***`), strikethrough (`~~`), underline (`<u>`).
- [ ] Convert headings: Title→`#`, Heading→`##`, Subheading→`###`.
- [ ] Convert lists: dotted/dashed→`- `, numbered→`N. ` (auto-incrementing), checkbox→`- [ ]`/`- [x]`.
- [ ] Handle indentation via `indentAmount` (tab-indent repeated N times).
- [ ] Convert blockquotes (prefix `> `).
- [ ] Convert monospaced/code blocks (wrap consecutive monospaced runs in ` ``` `).
- [ ] Convert external links to `[text](url)`.
- [ ] Handle internal note links (`applenotes:note/UUID` → resolve to `[[Note Title]]` by querying DB).
- [ ] Omit the first line of the note body (Apple Notes uses it as title, which becomes the filename).
- [ ] Escape Markdown special characters (square brackets `[]`) in body text.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests for each formatting rule: provide a mock `noteText` + `attributeRun[]` and assert the correct Markdown output string.

### US-005: Table Conversion
**Description:** As a user, I want tables in my Apple Notes exported as Markdown tables.

**Acceptance Criteria:**
- [ ] Decode `MergableDataProto` from the attachment's `zmergeabledata1` column.
- [ ] Parse CRDT structure: extract keys, types, UUIDs, objects arrays.
- [ ] Find root `ICTable` object, extract row/column orderings from `OrderedSet`.
- [ ] Build 2D cell array, recursively convert each cell's `Note` content to Markdown.
- [ ] Output standard Markdown table with `|` separators and `--` header row.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests with a mock CRDT structure asserting correct 2×3 table Markdown output.

### US-006: Attachment Extraction
**Description:** As a user, I want images, PDFs, drawings, and scans exported and linked in my Markdown.

**Acceptance Criteria:**
- [ ] Resolve attachment type from `typeUti` string.
- [ ] For each type, build the correct source path on disk (see §8 in spec above).
- [ ] Copy attachment binary to `<export_dest>/attachments/<filename>`.
- [ ] Insert `![alt](attachments/<filename>)` syntax into the Markdown at the correct position.
- [ ] Handle inline attachments (hashtags → plain text, mentions → plain text, URL cards → `[Title](url)`).
- [ ] Handle scan documents: decode CRDT, resolve each scan page as an individual image.
- [ ] Handle drawings: resolve from `FallbackImages/` with generation-aware path logic (newer vs older macOS).
- [ ] Fallback: try account-specific path first, then fall back to global path.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests with a mocked filesystem verifying correct source path construction for each attachment type.

### US-007: Folder & Account Resolution
**Description:** As a user, I want the exported directory structure to mirror my Apple Notes folder hierarchy.

**Acceptance Criteria:**
- [ ] Resolve accounts from `ICAccount` entities, building name/UUID/path records.
- [ ] Resolve folders recursively: follow `zparent` to build full directory path.
- [ ] Skip Smart Folders (`zfoldertype = 3`) and Trash folders (`zfoldertype = 1`).
- [ ] Default "Notes" folder (identifier starts with `DefaultFolder`) maps to export root, not a subfolder.
- [ ] Multi-account: if >1 account, prefix each account's tree with the account name.
- [ ] Create directories on disk as needed.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests with mock folder/account DB rows verifying correct path resolution for nested folders, default folder, and multi-account scenarios.

### US-008: Sync Manifest & Incremental Sync
**Description:** As a user, I want re-running the export to only update changed notes, add new ones, and delete removed ones.

**Acceptance Criteria:**
- [ ] Write `an-export-manifest.json` to the export root after each run.
- [ ] On subsequent runs, load existing manifest and compare against DB state.
- [ ] New notes (Z_PK not in manifest) → export and add to manifest.
- [ ] Updated notes (DB mtime > manifest mtime) → re-export and update manifest entry.
- [ ] Unchanged notes → skip entirely.
- [ ] Deleted notes (in manifest but not in DB) → delete local `.md` file and remove from manifest.
- [ ] Also handle attachment sync (updated/deleted attachments).
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write unit tests with mock manifests and mock DB rows asserting correct new/update/skip/delete decisions.

### US-009: CLI Implementation
**Description:** As an end user, I want a CLI to run export and sync without writing code.

**Acceptance Criteria:**
- [ ] `bun run src/cli.ts export --dest ./my-notes` performs a full export.
- [ ] `bun run src/cli.ts sync --dest ./my-notes` reads existing manifest and performs incremental sync.
- [ ] Print progress to stdout: `Exported N/M notes...`, `Skipped K unchanged`, `Deleted D removed`.
- [ ] Skip password-protected notes with a warning message.
- [ ] Exit with code 0 on success, 1 on error.
- [ ] Typecheck passes.
- [ ] **[Logic/Backend]** Write integration tests running the CLI with `--dest` pointing to a temp directory and verifying files are created.

---

## Functional Requirements

- FR-1: Locate the Apple Notes SQLite DB dynamically for the current macOS user at `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
- FR-2: Never write to the original Apple Notes database. All reads happen on a temporary copy.
- FR-3: Decompress GZIP and parse protobuf using the ported `descriptor.ts` schema.
- FR-4: Convert all non-password-protected notes to Markdown files preserving rich text formatting.
- FR-5: Export all attachments to an `attachments/` folder and insert standard Markdown links.
- FR-6: Preserve Apple Notes folder hierarchy in the export directory structure.
- FR-7: Write a sync manifest (`an-export-manifest.json`) mapping note IDs to exported paths and timestamps.
- FR-8: On re-sync, skip unchanged notes, overwrite updated notes, delete removed notes.
- FR-9: The CLI accepts `export` and `sync` subcommands with a `--dest` argument.
- FR-10: Skip password-protected notes and log a warning.

---

## Non-Goals (Out of Scope)

- **Two-way sync:** Local Markdown edits will NOT be synced back to Apple Notes.
- **Cross-platform:** macOS only. No iCloud API access, no Windows/Linux/iOS support.
- **Password-protected notes:** Encrypted notes cannot be decrypted; they will be skipped.
- **Handwriting OCR text:** Optional stretch goal, not in initial scope.
- **Real-time / watch mode:** No file-watching or continuous sync. Must be manually invoked.

---

## Technical Considerations

- **Runtime:** Bun (TypeScript). Use `bun:sqlite` for database access (built-in, no native addon needed).
- **Dependencies:** `protobufjs` for protobuf decoding, Node built-in `zlib` for GZIP.
- **Protobuf schema:** Port the entire `descriptor.ts` (477 lines) from obsidian-importer. It's MIT-licensed (Copyright 2019 Three Planets Software).
- **Date handling:** Apple CoreTime offset = `978307200` seconds. Always convert to Unix ms for filesystem comparisons.
- **SQLite compatibility:** The `NULL AS` column trick in queries handles schema differences across macOS versions (some columns like `zcreationdate3` only exist on newer versions).
- **Filename sanitization:** Strip characters invalid in filenames (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`).

---

## Success Metrics

- 100% extraction of text and formatting from non-password-protected notes.
- All standard attachments (images, PDFs) successfully exported and linked.
- Tables rendered correctly as Markdown tables.
- Folder hierarchy preserved in export directory.
- Incremental sync completes in <2 seconds for a vault with no changes.
- Deleted notes are correctly cleaned up during sync.

---

## Open Questions

1. Should the Markdown link format for attachments be standard `![alt](path)` or Obsidian-compatible `![[path]]`? **Recommendation:** Default to standard `![alt](path)` with a `--obsidian` flag for wiki-link format.
2. Should the manifest file be `.json` or a hidden dotfile like `.an-export-manifest`? **Recommendation:** Use `.an-export-manifest.json` (hidden on macOS).
3. Should we add YAML frontmatter to exported Markdown files (with creation date, modification date, Apple Note ID)? **Recommendation:** Yes, this aids sync and is useful metadata.

# Technical Design Document: Apple Notes Exporter (`an-export`)

This document details the internal architecture, database schema, parsing behavior, and state management of `an-export`.

## 1. High-Level Architecture
`an-export` acts as a one-way extraction pipeline, converting Apple Notes rich text to flat Markdown files. The overall flow operates as follows:

1. **Database Duplication:** Safely isolates Apple Notes data by copying the local `NoteStore.sqlite` database (and its WAL mode accompanying files) to a temporary directory.
2. **Schema Resolution**: Connects to the copied database in read-only mode and discovers entity keys from the `Z_PRIMARYKEY` table.
3. **Graph Traversal**: Queries the `ZICCLOUDSYNCINGOBJECT` table to build a map of Apple Notes accounts, folders, and folder hierarchies.
4. **Protobuf Extraction**: Extracts raw BLOB encoded note data (`ZDATA`) and mergeable records (`ZMERGEABLEDATA1`) from `ZICNOTEDATA`.
5. **Decoding & Conversion**: Parses the Gzip-compressed Protocol Buffers into structured ASTs using a reverse-engineered Apple Notes schema. Converts the decoded text runs, attachments, and tables into Markdown elements.
6. **Attachment Resolution**: Copies associated files from the macOS unified `Media/`, `FallbackImages/`, or `Previews/` Apple Notes cache directories referencing them by ID.
7. **Sync Manifest & Output Generation**: Saves the Markdown files reflecting the folder hierarchy. Maintains `an-export-manifest.json` for tracking incrementality metadata (mtime, sync state).

---

## 2. Database Schema (SQLite)
Apple Notes strictly operates with CoreData. Almost everything inherits from `ZICCLOUDSYNCINGOBJECT`. To disambiguate entity types efficiently, we query `Z_PRIMARYKEY`.

### 2.1 Discovering Entity Types
- `Z_ENT` dictates if a row is an `ICNote` (Note), `ICFolder` (Folder), `ICAccount` (Account), or `ICAttachment` (Attachment).
- Because `Z_ENT` values shift between macOS versions (e.g., `ICNote` might be `3` in Sonoma but `4` in Sequoia), we dynamically resolve `Z_ENT` values by mapping `Z_NAME` in the `Z_PRIMARYKEY` table:
  ```sql
  SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY WHERE Z_NAME IN ('ICNote', 'ICFolder', 'ICAccount', 'ICAttachment')
  ```

### 2.2 Core Queries
- **Notes Query:** Finds valid notes. `ZISPASSWORDPROTECTED = 1` immediately flags note rows as unreadable/encrypted.
  ```sql
  SELECT z_pk, ztitle1, zfolder, zmodificationdate1, zidentifier FROM ziccloudsyncingobject WHERE z_ent = <ICNote_ID>
  ```
- **Note Data Query (`ZICNOTEDATA`):** Rich text and attachments IDs are stored separately as raw blob structures inside `ZICNOTEDATA.ZDATA` mapping to the `Z_PK` of the note.

---

## 3. Protobuf Decoding (`src/decoder.ts` & `src/descriptor.ts`)
Apple encodes note content iteratively using **CRDTs (Conflict-free Replicated Data Types)** to support collaborative syncing. The `ZDATA` blobs are additionally GZipped.

1. Unzip the buffer via Node's `zlib.gunzipSync`.
2. Parse the buffer using `protobufjs`.
3. The schema (defined in `descriptor.ts` and ported from community reverse-engineering efforts like `obsidian-importer`) extracts the `Document` object containing:
    - `noteText`: The raw string of text content for the full note.
    - `attributeRun[]`: A numeric mapping representing inline styling.

### 3.1 `attributeRun` Mapping
An array of "runs" acts like a sliding window on the `noteText`. Each run specifies a formatting type (Bold, Italics, Title, Header, List, Checkbox, Link, Attachment) and a integer string `length`.
We reconstruct Markdown by stepping through the text string indices based on the run lengths and applying formatting prefixes/suffixes based on the run's styling attributes (e.g. `paragraphStyle.styleType`).

---

## 4. Attachment Management (`src/attachments.ts`)
Inline attachments discovered during protobuf decoding only supply us with an Apple Notes `UUID`. We use that UUID to resolve the associated asset from the filesystem.

### 4.1 Resolving Paths (The Account Complexity)
Mac OS stores Note attachments inside `~/Library/Group Containers/group.com.apple.notes/Accounts/`.
Apple Notes splits Account UUIDs into root folders. So an attachment's actual disk location resembles:
`~/Library/Group Containers/group.com.apple.notes/Accounts/<AccountUUID>/Media/<AttachmentID>/...`

To locate an attachment we:
1. Walk the `ZPARENT` folder hierarchy to find which Account the parent folder belongs to.
2. Lookup the Account UUID in the `ZICCLOUDSYNCINGOBJECT` table.
3. Build the disk path strings based on the Uniform Type Identifier (UTI).

### 4.2 Handling Complex Media (Scans, Tables, & Drawings)
Notes attachments aren't simply "images". The decoder encounters various proprietary Apple features:
- **Internal Links**: Note links redirect to `![[Title]]` logic.
- **Mergeable Tables (`com.apple.notes.ICTable`)**: CRDT Tables encoded in `ZMERGEABLEDATA1` blob. Handled separately by `table-converter.ts`.
- **Scans (`com.apple.notes.gallery`)**: iOS Document scans are comprised of multiple cropped previews combined. `scan-converter.ts` hunts for the valid `FallbackImages` cache images and links them.
- **Drawings**: Extracted from CoreData rows utilizing handwritten OCR text (`ZHANDWRITINGSUMMARY`) as `.png` alt labels.

Attachments are copied physically to an `/attachments/` directory relative to the `--dest` export flag. Names are sanitized with unique hash prefixes on duplicate collision.

---

## 5. Incremental Sync (`src/sync.ts`)
Full exports are slow because unzipping and parsing CRDT Protobuf records is computationally heavy. `sync` operates incrementally via an `an-export-manifest.json` file.

1. **DB Mtime Mapping:** Apple uses `ZMODIFICATIONDATE1` (a CoreTime float, calculating offset seconds since `2001-01-01`).
2. **Decision Engine:**
   - **New:** `Z_PK` exists in the DB, absent from the manifest. -> Export mapping.
   - **Updated:** CoreData Mtime > Manifest Mtime. -> Export and overwrite.
   - **Unchanged:** CoreData Mtime <= Manifest Mtime. -> Skip processing.
   - **Deleted:** Manifest `Z_PK` doesn't exist in DB anymore. -> Delete `.md` file, drop from manifest.

---

## 6. Directory Structure
```
an-export/
├── src/
│   ├── index.ts        # CLI Orchestration + Public module exports
│   ├── cli.ts          # CLI runner & arg parsing
│   ├── db.ts           # SQLite safely-copy connection handler
│   ├── folders.ts      # Tree traversal for accounts/folders
│   ├── sync.ts         # Manifest logic + computation engine
│   ├── converter.ts    # Protobuf Ast -> Markdown translation
│   ├── attachments.ts  # File location querying + UTI handler
│   ├── ...
├── tests/              # bun:test Unit + Integration suites
├── an-export-manifest/ # Generated incrementally
└── my_output_dest/
    ├── iCloud_Folder/
    │   ├── Note.md
    │   └── attachments/
    │       └── Media.jpeg
```

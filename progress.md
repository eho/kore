## US-001: Project Setup and Scaffolding ✅
**Date:** 2026-03-04

**Completed:**
- Initialized Bun project in `an-export/` with strict TypeScript (`strict: true` in tsconfig.json).
- Installed `protobufjs` dependency and `@types/node` dev dependency.
- Created `src/types.ts` — all TypeScript types and enums ported from the obsidian-importer (ANNote, ANAttributeRun, ANStyleType, ANFontWeight, ANBaseline, all CRDT types, SyncManifest, ExportOptions, etc).
- Created `src/utils.ts` — utility functions: `decodeTime()`, `sanitizeFileName()`, `splitExt()`, `colorToHex()`, `uuidToHex()`.
- Created `src/index.ts` — public library API exports (stub implementations for `exportNotes` and `syncNotes`).
- Created `src/cli.ts` — CLI entry point with `export` and `sync` subcommands and `--dest` flag.
- Created `tests/us-001.test.ts` — 15 unit tests covering utility functions and API exports.
- All 15 tests pass (`bun test`). Typecheck passes (`tsc --noEmit`).
- Committed: `feat: project scaffolding with types, utils, CLI stub, and public API (US-001)`

## US-002: Database Access Layer ✅
**Date:** 2026-03-04

**Completed:**
- Created `src/db.ts` — database access layer with:
  - `openNotesDatabase()`: safely copies `.sqlite`, `.sqlite-shm`, and `.sqlite-wal` to a temp dir, opens read-only via `bun:sqlite`.
  - `buildEntityKeys()`: queries `z_primarykey` to build `{ICAccount: N, ICFolder: N, ...}` lookup map.
  - `queryAll()` / `queryOne()`: typed query helpers with `SQLQueryBindings` params.
  - Graceful error messages for missing DB (with macOS Full Disk Access hint).
- Created `tests/us-002.test.ts` — 7 unit tests: entity key building, missing entity validation, query helpers, DB not found error, and full copy+open flow using real temp SQLite databases.
- All 7 tests pass. Typecheck passes.
- Committed: `feat: database access layer with safe copy, entity lookup, and query helpers (US-002)`

## US-003: Protobuf Schema and Decoder ✅
**Date:** 2026-03-04

**Completed:**
- Ported `descriptor.ts` from obsidian-importer containing all 28 message types.
- Created `an-export/src/decoder.ts` with:
  - `decodeNoteData()` for extracting `ANDocument` from GZIP-compressed note data.
  - `decodeMergeableData()` for extracting `ANMergableDataProto` for tables/scans.
- Created `an-export/tests/us-003.test.ts` with unit tests mocking gzip-compressed hex payloads.
- Unit tests and typecheck pass successfully.
- Committed: `feat: protobuf schema and decoder with gzip decompression (US-003)`

## US-004: Note Content to Markdown Converter ✅
**Date:** 2026-03-05

**Completed:**
- Created `an-export/src/converter.ts` — core note-to-Markdown converter with:
  - Walk `attributeRun[]`, slice `noteText` by cumulative length.
  - Inline formatting: bold (`**`), italic (`*`), bold-italic (`***`), strikethrough (`~~`), underline (`<u>`), superscript (`<sup>`), subscript (`<sub>`).
  - Headings: Title→`#`, Heading→`##`, Subheading→`###`.
  - Lists: dotted/dashed→`- `, numbered→auto-incrementing `N. `, checkbox→`- [ ]`/`- [x]`.
  - Indentation via tab-indent from `indentAmount`.
  - Blockquotes (prefix `> `).
  - Monospaced/code blocks (wrapped in fenced ` ``` `).
  - External links → `[text](url)`.
  - Internal Apple Notes links → `[[Note Title]]` with `resolveNoteLink` callback.
  - Color → `<span style="color:#hex">`.
  - Alignment → `<p style="text-align:center">`.
  - First line omission (title → filename).
  - Markdown escaping for square brackets.
  - Attachment placeholder support via `resolveAttachment` callback.
- Created `an-export/tests/us-004.test.ts` — 31 unit tests covering every formatting rule.
- All 31 tests pass. Typecheck passes.
- Committed: `feat: note content to markdown converter with all formatting rules (US-004)`

## QA & Testing Additions ✅
**Date:** 2026-03-05

**Completed:**
- Verified 100% test coverage across `src/utils.ts`, `src/db.ts`, and `src/converter.ts`.
- Added missing tests for attachment markdown generation (inline attachments).
- Added missing tests for multi-paragraph spacing logic (empty line retention).
- Added missing tests for database `EACCES` filesystem copy errors yielding the Full Disk Access hint.
- Added missing tests for `uuidToHex` utility.
- Confirmed test suite contains 59 passing unit tests.

## US-005: Table Conversion ✅
**Date:** 2026-03-05

**Completed:**
- Created `an-export/src/table-converter.ts` — functional CRDT table→Markdown converter with:
  - `convertTableToMarkdown()`: main entry point accepting a decoded `ANMergableDataProto` and cell converter callback.
  - `findLocations()`: extracts row/column UUID→position mappings from CRDT `OrderedSet` structures.
  - `getTargetUuid()`: dereferences CRDT object entries through indirection to resolve UUIDs.
  - `formatTable()`: converts a 2D string array to a Markdown table with `|` separators and `--` header row.
  - Uses a callback pattern for cell conversion to avoid circular dependency with `converter.ts`.
- Created `an-export/tests/us-005.test.ts` — 13 unit tests covering:
  - `formatTable`: 2×3, 3×2, 1×1, and empty table formatting.
  - `getTargetUuid`: UUID dereferencing with different indices.
  - `findLocations`: UUID→position mapping from ordered sets.
  - End-to-end `convertTableToMarkdown`: 2×3, 3×2, 1×1 tables, missing ICTable root, missing cellData, and callback verification.
- All 72 tests pass (`bun test`). Typecheck passes (`tsc --noEmit`).


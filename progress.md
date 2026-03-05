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

## US-006: Attachment Extraction ✅
**Date:** 2026-03-05

**Completed:**
- Created `an-export/src/attachments.ts` — full attachment resolution module with:
  - `createAttachmentResolver()`: factory that creates a `resolveAttachment` callback for `converter.ts`.
  - Dispatches on `typeUti` for all attachment types: Hashtag/Mention → plain text, InternalLink → `[[Title]]`, Table → CRDT decode + Markdown table, UrlCard → `[**Title**](url)`, Scan → CRDT decode + scan pages, ModifiedScan → FallbackPDFs, Drawing → FallbackImages, general media → Media/.
  - `buildAttachmentSourcePath()`: constructs on-disk source paths for each type.
  - `copyAttachmentFile()`: copies binary to `<dest>/attachments/` with unique naming and returns Markdown image/link syntax.
  - `getAttachmentBinary()`: reads from account path first, falls back to global Apple Notes path.
  - Handwriting OCR summary support via `withHandwriting()`.
- Created `an-export/src/scan-converter.ts` — CRDT scan document → Markdown image links:
  - Iterates CRDT objects, extracts scan page UUIDs.
  - Resolves as preview JPEG first, falls back to raw media.
- Added `AttachmentRow` type to `an-export/src/types.ts` with all columns needed by attachment queries.
- Created `an-export/tests/us-006.test.ts` — 23 unit tests covering:
  - `buildAttachmentSourcePath`: 8 tests for all path patterns (ModifiedScan, Scan, Drawing with/without generation, DrawingLegacy, default media with/without generation).
  - `getAttachmentBinary`: 2 tests (account path read, missing file returns null).
  - `copyAttachmentFile`: 4 tests (image copy + link, non-image link, missing file, unique filename generation).
  - `createAttachmentResolver`: 9 tests (hashtag, mention, internal link with/without resolution, URL card with/without title, unknown type, general media end-to-end, missing ZALTTEXT).
- Created `an-export/tests/us-006-attachments-extra.test.ts` — 15 unit tests covering attachment edge cases (missing data in DB yielding fallbacks).
- Created `an-export/tests/us-006-scan.test.ts` — 6 unit tests covering `convertScanToMarkdown` with 100% coverage (previews, raw media fallbacks, and missing rows).
- All 116 tests pass (`bun test`). Functional test coverage is 100% for attachments and converters. Typecheck passes (`tsc --noEmit`).

## US-007: Folder & Account Resolution ✅
**Date:** 2026-03-05

**Completed:**
- Created `an-export/src/folders.ts` — folder & account resolution module with:
  - `resolveAccounts()`: queries `ICAccount` entities from DB, returns `ANAccount[]` with name, uuid, and on-disk data directory path.
  - `resolveFolders()`: queries all `ICFolder` entities, filters out Smart Folders (`ZFOLDERTYPE = 3`) and Trash (`ZFOLDERTYPE = 1`) unless `includeTrashed` is set, recursively resolves `ZPARENT` chain to build full directory paths, creates output directories on disk.
  - `buildFolderPath()`: recursive helper that walks the parent chain, handles Default Folder mapping to export root (no subfolder), and multi-account prefixing with account name.
  - Default "Notes" folder (`ZIDENTIFIER` starts with `DefaultFolder`) maps to the export root.
  - Multi-account: if >1 account, each account's tree is prefixed with the account name.
  - Folder names sanitized via `sanitizeFileName()`, null titles fall back to "Untitled Folder".
- Created `an-export/tests/us-007.test.ts` — 18 unit tests covering:
  - `resolveAccounts`: single/multiple accounts, empty accounts, null ZNAME fallback.
  - `resolveFolders`: simple top-level, nested hierarchy, default folder mapping, smart folder skipping, trash folder skipping/inclusion, multi-account prefixing, directory creation, name sanitization, null title fallback.
  - `buildFolderPath`: default folder (single & multi-account), nested parent chain, broken parent chain.
- All 134 tests pass (`bun test`). Typecheck passes for new code.

## US-008: Sync Manifest & Incremental Sync ✅
**Date:** 2026-03-05

**Completed:**
- Created `an-export/src/sync.ts` — sync manifest & incremental sync module with:
  - `createEmptyManifest()`: creates a fresh version-1 manifest.
  - `loadManifest()`: loads existing manifest from disk, returns empty manifest if not found, validates version.
  - `saveManifest()`: writes manifest JSON to the export root with updated `exportedAt` timestamp.
  - `computeNoteSyncDecisions()`: compares DB notes against manifest to classify each as new/updated/unchanged/deleted.
  - `computeAttachmentSyncDecisions()`: same logic for attachments.
  - `buildNoteManifestEntry()` / `buildAttachmentManifestEntry()`: construct manifest entries with relative paths and decoded mtimes.
  - `applyDeletions()`: deletes exported files for removed notes/attachments, removes entries from manifest, handles already-deleted files gracefully.
- Created `an-export/tests/us-008.test.ts` — 24 unit tests covering:
  - `createEmptyManifest`: version, empty notes/attachments.
  - `loadManifest`: missing file, existing file, unsupported version error.
  - `saveManifest`: write + overwrite.
  - `computeNoteSyncDecisions`: new, updated, unchanged, deleted, mixed scenario, empty inputs.
  - `computeAttachmentSyncDecisions`: new, updated, unchanged, deleted.
  - `buildNoteManifestEntry`: relative paths from export dest, file at root.
  - `buildAttachmentManifestEntry`: relative attachment path.
  - `applyDeletions`: file removal + manifest cleanup, already-deleted files, skip non-deleted, attachment deletion, multiple deletions.
- All 159 tests pass (`bun test`). Typecheck passes for new code.

## US-009: CLI Implementation ✅
**Date:** 2026-03-05

**Completed:**
- Replaced placeholder `exportNotes()`/`syncNotes()` in `an-export/src/index.ts` with real orchestration logic:
  - Shared `runExportPipeline()` function handles both export (all notes) and sync (incremental) modes.
  - Opens Apple Notes DB via `openNotesDatabase()`, resolves accounts and folders, queries all notes.
  - For each note: decodes protobuf, resolves attachments (with account path fallback), converts to Markdown, writes `.md` file.
  - Password-protected notes are skipped with a warning via `onProgress` callback.
  - Saves sync manifest (`an-export-manifest.json`) on every run.
  - Sync mode: loads existing manifest, computes sync decisions (new/updated/unchanged/deleted), only processes changed notes, applies deletions for removed notes.
  - Pre-builds `accountByPk` Map for efficient account resolution per note.
- Updated `an-export/src/cli.ts` with:
  - `onProgress` callback passed to `exportNotes`/`syncNotes` for real-time progress output.
  - Failed notes listing printed to stderr on completion.
- Created `an-export/tests/us-009.test.ts` — 24 integration tests covering:
  - CLI argument parsing: export/sync command detection, --dest parsing, missing/invalid commands.
  - Export pipeline: real SQLite DB with schema → accounts → folders → notes query, manifest creation/saving.
  - Password-protected note detection and skip logic.
  - Sync decisions: new, updated, unchanged, deleted note classification.
  - Full sync cycle: export → modify DB → sync → verify correct new/updated/deleted counts.
  - Database-to-folder integration: nested hierarchy, default folder mapping, smart/trash folder filtering.
  - Progress callback behavior: skip messages, export counts, deletion messages.
  - Module exports: `exportNotes`, `syncNotes`, `decodeTime`, `sanitizeFileName`.
- All 183 tests pass (`bun test`). Typecheck passes for new code.

## Monorepo Restructuring ✅
**Date:** 2026-03-05

**Completed:**
- Refactored the project into a **Bun Monorepo** structure.
- Created `packages/` and `apps/` directories.
- Moved `an-export` into `packages/an-export/` and renamed it to `@memory-bank/an-export`.
- Created a root `package.json` with Bun workspace configuration (`./packages/*`, `./apps/*`).
- Created a root `tsconfig.json` with shared base settings and path aliases.
- Created a root `README.md` explaining the Memory Bank vision and monorepo structure.
- Updated `packages/an-export/README.md` to align with the new workspace-based workflow.
- Updated the root `.gitignore` to handle hoisted `node_modules` and workspace-specific exclusions.
- Updated `memory-bank.code-workspace` for better multi-root navigation in VS Code.
- Verified that `@memory-bank/an-export` tests pass when executed from the monorepo root.
- Committed: `refactor: transition to bun monorepo structure`

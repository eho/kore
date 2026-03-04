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

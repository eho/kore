# Apple Notes Exporter (`@personal-memory/an-export`)

A fast, robust, and non-destructive tool to export your Apple Notes to standard Markdown (`.md`) files. This is a core package within the `personal-memory` monorepo.

## Features

- **Pristine Markdown:** Converts Apple Notes rich text (bold, italic, tables, lists, links) into standard Markdown.
- **Attachment Extraction:** Resolves and copies images, scans, PDFs, and drawings to an `attachments/` folder, replacing them with standard Markdown links in the text.
- **Folder Structure Preservation:** Maintains your exact nested folder structure and multi-account setup (e.g., "iCloud", "Exchange").
- **Incremental Sync:** Run initial `export`, and later use `sync` to only process newly added or modified notes, drastically reducing export times for large accounts. It also cleans up Markdown files for notes that you deleted in Apple Notes.
- **Safe & Non-Destructive:** Operates entirely read-only on a temporary copy of your database. It will never alter your original Apple Notes.
- **Privacy-First:** Encrypted (password-protected) notes are explicitly skipped without revealing their content.
- **Fast:** Written in TypeScript using [Bun](https://bun.sh/) and `bun:sqlite` for raw performance.

## Prerequisites

- **macOS:** Apple Notes databases are stored locally on macOS. The tool extracts data from `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
- **Bun:** Install [Bun](https://bun.sh/) via `curl -fsSL https://bun.sh/install | bash`.

## Installation & Setup

This package is part of the `personal-memory` monorepo.

1. **Clone the monorepo:**
   ```bash
   git clone <your-repo-url>/personal-memory
   cd personal-memory
   ```

2. **Install all dependencies from the root:**
   ```bash
   bun install
   ```

## Usage

You can run the exporter from the root of the monorepo or from within this package directory.

### Running from Monorepo Root (Recommended)

```bash
# Full Export
bun run --filter @personal-memory/an-export start export --dest ~/Desktop/MyNotesExport

# Incremental Sync
bun run --filter @personal-memory/an-export start sync --dest ~/Desktop/MyNotesExport
```

### Running from Package Directory

```bash
cd packages/an-export
bun run start export --dest ~/Desktop/MyNotesExport
```

## Project Development

- **Run tests (from root):**
  ```bash
  bun test packages/an-export
  ```
- **Type Checking (from root):**
  ```bash
  bun run --filter @personal-memory/an-export typecheck
  ```

## Local Testing & macOS Permissions

macOS strictly protects the Apple Notes database behind its Transparency, Consent, and Control (TCC) system. Because this is a pure CLI tool, it cannot natively prompt for access to the `group.com.apple.notes` directory.

### Safest Way to Test (Manual Copy)

1. **Copy the database files via Finder:**
   Open the directory:
   ```bash
   open ~/Library/Group\ Containers/group.com.apple.notes/
   ```
   * Manually select all three NoteStore files (`NoteStore.sqlite`, `NoteStore.sqlite-wal`, and `NoteStore.sqlite-shm`).
   * Copy them into a local `test-db` folder inside this package.

2. **Run the exporter:**
   Use the `--db-dir` flag to point the CLI at your copied database folder:
   ```bash
   bun run --filter @personal-memory/an-export start export --db-dir packages/an-export/test-db --dest ./my-export
   ```

## How It Works

For a deep dive into how `an-export` safely parses the SQLite schema, decodes CRDT/Protobuf note formats, dynamically links attachments, and handles incremental sync, please refer to the [Technical Design Document](docs/TECHNICAL_DESIGN.md).

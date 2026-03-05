# Apple Notes Exporter (`an-export`)

A fast, robust, and non-destructive tool to export your Apple Notes to standard Markdown (`.md`) files. Designed for macOS, this tool reads directly from the local Apple Notes SQLite database, decodes the proprietary protobuf formats, and generates clean Markdown while preserving your folder hierarchies and extracting your attachments.

## Features

- **Pristine Markdown:** Converts Apple Notes rich text (bold, italic, tables, lists, links) into standard Markdown.
- **Attachment Extraction:** Resolves and copies images, scans, PDFs, and drawings to an `attachments/` folder, replacing them with standard Markdown links in the text.
- **Folder Structure Preservation:** Maintains your exact nested folder structure and multi-account setup (e.g., "iCloud", "Exchange").
- **Incremental Sync:** Run initial `export`, and later use `sync` to only process newly added or modified notes, drastically reducing export times for large accounts. It also cleans up Markdown files for notes that you deleted in Apple Notes.
- **Safe & Non-Destructive:** Operates entirely read-only on a temporary copy of your database. It will never alter your original Apple Notes.
- **Privacy-First:** Encrypted (password-protected) notes are explicitly skipped without revealing their content to ensure your secure data remains secure.
- **Fast:** Written in TypeScript using [Bun](https://bun.sh/) and `bun:sqlite` for raw performance.

## Prerequisites

- **macOS:** Apple Notes databases are stored locally on macOS. The tool extracts data from `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
- **Bun:** Install [Bun](https://bun.sh/) via `curl -fsSL https://bun.sh/install | bash` to run the project.

## Installation

```bash
git clone <your-repo-url>/an-export
cd an-export
bun install
```

## Usage

The CLI requires a destination directory `--dest` for the exported Markdown files.

### 1. Full Export
Use the `export` command to perform a full export of your entire Apple Notes database.

```bash
bun run src/cli.ts export --dest ~/Desktop/MyNotesExport
```

### 2. Incremental Sync
After an initial export, you can continuously backup your latest notes using the `sync` command. This tracks file modifications via a hidden manifest file (`an-export-manifest.json`) and efficiently updates only the changed notes, whilst removing Markdown files for notes you deleted.

```bash
bun run src/cli.ts sync --dest ~/Desktop/MyNotesExport
```

### Example Output
```
Exporting Apple Notes to: /Users/username/Desktop/MyNotesExport
⚠ Skipping password-protected note: Secret Vault
Exported 1/200: Weekly Meeting 
Exported 2/200: Grocery List
...
Done. Exported: 199, Skipped: 1, Failed: 0
```

## Project Development

- **Run all integration and unit tests:**
  ```bash
  bun test
  ```
- **Type Checking:**
  ```bash
  bun run typecheck
  ```

## How It Works

For a deep dive into how `an-export` safely parses the SQLite schema, decodes CRDT/Protobuf note formats, dynamically links attachments, and handles incremental sync, please refer to the [Technical Design Document](docs/TECHNICAL_DESIGN.md).

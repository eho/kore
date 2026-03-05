# Personal Memory Bank

A unified system to ingest, store, and retrieve personal data from various sources (Apple Notes, Obsidian, etc.) to build a long-term, searchable, and intelligent memory bank.

## Project Structure

This project is organized as a **Bun Monorepo**.

```text
personal-memory/
├── packages/
│   ├── an-export/        # Apple Notes Exporter (Engine)
│   └── (more packages)   # Future ingestors, core brain, etc.
├── apps/
│   ├── (future apps)     # GUI wrappers, web interfaces, etc.
├── tasks/                # PRDs, design docs, and task lists
└── progress.md           # Project-wide progress tracker
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (Primary runtime and package manager)
- macOS (for Apple Notes extraction)

### Installation

Install dependencies for all packages from the root:

```bash
bun install
```

### Running Commands

You can run commands for specific packages using the `--filter` flag:

```bash
# Run tests for a specific package
bun test --filter @personal-memory/an-export

# Run a script in a package
bun run --filter @personal-memory/an-export start export --dest ~/Desktop/Export
```

## Development Workflow

- **Type Checking:** `bun run typecheck` (Root)
- **Testing:** `bun test` (Runs all tests across all packages)
- **Adding Dependencies:** `bun add <package> --filter <workspace-name>`

## Roadmap

See [progress.md](progress.md) for the current status of all modules and upcoming features.

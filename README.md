# Kore

**A proactive lifestyle concierge and context-aware personal memory engine.**

Kore is an invisible, AI-integrated backend designed to solve the "Recall Disconnect"—the gap between saving high-value inspiration (travel spots, reading recommendations, hobby ideas) and actually remembering to use it when the right context arises. 

By seamlessly ingesting explicitly saved content from your fragmented digital landscape (Apple Notes, X bookmarks, Safari, etc.), Kore builds a long-term, searchable, and intelligent memory bank. It completely removes the burden of "remembering to remember" by autonomously surfacing the right information exactly when and where you need it—either through seamless conversational AI or proactive, location and context-aware nudges.

### Why "Kore"?

- **The Greek Connection:** Meaning "the core" or "the heart," it sounds like a modern tech stack name but has deep roots in the Eleusinian Mysteries (related to memory and cycles). It ties back to the overarching mythological theme of the Cronus system.
- **The Japanese Connection:** In Japanese, *Kore* (これ) is the demonstrative pronoun for "this" (referring to something close to the speaker). As a literal pointer, it reflects how in programming and AI, we deal heavily with "context" and "this" (the current object).

If Cronus is the persona you talk to, Kore becomes a fitting name for the specific piece of data or memory being surfaced at that moment. It transforms the system from a vague "database" into a tool that says, "Here, use *this* right now."


## Project Structure

This project is organized as a **Bun Monorepo**.

```text
kore/
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
bun test --filter @kore/an-export

# Run a script in a package
bun run --filter @kore/an-export start export --dest ~/Desktop/Export
```

## Development Workflow

- **Type Checking:** `bun run typecheck` (Root)
- **Testing:** `bun test` (Runs all tests across all packages)
- **Adding Dependencies:** `bun add <package> --filter <workspace-name>`

## Roadmap

See [progress.md](progress.md) for the current status of all modules and upcoming features.

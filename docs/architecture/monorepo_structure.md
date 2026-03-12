# Kore Monorepo Structure

Kore uses **Bun Workspaces** for its monorepo architecture. This permits robust code sharing of core ingestion types, Zod schemas, and plugins across the processing engine, ingestion workers, and external wrappers.

All TypeScript must use strict mode parsing. Everything runs on the Bun runtime.

---

## 1. Top-Level Hierarchy

The workspace is divided into three primary directory types: `apps/`, `packages/`, and `plugins/`.

```bash
kore/
├── apps/               # Executable, standalone services and deployables
├── packages/           # Reusable internal libraries and ingestion wrappers
├── plugins/            # Registered Kore plugins adhering to `plugin_system.md`
├── docs/               # Architecture, analysis, and API documentation
├── package.json        # Workspace root definition
├── bunfig.toml         # Base Bun configuration
└── tsconfig.json       # Root TypeScript configuration
```

---

## 2. Directory Breakdowns

### 2.1 Apps (`apps/`)
These contain the server entry points and long-running daemons.

*   `apps/core-api/`: The ElysiaJS REST API server. Responsible for accepting raw data, spinning up queue workers, running LLM extraction, and firing plugin hooks.
*   `apps/cli/`: A command line interface for manual ingestion overrides, status checking, and triggering `qmd` updates cleanly.
*   `apps/web-client/`: (Future) A lightweight solid-JS or React dashboard for visualizing system health or viewing indexed memories directly if not using an AI Agent.

### 2.2 Packages (`packages/`)
These contain shared business logic and specific ingestion wrappers. They do NOT run continually on their own.

*   `packages/shared-types/`: The absolute source of truth for the Zod definitions detailed in `data_schema.md` (e.g. `BaseFrontmatterSchema`, `MemoryExtractionSchema`). All apps and plugins import from this.
*   `packages/an-export/`: The Apple Notes export script. Handles local SQLite database connections to Apple Notes and formats extraction before piping it to `apps/core-api`.
*   `packages/qmd-client/`: A robust abstraction layer wrapping the local `@tobilu/qmd` CLI. The Core Engine uses this to programmatically trigger re-indexes and retrieve stats without raw shelling.
*   `packages/llm-extractor/`: Encapsulates the Vercel AI SDK integration, system prompts, and queue logic used by `apps/core-api` to process raw text.

### 2.3 Plugins (`plugins/`)
Plugins conform to the `KorePlugin` interface defined in `docs/architecture/plugin_system.md`. They are isolated to ensure the core is not bloated with feature specific dependencies.

*   `plugins/spatialite/`: Uses `better-sqlite3` and `mod_spatialite` to maintain a standalone location database listening to `memory.indexed` hooks. Exposes geolocation API routes for the Push channel.
*   `plugins/synthesis/`: (Future) Manages the "Consolidation Loop" background cron jobs and outputs new linked `.md` files.

---

---

## 3. Dependency Management

*   **Rule 1: Strict Boundaries:** Code within `apps/` CANNOT depend on other code within `apps/`. An app can only depend on `packages/` or `plugins/`.
*   **Rule 2: Base Types:** All Zod schemas MUST be defined in `packages/shared-types/` and published locally so that if `an-export` and `core-api` drift, the TS compiler catches the mismatch.
*   **Rule 3: NPM over Local:** QMD (`@tobilu/qmd`) should be listed as a root dependency to ensure a single binary instance is utilized across the whole monorepo.

## 4. Example `package.json` Workspaces Definition



```json
{
  "name": "kore-monorepo",
  "version": "1.0.0",
  "workspaces": [
    "apps/*",
    "packages/*",
    "plugins/*"
  ],
  "dependencies": {
    "@tobilu/qmd": "latest",
    "typescript": "^5.0.0"
  }
}
```

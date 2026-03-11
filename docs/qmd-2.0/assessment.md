# QMD 2.0 Assessment & Refactoring Strategy

## 1. Executive Summary
The release of QMD 2.0 introduces a powerful native SDK (`@tobilu/qmd`) for Node.js and Bun, shifting it from a standalone CLI tool to an embeddable library. This brings typed interfaces, better error handling, streaming indexing, and an MCP server.

To leverage these improvements in `kore`, we should refactor `packages/qmd-client` to utilize the native SDK. This will eliminate our reliance on `Bun.spawn` for CLI child processes, drastically improving reliability, typed safety, and opening the door for deeper RAG (Retrieval-Augmented Generation) capabilities.

## 2. Review of QMD 2.0 Key Additions

1. **Native TypeScript Library Interface:** Exported APIs like `createStore`, `store.search()`, `store.update()`, `store.addCollection()` natively bind to QMD's indexing and querying logic.
2. **Context API (`store.addContext`):** Allows tagging metadata (e.g., descriptions) to collections and paths. This acts as a tree and helps the LLM reranker make better contextual choices during search queries.
3. **Smart Chunking:** A new scoring algorithm for chunking documents instead of strict token cutoffs. It preserves semantic units (headings, code blocks) in a smart 900-token window.
4. **Unified Search & Retrieval:** APIs like `store.search()`, `store.get()`, and `store.multiGet()` handle queries natively without needing CLI string interpolation.
5. **Model Context Protocol (MCP) Server:** Rewritten as a clean SDK consumer, exposed over HTTP or stdio, enabling tighter integration with Claude and other LLM agents out of the box.
6. **`intent` Parameter:** Steers the entire search pipeline (expansion, reranking, snippet extraction) with a domain hint — directly useful for kore's known-domain collections.
7. **`Maintenance` Class:** Exposes housekeeping operations (vacuum, orphaned content/vector cleanup, embedding cache deletion) for operational tooling.
8. **`getDocumentBody()`:** Fetches raw document content with optional line-range slicing — enables source-document retrieval in the RAG pipeline.

## 3. Current Implementation in Kore

Currently, `packages/qmd-client` operates as a primitive CLI wrapper:
- It uses `Bun.spawn` to shell out commands (`qmd update`, `qmd collection add`, `qmd status`).
- Requires users to have QMD globally installed (`bun install -g @tobilu/qmd`).
- Relies on opaque standard output/error parsing to deduce success/failure.
- Does not take advantage of QMD's search capabilities directly within the Node context.

## 4. Refactoring Strategy & New Opportunities

We should completely overhaul `packages/qmd-client` to wrap the new SDK.

### A. Dependency Management
- **Action:** Add `@tobilu/qmd` directly as a dependency to `packages/qmd-client`.
- **Benefit:** Removes the global dependency requirement. Version locking ensures reproducibility.

### B. API Migration & Lifecycle Management
- **Action:** Replace `Bun.spawn` calls with the `QMDStore` lifecycle.
- **Implementation:**
  ```typescript
  import { createStore, QMDStore } from '@tobilu/qmd';

  // Inside qmd-client, manage a singleton or factory:
  let store: QMDStore;

  export async function initStore(dbPath: string) {
    store = await createStore({ dbPath });
  }

  export async function reindex() {
    // update() scans the filesystem and ingests content changes into SQLite.
    // embed() generates vector embeddings for new/changed documents.
    // Both steps are required — skipping embed() means vector search degrades
    // over time as new documents accumulate without embeddings.
    const updateResult = await store.update({
      onProgress: ({ collection, file, current, total }) => {
        // Can now emit progress events to the UI/frontend
      }
    });
    const embedResult = await store.embed();
    return { updateResult, embedResult };
  }
  ```
- **Benefit:** `qmd update`, `qmd status`, and `qmd collection add` become simple awaitable function calls yielding strongly typed objects instead of parsed strings.
- **API mapping from CLI to SDK:**
  - `qmd update` → `store.update()` **followed by** `store.embed()` (two separate steps — see critical note below)
  - `qmd status` → `store.getStatus()` (returns typed `IndexStatus`)
  - `qmd collection list` → `store.listCollections()`
  - `qmd collection add` → `store.addCollection()`
  - `store.getIndexHealth()` → new — exposes stale embedding counts and index health metrics for monitoring

> **Critical:** In QMD 2.0's SDK, `update()` and `embed()` are intentionally separate operations. `update()` only scans the filesystem and ingests document content/hashes into SQLite. `embed()` generates the vector embeddings needed for semantic and hybrid search. The `qmd update` CLI runs both internally, so callers migrating to the SDK must invoke both. Calling only `store.update()` will silently degrade vector search quality as new documents never get embeddings.

### C. State & Configuration
- **Action:** Configure `dbPath` dynamically, and choose between inline config or `configPath`.
- **Inline config** (recommended for kore's programmatic use):
  ```typescript
  createStore({
    dbPath: '/app/db/qmd.sqlite',
    config: { collections: { notes: { path: '/app/data/notes', pattern: '**/*.md' } } }
  })
  ```
- **`configPath` option** (useful if retaining the YAML as human-readable source of truth):
  ```typescript
  createStore({ dbPath: '/app/db/qmd.sqlite', configPath: '/home/bun/.config/qmd/index.yml' })
  ```
  With `configPath`, mutations via `store.addCollection()` write through to both SQLite and the YAML file. The current `docker-compose.yml` already mounts a YAML config volume, so this path requires minimal change but keeps the YAML as the authoritative config.
- **Benefit:** Scopes `kore`'s index away from the user's default `~/.cache/qmd/index.sqlite`, sandboxing it from other projects.

### D. Advanced Search & RAG Integration
- **Action:** Expose `store.search()`, `store.get()`, and `store.searchLex()` in `qmd-client`.
- **Benefit:** We can integrate native hybrid searches (FTS + Vector + Reranking) directly within `apps/core-api`. Results return as typed `HybridQueryResult` or `DocumentResult` arrays, containing rich properties like `score` and `snippet`.
- **`intent` parameter:** Pass a domain hint on every search call to steer the full pipeline:
  ```typescript
  store.search({ query: "meeting notes from Q1", intent: "personal Apple Notes export" })
  ```
  This improves expansion, reranking, and snippet extraction without changing the query itself.
- **`store.searchLex()` and `store.searchVector()`** are also available as standalone methods for cases where BM25-only or vector-only search is preferable (e.g., low-latency keyword lookups without LLM overhead).

### E. Context Utilization
- **Action:** When `kore` creates a collection (like Apple Notes export), use `store.addContext()`.
- **Benefit:** By adding context (e.g., `store.addContext("notes", "/", "Exported Apple Notes")`), we immediately boost search relevance and LLM reranking quality.
- **`ignore` patterns:** Use the `ignore` option on `addCollection()` to filter noise:
  ```typescript
  store.addCollection("notes", { path: '/app/data/notes', ignore: ["*.tmp", ".DS_Store"] })
  ```

## 5. Recommended Implementation Steps

1. **Install SDK:** `cd packages/qmd-client && bun add @tobilu/qmd`.
2. **Rewrite Client Wrapper (`packages/qmd-client/index.ts`):**
   - Remove `Bun.spawn` logic.
   - Implement `createStore()` and export initialized store methods (`reindex` — wrapping both `update()` + `embed()`), `search`, `get`, `getStatus`, `addCollection`, `addContext`).
3. **Core-API Updates (`apps/core-api`):**
   - On application startup, initialize the QMD store connection.
   - On application shutdown, ensure `store.close()` is called to dispose of LLM models and SQLite connections safely.
   - Update `watcher.ts` to call the new `reindex()` wrapper (both `update()` + `embed()`).
   - Wire `store.getStatus()` into the health endpoint (currently using `qmd status` parse).
4. **Update Tests:** Refactor `packages/qmd-client/index.test.ts` to mock the QMD store object rather than mocking `Bun.spawn`.

## 6. Docker & Infrastructure Considerations

Migrating to the native SDK will significantly streamline our Docker setup, but it introduces a critical requirement regarding caching.

### A. Dockerfile Cleanup
We can simplify our `Dockerfile` by removing the global CLI installation steps:
- **Remove:** `RUN bun install -g @tobilu/qmd` and its associated `BUN_INSTALL` PATH configurations. Since QMD will be a standard `node_modules` dependency in `@kore/qmd-client`, it will be installed alongside the rest of the workspace dependencies.
- **Remove:** The node symlink (`RUN ln -s /usr/local/bin/bun /usr/local/bin/node`) is no longer required, as we won't be invoking the `qmd` CLI binary at all.
- **Keep:** Native build tools (`build-essential`, `python3`) in the builder stage. These are still required — now for `@tobilu/qmd`'s own native C++ addons (`better-sqlite3`, `sqlite-vec`, `node-llama-cpp`) rather than the global CLI.

> **Note:** `@tobilu/qmd` uses `better-sqlite3` (a Node.js native addon) rather than `bun:sqlite`. This works correctly on Bun via Node.js compatibility, but means the QMD store's SQLite connection runs through a different driver than kore's own queue DB (`bun:sqlite`). Both work correctly in the same process; just be aware they are independent connections.

### B. State Management (`docker-compose.yml`)
- **Database Path:** Currently, QMD stores its index at `~/.cache/qmd/index.sqlite`. With the SDK, we will explicitly configure this path via `createStore({ dbPath: '/app/db/qmd.sqlite' })`. This neatly places the QMD database in our existing persistent mount (`${KORE_DB_PATH:-~/.kore/db}:/app/db`).
- **GGUF Model Caching (Critical):** QMD 2.0 automatically downloads over 2GB of GGUF models (for embeddings, re-ranking, and query expansion) on first use. These are stored by default in `~/.cache/qmd/models`.
  - **Action Needed:** We must persist the `~/.cache` directory in `docker-compose.yml`. If we fail to mount a volume for this cache, the container will re-download the 2GB+ models every time it restarts, causing massive startup delays and bandwidth usage.
  - **Implementation:** Replace the old `${QMD_CONFIG_PATH}:/home/bun/.config/qmd` volume mount with `${QMD_CACHE_PATH:-~/.kore/qmd-cache}:/home/bun/.cache/qmd`.
  - If retaining the YAML config via `configPath`, keep a separate config volume: `${QMD_CONFIG_PATH:-~/.kore/qmd-config}:/home/bun/.config/qmd`.

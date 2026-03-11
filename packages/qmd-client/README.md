# @kore/qmd-client

Typed wrapper around the `@tobilu/qmd` SDK. Manages a singleton `QMDStore` instance and exposes typed, awaitable functions for indexing, embedding, and status queries.

## Usage

```typescript
import * as qmdClient from "@kore/qmd-client";

// Initialize the store (once, at process startup)
await qmdClient.initStore("/app/db/qmd.sqlite");

// Scan filesystem and ingest changes
const updateResult = await qmdClient.update();

// Generate vector embeddings for new documents
const embedResult = await qmdClient.embed();

// Get index status
const status = await qmdClient.getStatus();

// Add a collection
await qmdClient.addCollection("notes", {
  path: "/data/notes",
  pattern: "**/*.md",
});

// Add context for better search relevance
await qmdClient.addContext("notes", "/", "Personal knowledge base");

// Close on shutdown
await qmdClient.closeStore();
```

## API

### `initStore(dbPath?: string) → Promise<void>`

Initialize the singleton QMD store. Reads the notes directory from
`KORE_NOTES_PATH` or `KORE_DATA_PATH` env vars and registers it as a
`"memories"` collection. `dbPath` defaults to `KORE_QMD_DB_PATH` env or
`/app/db/qmd.sqlite`.

### `closeStore() → Promise<void>`

Close the store and release all resources (LLM models, DB connections).

### `update() → Promise<UpdateResult>`

Scan the filesystem and ingest content changes into SQLite. Does NOT
generate vector embeddings — call `embed()` separately.

### `embed() → Promise<EmbedResult>`

Generate vector embeddings for documents that need them.

### `getStatus() → Promise<IndexStatus>`

Get index status (document counts, collections, embedding state).

### `getIndexHealth() → Promise<IndexHealthInfo>`

Get index health info (stale embeddings count, total docs, days stale).

### `addCollection(name, opts) → Promise<void>`

Add or update a collection in the store.

### `addContext(collection, path, text) → Promise<boolean>`

Add context for a path within a collection.

### `resetStore() → void`

**Test-only.** Nullifies the singleton without closing. Use in
`afterEach` / `beforeEach` to prevent test collisions.

## Types

All types are re-exported from `@tobilu/qmd`:

- `UpdateResult` — `{ collections, indexed, updated, unchanged, removed, needsEmbedding }`
- `EmbedResult` — `{ docsProcessed, chunksEmbedded, errors, durationMs }`
- `IndexStatus` — `{ totalDocuments, needsEmbedding, hasVectorIndex, collections }`
- `IndexHealthInfo` — `{ needsEmbedding, totalDocs, daysStale }`
- `QMDStore` — full store interface

## Development

```bash
# Run tests (mocks QMDStore — no QMD binary required)
bun test packages/qmd-client
```

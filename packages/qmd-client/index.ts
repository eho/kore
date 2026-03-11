/**
 * QMD Client - Native SDK wrapper for @tobilu/qmd.
 *
 * Manages a singleton QMDStore instance and exposes typed,
 * awaitable functions for indexing, embedding, and status queries.
 * Replaces the previous Bun.spawn CLI wrapper.
 */

import {
  createStore,
  type QMDStore,
  type UpdateResult,
  type EmbedResult,
  type IndexStatus,
  type IndexHealthInfo,
  type CollectionConfig,
} from "@tobilu/qmd";

// Re-export SDK types for downstream consumers
export type {
  QMDStore,
  UpdateResult,
  EmbedResult,
  IndexStatus,
  IndexHealthInfo,
};

// ── Singleton ──────────────────────────────────────────────────────────────

let store: QMDStore | null = null;

const DEFAULT_DB_PATH = "/app/db/qmd.sqlite";

function requireStore(): QMDStore {
  if (!store) {
    throw new Error(
      "QMD store not initialized. Call initStore() before using qmd-client.",
    );
  }
  return store;
}

// ── Exported Functions ─────────────────────────────────────────────────────

/**
 * Initialize the QMD store singleton.
 *
 * Creates a QMDStore with inline collection config that registers the kore
 * data directory as a "memories" collection covering all markdown files.
 *
 * @param dbPath - SQLite database path. Defaults to KORE_QMD_DB_PATH env
 *                 or "/app/db/qmd.sqlite".
 */
export async function initStore(dbPath?: string): Promise<void> {
  if (store) {
    throw new Error(
      "QMD store already initialized. Call closeStore() before re-initializing.",
    );
  }

  const resolvedDbPath =
    dbPath ?? process.env.KORE_QMD_DB_PATH ?? DEFAULT_DB_PATH;

  const notesPath =
    process.env.KORE_NOTES_PATH ?? process.env.KORE_DATA_PATH ?? "/app/data";

  const config: CollectionConfig = {
    collections: {
      memories: {
        path: notesPath,
        pattern: "**/*.md",
      },
    },
  };

  store = await createStore({ dbPath: resolvedDbPath, config });
}

/**
 * Close the QMD store and release all resources (LLM models, DB connections).
 */
export async function closeStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}

/**
 * Scan the filesystem and ingest content changes into the index.
 * Does NOT generate vector embeddings — call embed() separately.
 */
export async function update(): Promise<UpdateResult> {
  return requireStore().update();
}

/**
 * Generate vector embeddings for documents that need them.
 */
export async function embed(): Promise<EmbedResult> {
  return requireStore().embed();
}

/**
 * Get index status (document counts, collections, embedding state).
 */
export async function getStatus(): Promise<IndexStatus> {
  return requireStore().getStatus();
}

/**
 * Get index health info (stale embeddings, etc.).
 */
export async function getIndexHealth(): Promise<IndexHealthInfo> {
  return requireStore().getIndexHealth();
}

/**
 * Add or update a collection in the store.
 */
export async function addCollection(
  name: string,
  opts: { path: string; pattern?: string; ignore?: string[] },
): Promise<void> {
  return requireStore().addCollection(name, opts);
}

/**
 * Add context for a path within a collection to improve search relevance.
 */
export async function addContext(
  collectionName: string,
  pathPrefix: string,
  contextText: string,
): Promise<boolean> {
  return requireStore().addContext(collectionName, pathPrefix, contextText);
}

/**
 * Test-only: reset the singleton without closing.
 * Use in afterEach/beforeEach to prevent test collisions.
 */
export function resetStore(): void {
  store = null;
}

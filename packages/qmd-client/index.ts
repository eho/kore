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
  type HybridQueryResult,
  type SearchOptions,
} from "@tobilu/qmd";

// Re-export SDK types for downstream consumers
export type {
  QMDStore,
  UpdateResult,
  EmbedResult,
  IndexStatus,
  IndexHealthInfo,
  HybridQueryResult,
  SearchOptions,
};

// ── Singleton ──────────────────────────────────────────────────────────────

let store: QMDStore | null = null;
let operationLock: Promise<unknown> = Promise.resolve();

const DEFAULT_DB_PATH = "/app/db/qmd.sqlite";

function requireStore(): QMDStore {
  if (!store) {
    throw new Error(
      "QMD store not initialized. Call initStore() before using qmd-client.",
    );
  }
  return store;
}

/**
 * Acquire the operation lock, ensuring update() and embed() never run
 * concurrently (prevents SQLite lock contention).
 */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = operationLock.then(fn, fn);
  // Keep the chain going regardless of success/failure
  operationLock = next.catch(() => {});
  return next;
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
export function update(): Promise<UpdateResult> {
  return withLock(() => requireStore().update());
}

/**
 * Generate vector embeddings for documents that need them.
 */
export function embed(): Promise<EmbedResult> {
  return withLock(() => requireStore().embed());
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
 * Hybrid search: BM25 + vector + query expansion + LLM reranking.
 * Returns ranked results with snippets and scores.
 */
export function search(
  query: string,
  options?: SearchOptions,
): Promise<HybridQueryResult[]> {
  return withLock(() => requireStore().search({ query, ...options }));
}

/**
 * Test-only: reset the singleton without closing.
 * Use in afterEach/beforeEach to prevent test collisions.
 */
export function resetStore(): void {
  store = null;
  operationLock = Promise.resolve();
}

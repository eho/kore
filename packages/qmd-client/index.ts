/**
 * QMD Client - Native SDK wrapper for @tobilu/qmd.
 *
 * Manages a singleton QMDStore instance and exposes typed,
 * awaitable functions for indexing, embedding, and status queries.
 * Replaces the previous Bun.spawn CLI wrapper.
 */

import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
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

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Resolve the KORE_HOME base directory.
 * Reads KORE_HOME env var; falls back to ~/.kore.
 * Expands leading ~ to os.homedir().
 */
export function resolveKoreHome(): string {
  const raw = process.env.KORE_HOME ?? "~/.kore";
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  if (raw === "~") {
    return homedir();
  }
  return resolve(raw);
}

// ── Spatialite detection ───────────────────────────────────────────────────

const SPATIALITE_CANDIDATES = [
  "/opt/homebrew/lib/mod_spatialite.dylib",       // macOS Homebrew arm64
  "/usr/local/lib/mod_spatialite.dylib",           // macOS Homebrew x86
  "/usr/lib/x86_64-linux-gnu/mod_spatialite.so",  // Linux system default
  "/usr/lib/aarch64-linux-gnu/mod_spatialite.so", // Linux alternative
] as const;

/**
 * Find the Spatialite extension path.
 *
 * Detection order:
 * 1. SPATIALITE_PATH env var (explicit override)
 * 2. macOS Homebrew arm64: /opt/homebrew/lib/mod_spatialite.dylib
 * 3. macOS Homebrew x86:   /usr/local/lib/mod_spatialite.dylib
 * 4. Linux system default: /usr/lib/x86_64-linux-gnu/mod_spatialite.so
 * 5. Linux alternative:    /usr/lib/aarch64-linux-gnu/mod_spatialite.so
 *
 * @returns Resolved path to mod_spatialite, or null if not found
 */
export function findSpatialite(): string | null {
  const envPath = process.env.SPATIALITE_PATH;
  if (envPath) {
    return envPath;
  }

  for (const candidate of SPATIALITE_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ── Singleton ──────────────────────────────────────────────────────────────

let store: QMDStore | null = null;
let operationLock: Promise<unknown> = Promise.resolve();

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

  // NHP-003: Auto-detect Spatialite extension (optional — required only for geospatial plugin)
  const spatialitePath = findSpatialite();
  if (!spatialitePath) {
    console.warn(
      "Spatialite extension not found — geospatial features will be unavailable. " +
      "Install with: brew install spatialite-tools (macOS) or apt-get install libsqlite3-mod-spatialite (Linux)",
    );
  }

  const resolvedDbPath =
    dbPath ?? process.env.KORE_QMD_DB_PATH ?? join(resolveKoreHome(), "db", "qmd.sqlite");

  const notesPath =
    process.env.KORE_NOTES_PATH ?? process.env.KORE_DATA_PATH ?? join(resolveKoreHome(), "data");

  const config: CollectionConfig = {
    collections: {
      memories: {
        path: notesPath,
        pattern: "**/*.md",
      },
    },
  };

  store = await createStore({ dbPath: resolvedDbPath, config });

  // NHP-003: Load Spatialite extension if available
  if (spatialitePath) {
    store.internal.db.loadExtension(spatialitePath);
  }
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
 * Falls back to BM25-only (searchLex) if the hybrid pipeline fails
 * (e.g. node-llama-cpp not available, model loading error).
 * Returns ranked results with snippets and scores.
 */
export async function search(
  query: string,
  options?: SearchOptions,
): Promise<HybridQueryResult[]> {
  return withLock(async () => {
    const s = requireStore();
    try {
      return await s.search({ query, ...options });
    } catch (err) {
      console.warn("Hybrid search failed, falling back to BM25:", err instanceof Error ? err.message : err);
      return s.searchLex(query, { limit: options?.limit, collection: options?.collection });
    }
  });
}

/**
 * Test-only: reset the singleton without closing.
 * Use in afterEach/beforeEach to prevent test collisions.
 */
export function resetStore(): void {
  store = null;
  operationLock = Promise.resolve();
}

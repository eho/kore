import { Database } from "bun:sqlite";

export interface PluginKeyRecord {
  plugin_name: string;
  external_key: string;
  memory_id: string;
  metadata: string | null;
  created_at: string;
}

/**
 * SQLite-backed registry for plugin external-key-to-memory-ID mappings.
 * Shares the same Database instance as QueueRepository (kore-queue.db).
 * All methods are synchronous, matching bun:sqlite patterns.
 */
export class PluginRegistryRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_key_registry (
        plugin_name TEXT NOT NULL,
        external_key TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (plugin_name, external_key)
      );
    `);

    // Migration: add metadata column if missing (existing databases)
    try {
      this.db.exec(`ALTER TABLE plugin_key_registry ADD COLUMN metadata TEXT`);
    } catch {
      // Column already exists — ignore
    }
  }

  get(pluginName: string, externalKey: string): string | undefined {
    const row = this.db
      .query(
        "SELECT memory_id FROM plugin_key_registry WHERE plugin_name = ? AND external_key = ?"
      )
      .get(pluginName, externalKey) as { memory_id: string } | null;
    return row?.memory_id;
  }

  set(pluginName: string, externalKey: string, memoryId: string, metadata?: string): void {
    this.db.run(
      `INSERT INTO plugin_key_registry (plugin_name, external_key, memory_id, metadata)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (plugin_name, external_key) DO UPDATE SET memory_id = excluded.memory_id, metadata = excluded.metadata`,
      [pluginName, externalKey, memoryId, metadata ?? null]
    );
  }

  remove(pluginName: string, externalKey: string): void {
    this.db.run(
      "DELETE FROM plugin_key_registry WHERE plugin_name = ? AND external_key = ?",
      [pluginName, externalKey]
    );
  }

  clear(pluginName: string): void {
    this.db.run(
      "DELETE FROM plugin_key_registry WHERE plugin_name = ?",
      [pluginName]
    );
  }

  listByPlugin(pluginName: string): Array<{ externalKey: string; memoryId: string; metadata?: string }> {
    const rows = this.db
      .query(
        "SELECT external_key, memory_id, metadata FROM plugin_key_registry WHERE plugin_name = ? ORDER BY created_at ASC"
      )
      .all(pluginName) as Array<{ external_key: string; memory_id: string; metadata: string | null }>;
    return rows.map((r) => ({
      externalKey: r.external_key,
      memoryId: r.memory_id,
      ...(r.metadata != null ? { metadata: r.metadata } : {}),
    }));
  }
}

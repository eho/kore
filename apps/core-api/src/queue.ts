import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export interface TaskRecord {
  id: string;
  payload: string;
  status: "queued" | "processing" | "completed" | "failed";
  priority: "low" | "normal" | "high";
  retries: number;
  created_at: string;
  updated_at: string;
  error_log: string | null;
}

/**
 * Lightweight SQLite-backed task queue.
 * Full implementation is US-003; this provides the minimal interface
 * needed by US-002 endpoints (enqueue + getTask + getQueueLength).
 */
export class QueueRepository {
  private db: Database;

  constructor(dbPath: string = "kore-queue.db") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority TEXT NOT NULL DEFAULT 'normal',
        retries INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        error_log TEXT
      );
    `);
  }

  enqueue(payload: object, priority: "low" | "normal" | "high" = "normal"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO tasks (id, payload, status, priority, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, JSON.stringify(payload), priority, now, now]
    );
    return id;
  }

  getTask(id: string): TaskRecord | null {
    return this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | null;
  }

  getQueueLength(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'queued'")
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}

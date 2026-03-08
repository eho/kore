import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export const MAX_RETRIES = 3;
export const STALE_TASK_MINUTES = 10;

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
 * SQLite-backed durable task queue with WAL mode, priority ordering,
 * retry logic, stale task recovery, and periodic cleanup.
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

  /**
   * Atomically dequeue the highest-priority FIFO task and lock it
   * by setting status to 'processing'. Uses an explicit transaction
   * to ensure safe concurrent access.
   */
  dequeueAndLock(): TaskRecord | null {
    const txn = this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM tasks WHERE status = 'queued'
           ORDER BY
             CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
             created_at ASC
           LIMIT 1`
        )
        .get() as TaskRecord | null;

      if (!row) return null;

      const now = new Date().toISOString();
      this.db.run(
        `UPDATE tasks SET status = 'processing', updated_at = ? WHERE id = ?`,
        [now, row.id]
      );

      return { ...row, status: "processing" as const, updated_at: now };
    });

    return txn();
  }

  markCompleted(id: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?`,
      [now, id]
    );
  }

  /**
   * Mark a task as failed. Increments retries and re-queues if under
   * MAX_RETRIES, otherwise permanently marks as 'failed'.
   */
  markFailed(id: string, errorMessage: string): void {
    const txn = this.db.transaction(() => {
      const task = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | null;
      if (!task) return;

      const now = new Date().toISOString();
      const newRetries = task.retries + 1;

      if (newRetries >= MAX_RETRIES) {
        this.db.run(
          `UPDATE tasks SET status = 'failed', retries = ?, updated_at = ?, error_log = ? WHERE id = ?`,
          [newRetries, now, errorMessage, id]
        );
      } else {
        this.db.run(
          `UPDATE tasks SET status = 'queued', retries = ?, updated_at = ?, error_log = ? WHERE id = ?`,
          [newRetries, now, errorMessage, id]
        );
      }
    });

    txn();
  }

  /**
   * Delete completed/failed tasks older than the specified number of days.
   */
  cleanupOldTasks(daysToKeep: number): number {
    const result = this.db.run(
      `DELETE FROM tasks WHERE status IN ('completed', 'failed') AND updated_at < datetime('now', '-' || ? || ' days')`,
      [daysToKeep]
    );
    return result.changes;
  }

  /**
   * Recover stale tasks: reset any 'processing' tasks with updated_at
   * older than STALE_TASK_MINUTES back to 'queued'.
   */
  recoverStaleTasks(): number {
    const result = this.db.run(
      `UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'processing' AND updated_at < datetime('now', '-' || ? || ' minutes')`,
      [new Date().toISOString(), STALE_TASK_MINUTES]
    );
    return result.changes;
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

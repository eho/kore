import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
    const now = new Date().toISOString();
    
    // SQLite allows UPDATE ... RETURNING * which perfectly solves our
    // concurrent dequeue issue without explicit transactions or lock upgrades.
    const row = this.db.query(`
      UPDATE tasks 
      SET status = 'processing', updated_at = ? 
      WHERE id = (
        SELECT id FROM tasks 
        WHERE status = 'queued'
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
          created_at ASC
        LIMIT 1
      )
      RETURNING *
    `).get(now) as TaskRecord | null;

    if (!row) return null;
    return row;
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
    this.db.run(
      `DELETE FROM tasks WHERE status IN ('completed', 'failed') AND updated_at < datetime('now', '-' || ? || ' days')`,
      [daysToKeep]
    );
    return (this.db.query("SELECT changes() as n").get() as { n: number }).n;
  }

  /**
   * Recover stale tasks: reset any 'processing' tasks with updated_at
   * older than STALE_TASK_MINUTES back to 'queued'.
   */
  recoverStaleTasks(): number {
    this.db.run(
      `UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'processing' AND updated_at < datetime('now', '-' || ? || ' minutes')`,
      [new Date().toISOString(), STALE_TASK_MINUTES]
    );
    return (this.db.query("SELECT changes() as n").get() as { n: number }).n;
  }

  getTask(id: string): TaskRecord | null {
    return this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | null;
  }

  /**
   * Delete all tasks from the queue and return the number of rows deleted.
   */
  clearAll(): number {
    this.db.run("DELETE FROM tasks");
    return (this.db.query("SELECT changes() as n").get() as { n: number }).n;
  }

  getQueueLength(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'queued'")
      .get() as { count: number };
    return row.count;
  }

  /** Expose the underlying Database instance for sharing with other repositories. */
  getDatabase(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

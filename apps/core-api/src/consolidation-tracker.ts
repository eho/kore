import type { Database } from "bun:sqlite";

export interface TrackerRow {
  memory_id: string;
  memory_type: string;
  consolidated_at: string | null;
  status: string;
  re_eval_reason: string | null;
  synthesis_attempts: number;
  last_attempted_at: string | null;
  updated_at: string;
}

export interface SeedResult {
  memoryId: string;
  isReeval: boolean;
}

const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_MAX_SYNTHESIS_ATTEMPTS = 3;

/**
 * SQLite-backed tracker for the consolidation pipeline.
 * Manages lifecycle state for memories and insights in the consolidation process.
 */
export class ConsolidationTracker {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_tracker (
        memory_id TEXT PRIMARY KEY,
        memory_type TEXT NOT NULL,
        consolidated_at DATETIME,
        status TEXT DEFAULT 'pending',
        re_eval_reason TEXT,
        synthesis_attempts INTEGER DEFAULT 0,
        last_attempted_at DATETIME,
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_tracker(status);
      CREATE INDEX IF NOT EXISTS idx_consolidation_pending ON consolidation_tracker(consolidated_at, memory_type)
        WHERE status = 'pending' AND memory_type != 'insight';
    `);
  }

  /** Insert with status='pending' if not exists, no-op if exists. */
  upsertMemory(id: string, type: string): void {
    this.db.run(
      `INSERT INTO consolidation_tracker (memory_id, memory_type, status, updated_at)
       VALUES (?, ?, 'pending', datetime('now'))
       ON CONFLICT(memory_id) DO NOTHING`,
      [id, type]
    );
  }

  /** Set status='active', consolidated_at=now(). */
  markConsolidated(id: string, _insightId?: string): void {
    this.db.run(
      `UPDATE consolidation_tracker
       SET status = 'active', consolidated_at = datetime('now'), updated_at = datetime('now')
       WHERE memory_id = ?`,
      [id]
    );
  }

  /** Increment synthesis_attempts, set last_attempted_at=now(), set status='failed' if >= maxSynthesisAttempts. */
  markFailed(id: string, maxSynthesisAttempts: number = DEFAULT_MAX_SYNTHESIS_ATTEMPTS): void {
    const row = this.db.query(
      `SELECT synthesis_attempts FROM consolidation_tracker WHERE memory_id = ?`
    ).get(id) as { synthesis_attempts: number } | null;

    if (!row) return;

    const newAttempts = row.synthesis_attempts + 1;
    const newStatus = newAttempts >= maxSynthesisAttempts ? "failed" : "pending";

    this.db.run(
      `UPDATE consolidation_tracker
       SET synthesis_attempts = ?, last_attempted_at = datetime('now'), status = ?, updated_at = datetime('now')
       WHERE memory_id = ?`,
      [newAttempts, newStatus, id]
    );
  }

  /** Set status='evolving', re_eval_reason. */
  markEvolving(id: string, reason: "new_evidence" | "source_deleted"): void {
    this.db.run(
      `UPDATE consolidation_tracker
       SET status = 'evolving', re_eval_reason = ?, updated_at = datetime('now')
       WHERE memory_id = ?`,
      [reason, id]
    );
  }

  /** Set status='degraded'. */
  markDegraded(id: string): void {
    this.db.run(
      `UPDATE consolidation_tracker
       SET status = 'degraded', updated_at = datetime('now')
       WHERE memory_id = ?`,
      [id]
    );
  }

  /** Set status='retired'. */
  markRetired(id: string): void {
    this.db.run(
      `UPDATE consolidation_tracker
       SET status = 'retired', updated_at = datetime('now')
       WHERE memory_id = ?`,
      [id]
    );
  }

  /**
   * Dual-queue seed selection per design doc §10.6:
   * 1. Re-evaluation queue first (priority): evolving/degraded insights
   * 2. New seed queue: pending non-insight memories respecting cooldown
   */
  selectSeed(
    cooldownDays: number = DEFAULT_COOLDOWN_DAYS,
    maxSynthesisAttempts: number = DEFAULT_MAX_SYNTHESIS_ATTEMPTS
  ): SeedResult | null {
    // 1. Re-evaluation queue first
    const reeval = this.db.query(`
      SELECT memory_id FROM consolidation_tracker
      WHERE memory_type = 'insight'
        AND status IN ('evolving', 'degraded')
        AND synthesis_attempts < ?
      ORDER BY updated_at ASC
      LIMIT 1
    `).get(maxSynthesisAttempts) as { memory_id: string } | null;

    if (reeval) {
      return { memoryId: reeval.memory_id, isReeval: true };
    }

    // 2. New seed queue
    const cooldownParam = `-${cooldownDays} days`;
    const seed = this.db.query(`
      SELECT memory_id FROM consolidation_tracker
      WHERE memory_type != 'insight'
        AND status NOT IN ('failed', 'retired')
        AND synthesis_attempts < ?
        AND (consolidated_at IS NULL OR consolidated_at < datetime('now', ?))
      ORDER BY
        CASE WHEN consolidated_at IS NULL THEN 0 ELSE 1 END,
        consolidated_at ASC
      LIMIT 1
    `).get(maxSynthesisAttempts, cooldownParam) as { memory_id: string } | null;

    if (seed) {
      return { memoryId: seed.memory_id, isReeval: false };
    }

    return null;
  }

  /** Return current tracker row or null. */
  getStatus(id: string): TrackerRow | null {
    return this.db.query(
      `SELECT * FROM consolidation_tracker WHERE memory_id = ?`
    ).get(id) as TrackerRow | null;
  }

  /** Set all 'failed' rows back to 'pending', reset synthesis_attempts to 0. */
  resetFailed(): void {
    this.db.run(
      `UPDATE consolidation_tracker
       SET status = 'pending', synthesis_attempts = 0, updated_at = datetime('now')
       WHERE status = 'failed'`
    );
  }

  /** Delete all rows (used by reset command). */
  truncateAll(): void {
    this.db.run("DELETE FROM consolidation_tracker");
  }
}

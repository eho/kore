import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { QueueRepository, MAX_RETRIES } from "./queue";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

let tempDir: string;
let queue: QueueRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-queue-test-"));
  queue = new QueueRepository(join(tempDir, `queue-${Date.now()}.db`));
});

afterEach(async () => {
  queue.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── enqueue ────────────────────────────────────────────────────────

describe("enqueue", () => {
  test("inserts a task with queued status", () => {
    const id = queue.enqueue({ source: "test", content: "hello" });
    const task = queue.getTask(id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("queued");
    expect(task!.retries).toBe(0);
    expect(task!.error_log).toBeNull();
  });

  test("stores priority correctly", () => {
    const id = queue.enqueue({ content: "x" }, "high");
    const task = queue.getTask(id);
    expect(task!.priority).toBe("high");
  });

  test("defaults priority to normal", () => {
    const id = queue.enqueue({ content: "x" });
    const task = queue.getTask(id);
    expect(task!.priority).toBe("normal");
  });

  test("stores payload as JSON string", () => {
    const payload = { source: "apple_notes", content: "my note" };
    const id = queue.enqueue(payload);
    const task = queue.getTask(id);
    expect(JSON.parse(task!.payload)).toEqual(payload);
  });
});

// ─── dequeueAndLock ─────────────────────────────────────────────────

describe("dequeueAndLock", () => {
  test("returns null when queue is empty", () => {
    const task = queue.dequeueAndLock();
    expect(task).toBeNull();
  });

  test("returns a task and sets status to processing", () => {
    const id = queue.enqueue({ content: "x" });
    const task = queue.dequeueAndLock();
    expect(task).not.toBeNull();
    expect(task!.id).toBe(id);
    expect(task!.status).toBe("processing");

    // Verify in DB too
    const dbTask = queue.getTask(id);
    expect(dbTask!.status).toBe("processing");
  });

  test("does not return already-processing tasks", () => {
    queue.enqueue({ content: "first" });
    queue.dequeueAndLock(); // locks the first one

    const second = queue.dequeueAndLock();
    expect(second).toBeNull();
  });

  test("respects priority ordering: high > normal > low", () => {
    const lowId = queue.enqueue({ content: "low" }, "low");
    const normalId = queue.enqueue({ content: "normal" }, "normal");
    const highId = queue.enqueue({ content: "high" }, "high");

    const first = queue.dequeueAndLock();
    expect(first!.id).toBe(highId);

    const second = queue.dequeueAndLock();
    expect(second!.id).toBe(normalId);

    const third = queue.dequeueAndLock();
    expect(third!.id).toBe(lowId);
  });

  test("uses FIFO within same priority", () => {
    const id1 = queue.enqueue({ content: "first" }, "normal");
    // Tiny delay to ensure different created_at timestamps
    const id2 = queue.enqueue({ content: "second" }, "normal");

    const first = queue.dequeueAndLock();
    expect(first!.id).toBe(id1);

    const second = queue.dequeueAndLock();
    expect(second!.id).toBe(id2);
  });
});

// ─── markCompleted ──────────────────────────────────────────────────

describe("markCompleted", () => {
  test("sets task status to completed", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();
    queue.markCompleted(id);
    const task = queue.getTask(id);
    expect(task!.status).toBe("completed");
  });

  test("updates updated_at timestamp", async () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();
    const beforeComplete = queue.getTask(id)!.updated_at;
    // Small delay to guarantee timestamp differs
    await Bun.sleep(2);
    queue.markCompleted(id);
    const afterComplete = queue.getTask(id)!.updated_at;
    expect(new Date(afterComplete).getTime()).toBeGreaterThan(
      new Date(beforeComplete).getTime()
    );
  });
});

// ─── markFailed with retry logic ────────────────────────────────────

describe("markFailed", () => {
  test("re-queues task on first failure", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();
    queue.markFailed(id, "LLM timeout");

    const task = queue.getTask(id);
    expect(task!.status).toBe("queued");
    expect(task!.retries).toBe(1);
    expect(task!.error_log).toBe("LLM timeout");
  });

  test("re-queues task on second failure", () => {
    const id = queue.enqueue({ content: "x" });

    // First attempt
    queue.dequeueAndLock();
    queue.markFailed(id, "error 1");

    // Second attempt
    queue.dequeueAndLock();
    queue.markFailed(id, "error 2");

    const task = queue.getTask(id);
    expect(task!.status).toBe("queued");
    expect(task!.retries).toBe(2);
  });

  test("permanently fails task after MAX_RETRIES attempts", () => {
    const id = queue.enqueue({ content: "x" });

    for (let i = 0; i < MAX_RETRIES; i++) {
      queue.dequeueAndLock();
      queue.markFailed(id, `error ${i + 1}`);
    }

    const task = queue.getTask(id);
    expect(task!.status).toBe("failed");
    expect(task!.retries).toBe(MAX_RETRIES);
    expect(task!.error_log).toBe(`error ${MAX_RETRIES}`);
  });

  test("failed task is not dequeued again", () => {
    const id = queue.enqueue({ content: "x" });

    for (let i = 0; i < MAX_RETRIES; i++) {
      queue.dequeueAndLock();
      queue.markFailed(id, `error ${i + 1}`);
    }

    const next = queue.dequeueAndLock();
    expect(next).toBeNull();
  });
});

// ─── cleanupOldTasks ────────────────────────────────────────────────

describe("cleanupOldTasks", () => {
  test("removes completed tasks older than specified days", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();
    queue.markCompleted(id);

    // Manually backdate the task's updated_at to 8 days ago
    const db = (queue as any).db;
    db.run(
      `UPDATE tasks SET updated_at = datetime('now', '-8 days') WHERE id = ?`,
      [id]
    );

    const removed = queue.cleanupOldTasks(7);
    expect(removed).toBe(1);
    expect(queue.getTask(id)).toBeNull();
  });

  test("removes failed tasks older than specified days", () => {
    const id = queue.enqueue({ content: "x" });

    for (let i = 0; i < MAX_RETRIES; i++) {
      queue.dequeueAndLock();
      queue.markFailed(id, "err");
    }

    const db = (queue as any).db;
    db.run(
      `UPDATE tasks SET updated_at = datetime('now', '-8 days') WHERE id = ?`,
      [id]
    );

    const removed = queue.cleanupOldTasks(7);
    expect(removed).toBe(1);
  });

  test("does not remove recent completed tasks", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();
    queue.markCompleted(id);

    const removed = queue.cleanupOldTasks(7);
    expect(removed).toBe(0);
    expect(queue.getTask(id)).not.toBeNull();
  });

  test("does not remove queued or processing tasks", () => {
    const queuedId = queue.enqueue({ content: "queued" });
    const processingId = queue.enqueue({ content: "processing" });
    queue.dequeueAndLock(); // locks processingId (first by FIFO but queuedId was first)

    const db = (queue as any).db;
    db.run(`UPDATE tasks SET updated_at = datetime('now', '-30 days')`);

    const removed = queue.cleanupOldTasks(7);
    expect(removed).toBe(0);
  });
});

// ─── recoverStaleTasks ──────────────────────────────────────────────

describe("recoverStaleTasks", () => {
  test("resets stale processing tasks back to queued", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();

    // Backdate to 15 minutes ago (past the 10-min threshold)
    const db = (queue as any).db;
    db.run(
      `UPDATE tasks SET updated_at = datetime('now', '-15 minutes') WHERE id = ?`,
      [id]
    );

    const recovered = queue.recoverStaleTasks();
    expect(recovered).toBe(1);

    const task = queue.getTask(id);
    expect(task!.status).toBe("queued");
  });

  test("does not reset recently processing tasks", () => {
    const id = queue.enqueue({ content: "x" });
    queue.dequeueAndLock();

    const recovered = queue.recoverStaleTasks();
    expect(recovered).toBe(0);

    const task = queue.getTask(id);
    expect(task!.status).toBe("processing");
  });

  test("does not affect queued or completed tasks", () => {
    const queuedId = queue.enqueue({ content: "queued" });
    const completedId = queue.enqueue({ content: "completed" });
    queue.dequeueAndLock(); // locks queuedId
    queue.markCompleted(queuedId);

    // Backdate everything
    const db = (queue as any).db;
    db.run(`UPDATE tasks SET updated_at = datetime('now', '-15 minutes')`);

    const recovered = queue.recoverStaleTasks();
    expect(recovered).toBe(0);
  });
});

// ─── getQueueLength ─────────────────────────────────────────────────

describe("getQueueLength", () => {
  test("returns 0 for empty queue", () => {
    expect(queue.getQueueLength()).toBe(0);
  });

  test("counts only queued tasks", () => {
    queue.enqueue({ content: "1" });
    queue.enqueue({ content: "2" });
    queue.enqueue({ content: "3" });
    queue.dequeueAndLock(); // one becomes processing

    expect(queue.getQueueLength()).toBe(2);
  });
});

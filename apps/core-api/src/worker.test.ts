import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { pollOnce, startWorker, type WorkerDeps } from "./worker";
import { QueueRepository } from "./queue";
import { ensureDataDirectories } from "./app";
import type { MemoryExtraction } from "@kore/shared-types";
import { renderMarkdown } from "./markdown";
import { join } from "node:path";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ─── Mock extract function ──────────────────────────────────────────

const MOCK_EXTRACTION: MemoryExtraction = {
  title: "Mutekiya Ramen in Ikebukuro",
  distilled_items: [
    "Mutekiya is a famous tonkotsu ramen shop in Ikebukuro, Tokyo",
    "Known for rich, creamy pork broth and thick noodles",
    "Often has a long queue, especially on weekends",
  ],
  qmd_category: "qmd://travel/food/japan",
  type: "place",
  tags: ["ramen", "tokyo", "ikebukuro"],
};

function mockExtract(_rawText: string, _source: string): Promise<MemoryExtraction> {
  return Promise.resolve(MOCK_EXTRACTION);
}

function failingExtract(_rawText: string, _source: string): Promise<MemoryExtraction> {
  return Promise.reject(new Error("LLM connection refused"));
}

// ─── Per-test isolation ─────────────────────────────────────────────

let tempDir: string;
let queue: QueueRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-worker-test-"));
  await ensureDataDirectories(tempDir);
  const dbPath = join(tempDir, "queue.db");
  queue = new QueueRepository(dbPath);
});

afterEach(async () => {
  queue.close();
  await rm(tempDir, { recursive: true, force: true });
});

function makeDeps(overrides?: Partial<WorkerDeps>): WorkerDeps {
  return {
    queue,
    dataPath: tempDir,
    extractFn: mockExtract,
    ...overrides,
  };
}

// ─── Unit Tests: Worker Logic ───────────────────────────────────────

describe("Worker: pollOnce", () => {
  test("returns false when queue is empty", async () => {
    const result = await pollOnce(makeDeps());
    expect(result).toBe(false);
  });

  test("processes a queued task and writes .md file", async () => {
    const payload = { source: "apple_notes", content: "Great ramen at Mutekiya" };
    const taskId = queue.enqueue(payload);

    const result = await pollOnce(makeDeps());
    expect(result).toBe(true);

    // Task should be marked completed
    const task = queue.getTask(taskId);
    expect(task?.status).toBe("completed");

    // File should exist in the correct type directory
    const files = await readdir(join(tempDir, "places"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^mutekiya_ramen_in_ikebukuro.*\.md$/);
  });

  test("generated .md file has correct canonical format", async () => {
    const payload = { source: "web_clipper", content: "Mutekiya ramen review text" };
    queue.enqueue(payload);

    await pollOnce(makeDeps());

    const files = await readdir(join(tempDir, "places"));
    const content = await readFile(join(tempDir, "places", files[0]), "utf-8");

    // Frontmatter fields
    expect(content).toContain("---");
    expect(content).toMatch(/id: [0-9a-f-]{36}/);
    expect(content).toContain("type: place");
    expect(content).toContain("category: qmd://travel/food/japan");
    expect(content).toContain("source: web_clipper");
    expect(content).toContain('tags: ["ramen", "tokyo", "ikebukuro"]');

    // Canonical sections
    expect(content).toContain("# Mutekiya Ramen in Ikebukuro");
    expect(content).toContain("## Distilled Memory Items");
    expect(content).toContain("- **Mutekiya is a famous tonkotsu ramen shop");
    expect(content).toContain("## Raw Source");
    expect(content).toContain("Mutekiya ramen review text");
  });

  test("includes original_url in frontmatter when provided", async () => {
    const payload = {
      source: "safari",
      content: "Some content",
      original_url: "https://example.com/article",
    };
    queue.enqueue(payload);

    await pollOnce(makeDeps());

    const files = await readdir(join(tempDir, "places"));
    const content = await readFile(join(tempDir, "places", files[0]), "utf-8");

    expect(content).toContain("url: https://example.com/article");
  });

  test("marks task as failed on extraction error", async () => {
    const payload = { source: "test", content: "Some text" };
    const taskId = queue.enqueue(payload);

    await pollOnce(makeDeps({ extractFn: failingExtract }));

    const task = queue.getTask(taskId);
    // First failure re-queues (retries < MAX_RETRIES)
    expect(task?.status).toBe("queued");
    expect(task?.retries).toBe(1);
    expect(task?.error_log).toContain("LLM connection refused");
  });

  test("task permanently fails after MAX_RETRIES extraction errors", async () => {
    const payload = { source: "test", content: "Some text" };
    const taskId = queue.enqueue(payload);
    const deps = makeDeps({ extractFn: failingExtract });

    // Attempt 3 times (MAX_RETRIES = 3)
    await pollOnce(deps); // retry 1 → re-queued
    await pollOnce(deps); // retry 2 → re-queued
    await pollOnce(deps); // retry 3 → permanently failed

    const task = queue.getTask(taskId);
    expect(task?.status).toBe("failed");
    expect(task?.retries).toBe(3);
  });

  test("validates extraction output against MemoryExtractionSchema", async () => {
    const invalidExtract = () =>
      Promise.resolve({
        title: "Test",
        distilled_items: [], // min 1 required — should fail validation
        qmd_category: "qmd://test",
        type: "note" as const,
        tags: ["valid"],
      });

    const payload = { source: "test", content: "Some text" };
    const taskId = queue.enqueue(payload);

    await pollOnce(makeDeps({ extractFn: invalidExtract }));

    const task = queue.getTask(taskId);
    expect(task?.status).toBe("queued"); // re-queued due to validation error
    expect(task?.retries).toBe(1);
  });

  test("handles file collision with hash suffix", async () => {
    const payload1 = { source: "src1", content: "First" };
    const payload2 = { source: "src2", content: "Second" };
    queue.enqueue(payload1);
    queue.enqueue(payload2);

    // Both extract to same title → second file should get hash suffix
    await pollOnce(makeDeps());
    await pollOnce(makeDeps());

    const files = await readdir(join(tempDir, "places"));
    const matchingFiles = files.filter((f) => f.startsWith("mutekiya_ramen"));
    expect(matchingFiles.length).toBe(2);
  });

  test("routes to correct type directory", async () => {
    const noteExtract = () =>
      Promise.resolve({
        ...MOCK_EXTRACTION,
        type: "note" as const,
        title: "Unique Note Title",
      });

    queue.enqueue({ source: "test", content: "Note text" });
    await pollOnce(makeDeps({ extractFn: noteExtract }));

    const noteFiles = await readdir(join(tempDir, "notes"));
    expect(noteFiles.some((f) => f.startsWith("unique_note_title"))).toBe(true);
  });
});

describe("Worker: startWorker", () => {
  test("recovers stale tasks on startup", () => {
    const taskId = queue.enqueue({ source: "test", content: "stale" });
    queue.dequeueAndLock();

    // Backdate updated_at to simulate staleness
    // @ts-ignore - accessing private db for test setup
    (queue as any).db.run(
      `UPDATE tasks SET updated_at = datetime('now', '-15 minutes') WHERE id = ?`,
      [taskId]
    );

    const handle = startWorker(makeDeps({ pollIntervalMs: 100_000 }));

    const recovered = queue.getTask(taskId);
    expect(recovered?.status).toBe("queued");

    handle.stop();
  });

  test("stop() halts polling", () => {
    const handle = startWorker(makeDeps({ pollIntervalMs: 50 }));
    handle.stop();
  });
});

// ─── E2E Integration Test ───────────────────────────────────────────

describe("E2E: POST /ingest/raw → worker → .md file", () => {
  test("ingested payload is processed by worker into a .md file", async () => {
    const { createApp } = await import("./app");

    const e2eDbPath = join(tempDir, "e2e.db");
    const e2eQueue = new QueueRepository(e2eDbPath);

    process.env.KORE_API_KEY = "e2e-key";
    const app = createApp({
      queue: e2eQueue,
      dataPath: tempDir,
    });

    // 1. Ingest via API
    const ingestRes = await app.handle(
      new Request("http://localhost/api/v1/ingest/raw", {
        method: "POST",
        headers: {
          Authorization: "Bearer e2e-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "reddit_bookmark",
          content: "I visited Mutekiya Ramen in Ikebukuro last week. The tonkotsu broth was incredible.",
          original_url: "https://reddit.com/r/ramen/post/123",
          priority: "high",
        }),
      })
    );

    expect(ingestRes.status).toBe(202);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.task_id).toBeDefined();

    // 2. Verify task is queued
    const task = e2eQueue.getTask(ingestBody.task_id);
    expect(task?.status).toBe("queued");
    expect(task?.priority).toBe("high");

    // 3. Run worker poll with mocked extractor
    await pollOnce({
      queue: e2eQueue,
      dataPath: tempDir,
      extractFn: mockExtract,
    });

    // 4. Verify task completed
    const completedTask = e2eQueue.getTask(ingestBody.task_id);
    expect(completedTask?.status).toBe("completed");

    // 5. Verify .md file on disk
    const files = await readdir(join(tempDir, "places"));
    const mdFile = files.find((f) => f.startsWith("mutekiya_ramen"))!;
    expect(mdFile).toBeDefined();

    const content = await readFile(join(tempDir, "places", mdFile), "utf-8");
    expect(content).toContain("type: place");
    expect(content).toContain("category: qmd://travel/food/japan");
    expect(content).toContain("source: reddit_bookmark");
    expect(content).toContain("url: https://reddit.com/r/ramen/post/123");
    expect(content).toContain("# Mutekiya Ramen in Ikebukuro");
    expect(content).toContain("## Distilled Memory Items");
    expect(content).toContain("## Raw Source");
    expect(content).toContain("I visited Mutekiya Ramen");

    // 6. Verify task status via API
    const statusRes = await app.handle(
      new Request(`http://localhost/api/v1/task/${ingestBody.task_id}`, {
        headers: { Authorization: "Bearer e2e-key" },
      })
    );
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe("completed");

    e2eQueue.close();
  });
});

// ─── Worker: intent/confidence handling ──────────────────────────

describe("Worker: intent and confidence", () => {
  test("defaults intent to 'reference' when absent from extraction result", async () => {
    const extractNoIntent = () =>
      Promise.resolve({ ...MOCK_EXTRACTION }); // no intent field

    const payload = { source: "test", content: "Some text" };
    queue.enqueue(payload);

    await pollOnce(makeDeps({ extractFn: extractNoIntent }));

    const files = await readdir(join(tempDir, "places"));
    const content = await readFile(join(tempDir, "places", files[0]), "utf-8");
    expect(content).toContain("intent: reference");
  });

  test("passes through intent and confidence to frontmatter when present", async () => {
    const extractWithIntentAndConfidence = () =>
      Promise.resolve({
        ...MOCK_EXTRACTION,
        intent: "recommendation" as const,
        confidence: 0.92,
      });

    const payload = { source: "test", content: "Some text" };
    queue.enqueue(payload);

    await pollOnce(makeDeps({ extractFn: extractWithIntentAndConfidence }));

    const files = await readdir(join(tempDir, "places"));
    const content = await readFile(join(tempDir, "places", files[0]), "utf-8");
    expect(content).toContain("intent: recommendation");
    expect(content).toContain("confidence: 0.92");
  });
});

// ─── renderMarkdown: intent/confidence ───────────────────────────

describe("renderMarkdown: intent and confidence", () => {
  const baseFrontmatter = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    type: "place" as const,
    category: "qmd://travel/food/japan",
    date_saved: "2026-03-07T12:00:00Z",
    source: "apple_notes",
    tags: ["ramen", "tokyo"],
  };

  test("includes intent and confidence lines when present", () => {
    const md = renderMarkdown({
      frontmatter: { ...baseFrontmatter, intent: "recommendation" as const, confidence: 0.95 },
      title: "Test",
    });
    expect(md).toContain("intent: recommendation");
    expect(md).toContain("confidence: 0.95");
  });

  test("omits intent and confidence lines when absent", () => {
    const md = renderMarkdown({
      frontmatter: baseFrontmatter,
      title: "Test",
    });
    expect(md).not.toContain("intent:");
    expect(md).not.toContain("confidence:");
  });
});

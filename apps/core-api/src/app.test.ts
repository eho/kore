import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createApp, ensureDataDirectories } from "./app";
import type { QmdHealthSummary } from "./app";
import type { HybridQueryResult, SearchOptions } from "@kore/qmd-client";
import { QueueRepository } from "./queue";
import { join } from "node:path";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

let tempDir: string;
let queue: QueueRepository;
let dbPath: string;

function makeApp(overrides?: {
  apiKey?: string;
  qmdStatus?: () => Promise<QmdHealthSummary>;
  searchFn?: (query: string, options?: SearchOptions) => Promise<HybridQueryResult[]>;
}) {
  process.env.KORE_API_KEY = overrides?.apiKey ?? "test-key";
  return createApp({
    queue,
    dataPath: tempDir,
    qmdStatus: overrides?.qmdStatus ?? (async () => ({ status: "ok" as const })),
    searchFn: overrides?.searchFn,
  });
}

function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      ...init,
    })
  );
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-test-"));
  await ensureDataDirectories(tempDir);
});

beforeEach(() => {
  dbPath = join(tempDir, `queue-${Date.now()}.db`);
  queue = new QueueRepository(dbPath);
});

afterEach(() => {
  queue.close();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Data directory setup ────────────────────────────────────────────

describe("ensureDataDirectories", () => {
  test("creates type subdirectories", async () => {
    const dirs = await readdir(tempDir);
    expect(dirs).toContain("places");
    expect(dirs).toContain("media");
    expect(dirs).toContain("notes");
    expect(dirs).toContain("people");
  });
});

// ─── Health endpoint ─────────────────────────────────────────────────

describe("GET /api/v1/health", () => {
  test("returns health status with qmd object and queue_length", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      version: "1.0.0",
      qmd: { status: "ok" },
      queue_length: 0,
    });
  });

  test("reflects qmd status unavailable", async () => {
    const app = makeApp({ qmdStatus: async () => ({ status: "unavailable" as const }) });
    const res = await app.handle(new Request("http://localhost/api/v1/health"));
    const body = await res.json();
    expect(body.qmd.status).toBe("unavailable");
  });

  test("reflects qmd bootstrapping status with flattened fields", async () => {
    const mockSummary = {
      status: "bootstrapping" as const,
      doc_count: 5,
      collections: 1,
      needs_embedding: 2,
    };
    const app = makeApp({
      qmdStatus: async () => mockSummary,
    });
    const res = await app.handle(new Request("http://localhost/api/v1/health"));
    const body = await res.json();
    expect(body.qmd).toEqual(mockSummary);
  });

  test("does not require auth", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(200);
  });
});

// ─── Authentication ──────────────────────────────────────────────────

describe("Bearer token auth", () => {
  test("rejects requests without valid token", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/ingest/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "test", content: "hello" }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("rejects requests with wrong token", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/ingest/raw", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "test", content: "hello" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/v1/ingest/raw ─────────────────────────────────────────

describe("POST /api/v1/ingest/raw", () => {
  test("accepts valid payload and returns 202 with task_id", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/raw", {
      method: "POST",
      body: JSON.stringify({
        source: "apple_notes",
        content: "Some raw text content",
        priority: "high",
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.task_id).toBeDefined();
    expect(body.message).toBe("Enrichment added to queue.");
  });

  test("defaults priority to normal", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/raw", {
      method: "POST",
      body: JSON.stringify({ source: "test", content: "hello" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    const task = queue.getTask(body.task_id);
    expect(task?.priority).toBe("normal");
  });

  test("rejects invalid payload", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/raw", {
      method: "POST",
      body: JSON.stringify({ source: "test" }), // missing content
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

// ─── GET /api/v1/task/:id ────────────────────────────────────────────

describe("GET /api/v1/task/:id", () => {
  test("returns task status for existing task", async () => {
    const app = makeApp();
    const taskId = queue.enqueue({ source: "test", content: "hello" });
    const res = await req(app, `/api/v1/task/${taskId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(taskId);
    expect(body.status).toBe("queued");
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("returns 404 for unknown task", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/task/nonexistent-id");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toBe("Task not found");
  });
});

// ─── POST /api/v1/ingest/structured ──────────────────────────────────

describe("POST /api/v1/ingest/structured", () => {
  test("creates a markdown file and returns 200 with file_path", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify({
        content: {
          title: "Test Note",
          markdown_body: "This is the body of my note.",
          frontmatter: {
            type: "note",
            category: "qmd://tech/programming",
            date_saved: "2026-03-07T12:00:00Z",
            source: "test_import",
            tags: ["testing"],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("indexed");
    expect(body.file_path).toContain("notes/test_note.md");

    // Verify the file was written correctly
    const fileContent = await readFile(body.file_path, "utf-8");
    expect(fileContent).toContain("---");
    expect(fileContent).toContain("type: note");
    expect(fileContent).toContain("category: qmd://tech/programming");
    expect(fileContent).toContain("# Test Note");
    expect(fileContent).toContain("## Raw Source");
    expect(fileContent).toContain("This is the body of my note.");
  });

  test("handles collision with hash suffix", async () => {
    const app = makeApp();
    const payload = {
      content: {
        title: "Collision Test",
        markdown_body: "First note.",
        frontmatter: {
          type: "note",
          category: "qmd://personal/goals",
          date_saved: "2026-03-07T12:00:00Z",
          source: "test",
          tags: ["test"],
        },
      },
    };

    const res1 = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body1 = await res1.json();

    const res2 = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body2 = await res2.json();

    expect(body1.file_path).not.toBe(body2.file_path);
    expect(body2.file_path).toMatch(/collision_test_[a-f0-9]{4}\.md$/);
  });

  test("routes files to correct type directory", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify({
        content: {
          title: "Mutekiya Ramen",
          markdown_body: "Great ramen.",
          frontmatter: {
            type: "place",
            category: "qmd://travel/food/japan",
            date_saved: "2026-03-07T12:00:00Z",
            source: "manual",
            tags: ["ramen"],
          },
        },
      }),
    });
    const body = await res.json();
    expect(body.file_path).toContain("places/mutekiya_ramen.md");
  });

  test("rejects invalid payload", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify({
        content: {
          title: "Missing frontmatter",
          markdown_body: "Body",
          // missing frontmatter
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("rejects frontmatter with invalid category", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/ingest/structured", {
      method: "POST",
      body: JSON.stringify({
        content: {
          title: "Bad Category",
          markdown_body: "Body",
          frontmatter: {
            type: "note",
            category: "invalid://not-qmd",
            date_saved: "2026-03-07T12:00:00Z",
            source: "test",
            tags: [],
          },
        },
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/v1/search ─────────────────────────────────────────────

describe("POST /api/v1/search", () => {
  const mockResults: HybridQueryResult[] = [
    {
      file: "/app/data/notes/meeting.md",
      displayPath: "qmd://memories/notes/meeting.md",
      title: "Team Meeting Notes",
      body: "Full body content...",
      bestChunk: "Discussed roadmap priorities for Q2",
      bestChunkPos: 0,
      score: 0.92,
      context: null,
      docid: "abc123",
    },
    {
      file: "/app/data/people/alice.md",
      displayPath: "qmd://memories/people/alice.md",
      title: "Alice Smith",
      body: "Contact details...",
      bestChunk: "Product manager at Acme Corp",
      bestChunkPos: 0,
      score: 0.78,
      context: null,
      docid: "def456",
    },
  ];

  test("returns mapped search results on success", async () => {
    const app = makeApp({
      searchFn: async () => mockResults,
    });
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "meeting notes" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: null,
        path: "/app/data/notes/meeting.md",
        title: "Team Meeting Notes",
        snippet: "Discussed roadmap priorities for Q2",
        score: 0.92,
        collection: "memories",
      },
      {
        id: null,
        path: "/app/data/people/alice.md",
        title: "Alice Smith",
        snippet: "Product manager at Acme Corp",
        score: 0.78,
        collection: "memories",
      },
    ]);
  });

  test("returns 400 when query is missing", async () => {
    const app = makeApp({
      searchFn: async () => [],
    });
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("returns 503 when store is not initialized (no searchFn)", async () => {
    const app = makeApp(); // no searchFn provided
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Search index not available");
  });

  test("returns 503 when searchFn throws", async () => {
    const app = makeApp({
      searchFn: async () => {
        throw new Error("Store not ready");
      },
    });
    const res = await req(app, "/api/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Search index not available");
  });

  test("requires bearer auth", async () => {
    const app = makeApp({
      searchFn: async () => [],
    });
    const res = await app.handle(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/v1/memories ─────────────────────────────────────────

describe("DELETE /api/v1/memories", () => {
  let originalKoreHome: string | undefined;

  beforeAll(async () => {
    originalKoreHome = process.env.KORE_HOME;
    process.env.KORE_HOME = tempDir; // Use tempDir for resolveQmdDbPath
    await require("node:fs/promises").mkdir(join(tempDir, "db"), { recursive: true });
  });

  afterAll(() => {
    if (originalKoreHome !== undefined) {
      process.env.KORE_HOME = originalKoreHome;
    } else {
      delete process.env.KORE_HOME;
    }
  });

  test("resets all memories, queue, and index", async () => {
    const app = makeApp();
    queue.enqueue({ content: "test task" });
    expect(queue.getQueueLength()).toBe(1);

    const res = await req(app, "/api/v1/memories", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    
    expect(body.status).toBe("reset");
    expect(body.deleted_tasks).toBe(1);
    
    expect(queue.getQueueLength()).toBe(0);
  });
});

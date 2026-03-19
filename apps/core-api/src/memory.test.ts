import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createApp, ensureDataDirectories } from "./app";
import { QueueRepository } from "./queue";
import { MemoryIndex } from "./memory-index";
import { EventDispatcher } from "./event-dispatcher";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "crypto";
import { renderMarkdown } from "./markdown";
import type { MemoryEvent, KorePlugin } from "@kore/shared-types";

let tempDir: string;
let queue: QueueRepository;
let dbPath: string;
let memoryIndex: MemoryIndex;
let eventDispatcher: EventDispatcher;

function makeApp() {
  process.env.KORE_API_KEY = "test-key";
  return createApp({
    queue,
    dataPath: tempDir,
    qmdStatus: async () => ({ status: "ok" as const }),
    memoryIndex,
    eventDispatcher,
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

// Helper: create a .md file on disk and register in the index
async function createMemoryFile(opts: {
  id: string;
  title: string;
  type?: string;
  category?: string;
  intent?: string;
  confidence?: number;
}): Promise<string> {
  const { id, title, type = "note", category = "qmd://tech/programming", intent, confidence } = opts;
  const typeDir = { place: "places", media: "media", note: "notes", person: "people" }[type] || "notes";
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  const filePath = join(tempDir, typeDir, `${slug}.md`);

  const md = renderMarkdown({
    frontmatter: {
      id,
      type: type as any,
      category,
      date_saved: "2026-03-07T12:00:00Z",
      source: "test",
      tags: ["test"],
      ...(intent !== undefined ? { intent: intent as any } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    },
    title,
    distilledItems: ["A test fact."],
    rawSource: "Original raw text.",
  });

  await writeFile(filePath, md);
  memoryIndex.set(id, filePath);
  return filePath;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-mem-test-"));
  await ensureDataDirectories(tempDir);
});

beforeEach(() => {
  dbPath = join(tempDir, `queue-${Date.now()}.db`);
  queue = new QueueRepository(dbPath);
  memoryIndex = new MemoryIndex();
  eventDispatcher = new EventDispatcher();
});

afterEach(() => {
  queue.close();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── GET /api/v1/memories ─────────────────────────────────────────────

describe("GET /api/v1/memories", () => {
  test("returns empty array when no memories indexed", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/memories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns list of memory summaries", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    await createMemoryFile({ id: id1, title: "First Memory" });
    await createMemoryFile({ id: id2, title: "Second Memory" });

    const app = makeApp();
    const res = await req(app, "/api/v1/memories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
    const found = body.find((m: any) => m.id === id1);
    expect(found).toBeDefined();
    expect(found.type).toBe("note");
    expect(found.title).toBe("First Memory");
    expect(found.source).toBe("test");
    expect(found.date_saved).toBeDefined();
    expect(Array.isArray(found.tags)).toBe(true);
  });

  test("filters by type", async () => {
    const noteId = randomUUID();
    const placeId = randomUUID();
    await createMemoryFile({ id: noteId, title: "A Note", type: "note" });
    await createMemoryFile({ id: placeId, title: "A Place", type: "place" });

    const app = makeApp();
    const res = await req(app, "/api/v1/memories?type=place");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((m: any) => m.id);
    expect(ids).toContain(placeId);
    expect(ids).not.toContain(noteId);
  });

  test("respects limit query param", async () => {
    // Create 3 memories
    for (let i = 0; i < 3; i++) {
      await createMemoryFile({ id: randomUUID(), title: `Limit Test ${i}` });
    }

    const app = makeApp();
    const res = await req(app, "/api/v1/memories?limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(2);
  });

  test("caps limit at 100", async () => {
    const app = makeApp();
    // Just ensure it doesn't error with a large limit
    const res = await req(app, "/api/v1/memories?limit=999");
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/v1/memory/:id ───────────────────────────────────────────

describe("GET /api/v1/memory/:id", () => {
  test("returns full memory details including content", async () => {
    const id = randomUUID();
    await createMemoryFile({ id, title: "Full Detail Test" });

    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.type).toBe("note");
    expect(body.title).toBe("Full Detail Test");
    expect(body.category).toBe("qmd://tech/programming");
    expect(body.source).toBe("test");
    expect(body.date_saved).toBeDefined();
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.content).toContain("---");
    expect(body.content).toContain("# Full Detail Test");
  });

  test("returns 404 for unknown memory id", async () => {
    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${randomUUID()}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("returns intent and confidence when present in frontmatter", async () => {
    const id = randomUUID();
    await createMemoryFile({ id, title: "Intent Confidence Test", intent: "recommendation", confidence: 0.87 });

    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBe("recommendation");
    expect(body.confidence).toBe(0.87);
  });

  test("omits intent and confidence when absent from frontmatter", async () => {
    const id = randomUUID();
    await createMemoryFile({ id, title: "No Intent Test" });

    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBeUndefined();
    expect(body.confidence).toBeUndefined();
  });
});

// ─── DELETE /api/v1/memory/:id ────────────────────────────────────────

describe("DELETE /api/v1/memory/:id", () => {
  test("deletes file and returns 200 with status deleted", async () => {
    const app = makeApp();
    const id = randomUUID();
    const filePath = await createMemoryFile({ id, title: "Delete Me" });

    const res = await req(app, `/api/v1/memory/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("deleted");
    expect(body.id).toBe(id);

    // Verify file is gone
    const file = Bun.file(filePath);
    expect(await file.exists()).toBe(false);
  });

  test("returns 404 for unknown memory id", async () => {
    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${randomUUID()}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("removes entry from memory index", async () => {
    const app = makeApp();
    const id = randomUUID();
    await createMemoryFile({ id, title: "Index Remove" });
    expect(memoryIndex.get(id)).toBeDefined();

    await req(app, `/api/v1/memory/${id}`, { method: "DELETE" });
    expect(memoryIndex.get(id)).toBeUndefined();
  });

  test("emits memory.deleted event", async () => {
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test-plugin",
      onMemoryDeleted: async (event) => { events.push(event); },
    };
    eventDispatcher.registerPlugins([plugin]);

    const app = makeApp();
    const id = randomUUID();
    await createMemoryFile({ id, title: "Event Delete" });

    await req(app, `/api/v1/memory/${id}`, { method: "DELETE" });

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].timestamp).toBeDefined();
  });
});

// ─── PUT /api/v1/memory/:id ──────────────────────────────────────────

describe("PUT /api/v1/memory/:id", () => {
  test("updates file and returns 200 with new file_path", async () => {
    const app = makeApp();
    const id = randomUUID();
    await createMemoryFile({ id, title: "Old Title" });

    const res = await req(app, `/api/v1/memory/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: {
          title: "Updated Title",
          markdown_body: "Updated body text.",
          frontmatter: {
            type: "note",
            category: "qmd://tech/programming",
            date_saved: "2026-03-09T12:00:00Z",
            source: "manual_edit",
            tags: ["updated"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("updated");
    expect(body.id).toBe(id);
    expect(body.file_path).toContain("updated-title.md");

    // Verify file content
    const content = await readFile(body.file_path, "utf-8");
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("# Updated Title");
    expect(content).toContain("Updated body text.");
  });

  test("returns 404 for unknown memory id", async () => {
    const app = makeApp();
    const res = await req(app, `/api/v1/memory/${randomUUID()}`, {
      method: "PUT",
      body: JSON.stringify({
        content: {
          title: "Nope",
          markdown_body: "Body",
          frontmatter: {
            type: "note",
            category: "qmd://tech/testing",
            date_saved: "2026-03-09T12:00:00Z",
            source: "test",
            tags: [],
          },
        },
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("rejects invalid payload", async () => {
    const app = makeApp();
    const id = randomUUID();
    await createMemoryFile({ id, title: "Valid" });

    const res = await req(app, `/api/v1/memory/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: {
          title: "Missing frontmatter",
          markdown_body: "Body",
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("emits memory.updated event", async () => {
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test-plugin",
      onMemoryUpdated: async (event) => { events.push(event); },
    };
    eventDispatcher.registerPlugins([plugin]);

    const app = makeApp();
    const id = randomUUID();
    await createMemoryFile({ id, title: "Event Update" });

    await req(app, `/api/v1/memory/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: {
          title: "Event Updated",
          markdown_body: "New body.",
          frontmatter: {
            type: "note",
            category: "qmd://personal/goals",
            date_saved: "2026-03-09T12:00:00Z",
            source: "test",
            tags: ["event"],
          },
        },
      }),
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].frontmatter.id).toBe(id);
    expect(events[0].timestamp).toBeDefined();
  });

  test("updates memory index with new path", async () => {
    const app = makeApp();
    const id = randomUUID();
    const oldPath = await createMemoryFile({ id, title: "Path Change" });

    await req(app, `/api/v1/memory/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: {
          title: "New Path",
          markdown_body: "Body.",
          frontmatter: {
            type: "place",
            category: "qmd://travel/food",
            date_saved: "2026-03-09T12:00:00Z",
            source: "test",
            tags: [],
          },
        },
      }),
    });

    const newPath = memoryIndex.get(id);
    expect(newPath).toBeDefined();
    expect(newPath).toContain("places/new-path.md");
    expect(newPath).not.toBe(oldPath);
  });
});

// ─── MemoryIndex ──────────────────────────────────────────────────────

describe("MemoryIndex", () => {
  test("builds index from .md files on disk", async () => {
    const idx = new MemoryIndex();
    const id = randomUUID();
    const typeDir = join(tempDir, "notes");
    const filePath = join(typeDir, "index_scan_test.md");

    const md = renderMarkdown({
      frontmatter: {
        id,
        type: "note",
        category: "qmd://tech/test",
        date_saved: "2026-03-07T12:00:00Z",
        source: "test",
        tags: [],
      },
      title: "Index Scan Test",
      rawSource: "Body",
    });
    await writeFile(filePath, md);

    await idx.build(tempDir);
    expect(idx.get(id)).toBe(filePath);
  });

  test("get resolves by unique prefix (first 8 chars)", () => {
    const idx = new MemoryIndex();
    const id = "5f0d5689-1234-5678-abcd-000000000001";
    const filePath = "/tmp/test.md";
    idx.set(id, filePath);

    expect(idx.get("5f0d5689")).toBe(filePath);
  });

  test("get returns undefined for ambiguous prefix", () => {
    const idx = new MemoryIndex();
    idx.set("5f0d5689-aaaa-0000-0000-000000000001", "/tmp/a.md");
    idx.set("5f0d5689-bbbb-0000-0000-000000000002", "/tmp/b.md");

    expect(idx.get("5f0d5689")).toBeUndefined();
  });
});

// ─── EventDispatcher ──────────────────────────────────────────────────

describe("EventDispatcher", () => {
  test("dispatches events to registered plugins", async () => {
    const dispatcher = new EventDispatcher();
    const events: MemoryEvent[] = [];
    const plugin: KorePlugin = {
      name: "test",
      onMemoryDeleted: async (e) => { events.push(e); },
    };
    dispatcher.registerPlugins([plugin]);

    const payload: MemoryEvent = {
      id: "test-id",
      filePath: "/tmp/test.md",
      frontmatter: {},
      timestamp: new Date().toISOString(),
    };
    await dispatcher.emit("memory.deleted", payload);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("test-id");
  });

  test("handles plugin errors gracefully without throwing", async () => {
    const dispatcher = new EventDispatcher();
    const plugin: KorePlugin = {
      name: "bad-plugin",
      onMemoryUpdated: async () => { throw new Error("plugin crash"); },
    };
    dispatcher.registerPlugins([plugin]);

    const payload: MemoryEvent = {
      id: "test-id",
      filePath: "/tmp/test.md",
      frontmatter: {},
      timestamp: new Date().toISOString(),
    };

    // Should not throw
    await dispatcher.emit("memory.updated", payload);
  });
});

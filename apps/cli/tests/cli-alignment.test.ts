import { test, expect, describe, afterAll } from "bun:test";
import { serve } from "bun";

const CLI = `${import.meta.dir}/../src/index.ts`;

function runCliWithPort(port: number, ...args: string[]) {
  return Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      KORE_API_URL: `http://127.0.0.1:${port}`,
      KORE_API_KEY: "test-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ─── Search (recall) Command ─────────────────────────────────────────────────

describe("search command (recall operation)", () => {
  const recallResponse = {
    results: [
      {
        id: "mem-001",
        title: "Tokyo Ramen",
        type: "place",
        category: "food",
        tags: ["japan", "food"],
        date_saved: "2026-03-10T00:00:00Z",
        source: "manual",
        distilled_items: ["Famous ramen shop in Shinjuku", "Rich tonkotsu broth"],
        score: 0.95,
      },
      {
        id: "mem-002",
        title: "Japan Travel Notes",
        type: "note",
        category: "travel",
        tags: ["japan"],
        date_saved: "2026-03-09T00:00:00Z",
        source: "apple_notes",
        distilled_items: [],
        score: 0.82,
      },
    ],
    query: "ramen",
    total: 2,
    offset: 0,
    has_more: false,
  };

  const recallServer = serve({
    port: 18900,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/recall" && req.method === "POST") {
        return (async () => {
          const body = (await req.json()) as Record<string, unknown>;
          // If type filter applied, filter results
          if (body.type === "place") {
            return new Response(JSON.stringify({
              ...recallResponse,
              results: recallResponse.results.filter(r => r.type === "place"),
              total: 1,
            }), { headers: { "Content-Type": "application/json" } });
          }
          if (body.query === "empty") {
            return new Response(JSON.stringify({
              results: [], query: "empty", total: 0, offset: 0, has_more: false,
            }), { headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify(recallResponse), {
            headers: { "Content-Type": "application/json" },
          });
        })();
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => recallServer.stop());

  test("search --json outputs RecallOutput schema", async () => {
    const proc = runCliWithPort(18900, "search", "ramen", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.query).toBe("ramen");
    expect(data.total).toBe(2);
    expect(data.offset).toBe(0);
    expect(data.has_more).toBe(false);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].id).toBe("mem-001");
    expect(data.results[0].distilled_items).toHaveLength(2);
    expect(data.results[0].type).toBe("place");
    expect(data.results[0].score).toBe(0.95);
  });

  test("search with --type filter", async () => {
    const proc = runCliWithPort(18900, "search", "ramen", "--type", "place", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].type).toBe("place");
  });

  test("search formatted output shows titles and scores", async () => {
    const proc = runCliWithPort(18900, "search", "ramen");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Tokyo Ramen");
    expect(out).toContain("[place]");
    expect(out).toContain("score: 0.950");
    expect(out).toContain("Famous ramen shop");
  });

  test("search empty results", async () => {
    const proc = runCliWithPort(18900, "search", "empty");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("No results found");
  });

  test("search --json error outputs JSON to stderr", async () => {
    const proc = runCliWithPort(19000, "search", "ramen", "--json");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    const data = JSON.parse(stderr);
    expect(data.error).toBeDefined();
  });
});

// ─── Show (inspect) Command ──────────────────────────────────────────────────

describe("show command (inspect operation)", () => {
  const inspectOutput = {
    id: "mem-001",
    title: "Tokyo Ramen",
    type: "place",
    category: "food",
    tags: ["japan", "food"],
    date_saved: "2026-03-10T00:00:00Z",
    source: "manual",
    distilled_items: ["Famous ramen shop", "Rich broth"],
    content: "---\nid: mem-001\ntype: place\n---\n\n# Tokyo Ramen\n\nBody text here.\n",
    url: "https://example.com",
  };

  const inspectServer = serve({
    port: 18901,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/inspect/mem-001") {
        return new Response(JSON.stringify(inspectOutput), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/v1/inspect/")) {
        return new Response(JSON.stringify({ error: "Memory not found", code: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => inspectServer.stop());

  test("show --json outputs InspectOutput schema", async () => {
    const proc = runCliWithPort(18901, "show", "mem-001", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.id).toBe("mem-001");
    expect(data.title).toBe("Tokyo Ramen");
    expect(data.type).toBe("place");
    expect(data.distilled_items).toHaveLength(2);
    expect(data.content).toContain("# Tokyo Ramen");
    expect(data.url).toBe("https://example.com");
  });

  test("show human-readable outputs content", async () => {
    const proc = runCliWithPort(18901, "show", "mem-001");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("# Tokyo Ramen");
    expect(out).toContain("Body text here.");
  });

  test("show not found exits 1", async () => {
    const proc = runCliWithPort(18901, "show", "nonexistent");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Memory nonexistent not found");
  });

  test("show --json not found outputs JSON to stderr", async () => {
    const proc = runCliWithPort(18901, "show", "nonexistent", "--json");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    const data = JSON.parse(stderr);
    expect(data.error).toBeDefined();
  });
});

// ─── Ingest (remember) Command ───────────────────────────────────────────────

describe("ingest command (remember operation)", () => {
  const rememberServer = serve({
    port: 18902,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/remember" && req.method === "POST") {
        return new Response(JSON.stringify({
          task_id: "task-new-001",
          status: "queued",
          message: "Memory queued for extraction.",
        }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/v1/task/")) {
        return new Response(JSON.stringify({
          id: "task-new-001",
          status: "completed",
          source: "stdin",
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => rememberServer.stop());

  test("ingest --no-wait --json outputs JSON", async () => {
    const proc = Bun.spawn(["bun", CLI, "ingest", "--no-wait", "--json"], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:18902`,
        KORE_API_KEY: "test-key",
      },
      stdin: new TextEncoder().encode("Some text content"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.task_id).toBe("task-new-001");
    expect(data.status).toBe("queued");
  });

  test("ingest --no-wait mentions kore task instead of kore status", async () => {
    const proc = Bun.spawn(["bun", CLI, "ingest", "--no-wait"], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:18902`,
        KORE_API_KEY: "test-key",
      },
      stdin: new TextEncoder().encode("Content"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("kore task");
    expect(out).not.toContain("kore status");
  });
});

// ─── Health Command ──────────────────────────────────────────────────────────

describe("health command (health operation)", () => {
  const healthResponse = {
    version: "1.2.0",
    memories: {
      total: 42,
      by_type: { note: 20, place: 15, person: 5, insight: 2 },
    },
    queue: { pending: 3, processing: 1, failed: 0 },
    index: { documents: 42, embedded: 40, status: "ok" },
    sync: {
      apple_notes: { enabled: true, last_sync_at: "2026-03-10T00:00:00Z", total_tracked: 10 },
    },
  };

  const healthServer = serve({
    port: 18903,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/health") {
        return new Response(JSON.stringify(healthResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => healthServer.stop());

  test("health --json outputs HealthOutput schema", async () => {
    const proc = runCliWithPort(18903, "health", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.version).toBe("1.2.0");
    expect(data.memories.total).toBe(42);
    expect(data.memories.by_type.note).toBe(20);
    expect(data.queue.pending).toBe(3);
    expect(data.index.status).toBe("ok");
    expect(data.sync.apple_notes.enabled).toBe(true);
  });

  test("health human-readable shows memory counts, queue, index, and sync", async () => {
    const proc = runCliWithPort(18903, "health");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Version:");
    expect(out).toContain("1.2.0");
    expect(out).toContain("Memories");
    expect(out).toContain("Total:      42");
    expect(out).toContain("note: 20");
    expect(out).toContain("Queue");
    expect(out).toContain("Pending:    3");
    expect(out).toContain("Index");
    expect(out).toContain("Documents:  42");
    expect(out).toContain("Sync");
    expect(out).toContain("Apple Notes:");
  });

  test("health --json error outputs JSON to stderr", async () => {
    const proc = runCliWithPort(19000, "health", "--json");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    const data = JSON.parse(stderr);
    expect(data.error).toBeDefined();
  });
});

// ─── Insights Command ────────────────────────────────────────────────────────

describe("insights command", () => {
  const insightsResponse = {
    results: [
      {
        id: "ins-001",
        title: "Food Preference Evolution",
        insight_type: "evolution",
        confidence: 0.85,
        status: "active",
        source_ids: ["mem-001", "mem-002", "mem-003"],
        source_count: 3,
        synthesis: "User's food preferences have evolved from casual dining to artisanal ramen.",
        distilled_items: ["Prefers rich broth", "Visits ramen shops weekly"],
        tags: ["food", "japan"],
        date_saved: "2026-03-10T00:00:00Z",
        reinforcement_count: 2,
      },
    ],
    total: 1,
  };

  const insightsServer = serve({
    port: 18904,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/insights") {
        return new Response(JSON.stringify(insightsResponse), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => insightsServer.stop());

  test("insights --json outputs InsightsOutput schema", async () => {
    const proc = runCliWithPort(18904, "insights", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.total).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("ins-001");
    expect(data.results[0].insight_type).toBe("evolution");
    expect(data.results[0].confidence).toBe(0.85);
    expect(data.results[0].source_count).toBe(3);
    expect(data.results[0].synthesis).toContain("artisanal ramen");
  });

  test("insights human-readable shows insight details", async () => {
    const proc = runCliWithPort(18904, "insights");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Food Preference Evolution");
    expect(out).toContain("[evolution]");
    expect(out).toContain("confidence: 0.85");
    expect(out).toContain("Sources: 3");
    expect(out).toContain("Reinforced: 2x");
    expect(out).toContain("artisanal ramen");
  });

  test("insights with query sends query parameter", async () => {
    const proc = runCliWithPort(18904, "insights", "food", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.results).toHaveLength(1);
  });

  test("insights --json error outputs JSON to stderr", async () => {
    const proc = runCliWithPort(19000, "insights", "--json");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    const data = JSON.parse(stderr);
    expect(data.error).toBeDefined();
  });
});

// ─── Consolidate Command ─────────────────────────────────────────────────────

describe("consolidate command (consolidate operation)", () => {
  const consolidateServer = serve({
    port: 18905,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/consolidate/op" && req.method === "POST") {
        return (async () => {
          const body = (await req.json()) as { dry_run?: boolean };
          if (body.dry_run) {
            return new Response(JSON.stringify({
              status: "dry_run",
              seed: { id: "mem-001", title: "Tokyo Ramen" },
              candidates: [
                { id: "mem-002", title: "Japan Travel", score: 0.85 },
                { id: "mem-003", title: "Ramen Notes", score: 0.80 },
              ],
              proposed_insight_type: "evolution",
              estimated_confidence: 0.82,
              candidate_count: 2,
            }), { headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({
            status: "consolidated",
            seed: { id: "mem-001", title: "Tokyo Ramen" },
            insight_id: "ins-new-001",
            cluster_size: 3,
          }), { headers: { "Content-Type": "application/json" } });
        })();
      }
      if (url.pathname === "/api/v1/consolidate" && req.method === "POST") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => consolidateServer.stop());

  test("consolidate --json outputs ConsolidateOutput schema", async () => {
    const proc = runCliWithPort(18905, "consolidate", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.status).toBe("consolidated");
    expect(data.seed.id).toBe("mem-001");
    expect(data.insight_id).toBe("ins-new-001");
    expect(data.cluster_size).toBe(3);
  });

  test("consolidate --dry-run --json outputs dry run schema", async () => {
    const proc = runCliWithPort(18905, "consolidate", "--dry-run", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.status).toBe("dry_run");
    expect(data.seed.title).toBe("Tokyo Ramen");
    expect(data.candidates).toHaveLength(2);
    expect(data.proposed_insight_type).toBe("evolution");
    expect(data.estimated_confidence).toBe(0.82);
  });

  test("consolidate human-readable shows result", async () => {
    const proc = runCliWithPort(18905, "consolidate");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Consolidation complete!");
    expect(out).toContain("Tokyo Ramen");
    expect(out).toContain("ins-new-001");
  });
});

// ─── Task Command (renamed from status) ──────────────────────────────────────

describe("task command (renamed from status)", () => {
  const taskServer = serve({
    port: 18906,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/task/task-found-123") {
        return new Response(JSON.stringify({
          id: "task-found-123",
          status: "completed",
          source: "test.md",
          created_at: "2026-03-10T00:00:00Z",
          updated_at: "2026-03-10T00:00:01Z",
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.startsWith("/api/v1/task/")) {
        return new Response(JSON.stringify({ error: "Task not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => taskServer.stop());

  test("task command exists and replaces status", async () => {
    const proc = runCliWithPort(18906, "task", "task-found-123");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("task-found-123");
    expect(out).toContain("completed");
  });

  test("task --json outputs JSON", async () => {
    const proc = runCliWithPort(18906, "task", "task-found-123", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.id).toBe("task-found-123");
    expect(data.status).toBe("completed");
  });

  test("task not found exits 1", async () => {
    const proc = runCliWithPort(18906, "task", "nonexistent");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("status command no longer exists", async () => {
    const proc = runCliWithPort(18906, "status", "task-found-123");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});

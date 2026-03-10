import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { spawnSync, serve } from "bun";
import { join } from "path";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";

const CLI = `${import.meta.dir}/../src/index.ts`;

function runCli(...args: string[]) {
  return spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      KORE_API_URL: "http://localhost:3000",
      KORE_API_KEY: "test-key",
    },
  });
}

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

function runCliWithPortSync(port: number, ...args: string[]) {
  return spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      KORE_API_URL: `http://127.0.0.1:${port}`,
      KORE_API_KEY: "test-key",
    },
  });
}

function runCliNoKey(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "KORE_API_KEY") env[k] = v;
  }
  env.KORE_API_URL = "http://localhost:3000";
  return spawnSync(["bun", CLI, ...args], { env });
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

describe("argument parsing", () => {
  test("no args prints usage and exits 0", () => {
    const result = runCli();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
  });

  test("--help prints usage and exits 0", () => {
    const result = runCli("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
    expect(result.stdout.toString()).toContain("health");
    expect(result.stdout.toString()).toContain("config");
  });

  test("--version prints version and exits 0", () => {
    const result = runCli("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/\d+\.\d+\.\d+/);
  });

  test("unknown command prints error and exits 1", () => {
    const result = runCli("notacommand");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown command");
    expect(result.stdout.toString()).toContain("Usage:");
  });
});

// ─── Config Command ──────────────────────────────────────────────────────────

describe("config command", () => {
  test("prints KORE_API_URL and masked key", () => {
    const result = spawnSync(["bun", CLI, "config"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://api.example.com",
        KORE_API_KEY: "kore_abc123xyz",
      },
    });
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(out).toContain("http://api.example.com");
    expect(out).toContain("***");
    // Should not print the full key
    expect(out).not.toContain("kore_abc123xyz");
  });

  test("--json outputs valid JSON with KORE_API_KEY_SET flag", () => {
    const result = spawnSync(["bun", CLI, "config", "--json"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://localhost:3000",
        KORE_API_KEY: "some-key",
      },
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.toString());
    expect(data.KORE_API_URL).toBe("http://localhost:3000");
    expect(data.KORE_API_KEY_SET).toBe(true);
    expect(data.KORE_API_KEY_MASKED).toContain("***");
  });
});

// ─── Key Masking ─────────────────────────────────────────────────────────────

describe("maskApiKey", () => {
  test("masks a normal key", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("kore_abc123xyz")).toBe("kore_***...***xyz");
  });

  test("returns (not set) for empty string", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("")).toBe("(not set)");
  });

  test("returns *** for very short keys", async () => {
    const { maskApiKey } = await import("../src/utils/env.ts");
    expect(maskApiKey("abc")).toBe("***");
  });
});

// ─── Health Command ──────────────────────────────────────────────────────────

describe("health command", () => {
  const server = serve({
    port: 19998,
    fetch(req) {
      if (req.url.endsWith("/api/v1/health")) {
        return new Response(JSON.stringify({
          status: "ok",
          version: "1.0",
          qmd_status: "ok",
          queue_length: 5
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }
  });

  afterAll(() => {
    server.stop();
  });

  test("prints successful health status", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:${server.port}`,
        KORE_API_KEY: "test-key",
      },
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("API Status:");
    expect(out).toContain("ok");
    expect(out).toContain("Queue Length: 5");
  });

  test("prints error and exits 1 when API is unreachable", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://127.0.0.1:19999",
        KORE_API_KEY: "test-key",
      },
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    const out = await new Response(proc.stderr).text();
    expect(out).toContain("Cannot reach Kore API");
  });

  test("warns when KORE_API_KEY is not set", async () => {
    const proc = Bun.spawn(["bun", CLI, "health"], {
      env: {
        ...process.env,
        KORE_API_URL: "http://127.0.0.1:19999",
        KORE_API_KEY: "",
      },
      stderr: "pipe",
    });
    await proc.exited;
    const out = await new Response(proc.stderr).text();
    expect(out).toContain("KORE_API_KEY not set");
  });
});

// ─── Ingest Command ─────────────────────────────────────────────────────────

describe("ingest command", () => {
  let tmpDir: string;
  let taskPollCount: number;

  const ingestServer = serve({
    port: 19996,
    fetch(req) {
      const url = new URL(req.url);

      // POST /api/v1/ingest/raw → return task_id
      if (url.pathname === "/api/v1/ingest/raw" && req.method === "POST") {
        return new Response(
          JSON.stringify({ task_id: "task-abc-123" }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      // GET /api/v1/task/:id → return completed on second poll
      if (url.pathname.startsWith("/api/v1/task/")) {
        taskPollCount++;
        const status = taskPollCount >= 2 ? "completed" : "processing";
        return new Response(
          JSON.stringify({
            id: "task-abc-123",
            status,
            source: "test.md",
            created_at: "2026-03-10T00:00:00Z",
            updated_at: "2026-03-10T00:00:01Z",
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  // Server for task failure scenario
  const failServer = serve({
    port: 19995,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/ingest/raw" && req.method === "POST") {
        return new Response(
          JSON.stringify({ task_id: "task-fail-456" }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.startsWith("/api/v1/task/")) {
        return new Response(
          JSON.stringify({
            id: "task-fail-456",
            status: "failed",
            error_log: "LLM extraction failed",
            created_at: "2026-03-10T00:00:00Z",
            updated_at: "2026-03-10T00:00:01Z",
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  beforeEach(async () => {
    taskPollCount = 0;
    tmpDir = await mkdtemp(join(tmpdir(), "kore-test-"));
  });

  afterAll(async () => {
    ingestServer.stop();
    failServer.stop();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test("single file ingest with --no-wait prints queued message", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "Hello world");

    const proc = runCliWithPort(19996, "ingest", filePath, "--no-wait");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Queued task task-abc-123");
    expect(out).toContain("kore status task-abc-123");
  });

  test("single file ingest with --no-wait --json outputs JSON", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "Hello world");

    const proc = runCliWithPort(19996, "ingest", filePath, "--no-wait", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.task_id).toBe("task-abc-123");
    expect(data.source).toBe(filePath);
  });

  test("stdin ingest with --no-wait reads piped input", async () => {
    const proc = Bun.spawn(["bun", CLI, "ingest", "--no-wait"], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:19996`,
        KORE_API_KEY: "test-key",
      },
      stdin: new TextEncoder().encode("piped text content"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Queued task task-abc-123");
    expect(out).toContain('source: "stdin"');
  });

  test("file not found prints error and continues", async () => {
    const goodFile = join(tmpDir, "good.md");
    await writeFile(goodFile, "Good content");
    const badFile = join(tmpDir, "nonexistent.md");

    const proc = runCliWithPort(19996, "ingest", badFile, goodFile, "--no-wait");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("File not found");
    expect(stderr).toContain("1 failed");
    expect(stdout).toContain("Queued task");
  });

  test("multi-file summary shows success count", async () => {
    const file1 = join(tmpDir, "a.md");
    const file2 = join(tmpDir, "b.md");
    await writeFile(file1, "Content A");
    await writeFile(file2, "Content B");

    const proc = runCliWithPort(19996, "ingest", file1, file2, "--no-wait");
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("2/2 files ingested successfully");
  });

  test("task failure exits with code 1", async () => {
    const filePath = join(tmpDir, "fail.md");
    await writeFile(filePath, "Will fail");

    const proc = runCliWithPort(19995, "ingest", filePath);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("LLM extraction failed");
  });

  test("single file ingest with polling (wait mode) succeeds", async () => {
    const filePath = join(tmpDir, "wait-test.md");
    await writeFile(filePath, "Wait for me");

    // ingestServer returns completed on the second poll
    const proc = runCliWithPort(19996, "ingest", filePath);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("task-abc-123 completed");
  });

  test("ingest with --source overrides source label", async () => {
    const filePath = join(tmpDir, "article.md");
    await writeFile(filePath, "Article content");

    const proc = runCliWithPort(19996, "ingest", filePath, "--no-wait", "--source", "Hacker News");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain('source: "Hacker News"');
  });

  test("API connection failure prints error", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "Content");

    const proc = runCliWithPort(19994, "ingest", filePath, "--no-wait");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot reach Kore API");
  });
});

// ─── Status Command ─────────────────────────────────────────────────────────

describe("status command", () => {
  const statusServer = serve({
    port: 19993,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/task/task-found-123") {
        return new Response(
          JSON.stringify({
            id: "task-found-123",
            status: "completed",
            source: "test.md",
            created_at: "2026-03-10T00:00:00Z",
            updated_at: "2026-03-10T00:00:01Z",
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/api/v1/task/task-not-found") {
        return new Response("Not found", { status: 404 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => {
    statusServer.stop();
  });

  test("prints task status in human-readable format", async () => {
    const proc = runCliWithPort(19993, "status", "task-found-123");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("task-found-123");
    expect(out).toContain("completed");
    expect(out).toContain("test.md");
  });

  test("--json outputs raw JSON task object", async () => {
    const proc = runCliWithPort(19993, "status", "task-found-123", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.id).toBe("task-found-123");
    expect(data.status).toBe("completed");
  });

  test("404 prints not found error and exits 1", async () => {
    const proc = runCliWithPort(19993, "status", "task-not-found");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Task task-not-found not found");
  });

  test("API connection failure prints error", async () => {
    const proc = runCliWithPort(19994, "status", "some-task");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot reach Kore API");
  });
});

// ─── List Command ─────────────────────────────────────────────────────────────

describe("list command", () => {
  const memories = [
    {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      type: "note",
      title: "First Note",
      source: "apple_notes",
      date_saved: "2026-03-07T12:00:00Z",
      tags: ["test"],
    },
    {
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      type: "place",
      title: "Tokyo Ramen",
      source: "manual",
      date_saved: "2026-03-08T12:00:00Z",
      tags: ["food", "japan"],
    },
  ];

  const listServer = serve({
    port: 19992,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/memories") {
        const type = url.searchParams.get("type");
        const limit = Number(url.searchParams.get("limit") || "20");
        let results = type ? memories.filter((m) => m.type === type) : memories;
        results = results.slice(0, limit);
        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => {
    listServer.stop();
  });

  test("prints table of memories", async () => {
    const proc = runCliWithPort(19992, "list");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("First Note");
    expect(out).toContain("Tokyo Ramen");
    expect(out).toContain("apple_notes");
    // ID should be first 8 chars
    expect(out).toContain("aaaaaaaa");
  });

  test("--json outputs raw array", async () => {
    const proc = runCliWithPort(19992, "list", "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  test("--type filters results", async () => {
    const proc = runCliWithPort(19992, "list", "--type", "place");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Tokyo Ramen");
    expect(out).not.toContain("First Note");
  });

  test("empty results prints no memories message", async () => {
    const emptyServer = serve({
      port: 19991,
      fetch() {
        return new Response("[]", { headers: { "Content-Type": "application/json" } });
      },
    });

    const proc = runCliWithPort(19991, "list");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    emptyServer.stop();

    expect(exitCode).toBe(0);
    expect(out).toContain("No memories found.");
  });

  test("API connection failure exits 1", async () => {
    const proc = runCliWithPort(19994, "list");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot reach Kore API");
  });
});

// ─── Show Command ─────────────────────────────────────────────────────────────

describe("show command", () => {
  const fullMemory = {
    id: "bbbbbbbb-0000-0000-0000-000000000001",
    type: "note",
    category: "qmd://tech/programming",
    date_saved: "2026-03-07T12:00:00Z",
    source: "apple_notes",
    tags: ["tech"],
    title: "My Full Note",
    content: "---\nid: bbbbbbbb-0000-0000-0000-000000000001\ntype: note\n---\n\n# My Full Note\n\nBody text here.\n",
  };

  const showServer = serve({
    port: 19990,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/api/v1/memory/${fullMemory.id}`) {
        return new Response(JSON.stringify(fullMemory), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/v1/memory/")) {
        return new Response(JSON.stringify({ error: "Memory not found", code: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => {
    showServer.stop();
  });

  test("prints raw markdown content", async () => {
    const proc = runCliWithPort(19990, "show", fullMemory.id);
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("# My Full Note");
    expect(out).toContain("Body text here.");
  });

  test("--json outputs JSON representation", async () => {
    const proc = runCliWithPort(19990, "show", fullMemory.id, "--json");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.id).toBe(fullMemory.id);
    expect(data.title).toBe("My Full Note");
    expect(data.content).toBeDefined();
  });

  test("404 prints error message and exits 1", async () => {
    const proc = runCliWithPort(19990, "show", "nonexistent-id");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Memory nonexistent-id not found");
  });
});

// ─── Delete Command ───────────────────────────────────────────────────────────

describe("delete command", () => {
  const targetId = "cccccccc-0000-0000-0000-000000000001";

  const deleteServer = serve({
    port: 19989,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/api/v1/memory/${targetId}` && req.method === "DELETE") {
        return new Response(JSON.stringify({ status: "deleted", id: targetId }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/v1/memory/") && req.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Memory not found", code: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  afterAll(() => {
    deleteServer.stop();
  });

  test("--force deletes without confirmation and prints success", async () => {
    const proc = runCliWithPort(19989, "delete", targetId, "--force");
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain(`✓ Deleted memory ${targetId}`);
  });

  test("404 prints error and exits 1", async () => {
    const proc = runCliWithPort(19989, "delete", "nonexistent-id", "--force");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Memory nonexistent-id not found");
  });

  test("API connection failure exits 1", async () => {
    const proc = runCliWithPort(19994, "delete", targetId, "--force");
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot reach Kore API");
  });

  test("confirmation prompt: 'y' confirms and deletes", async () => {
    const proc = Bun.spawn(["bun", CLI, "delete", targetId], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:19989`,
        KORE_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    proc.stdin.write("y\n");
    proc.stdin.end();

    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain(`✓ Deleted memory ${targetId}`);
  });

  test("confirmation prompt: 'n' aborts without deleting", async () => {
    const proc = Bun.spawn(["bun", CLI, "delete", targetId], {
      env: {
        ...process.env,
        KORE_API_URL: `http://127.0.0.1:19989`,
        KORE_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    proc.stdin.write("n\n");
    proc.stdin.end();

    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toContain("Aborted.");
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PluginStartDeps } from "@kore/shared-types";
import type { ExportResult } from "@kore/an-export";
import { createAppleNotesPlugin } from "../index";
import { Elysia } from "elysia";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const noopSyncNotes = async (): Promise<ExportResult> => ({
  exported: 0, skipped: 0, deleted: 0, failed: [],
});

let tmpHome: string;

function createMockDeps(entries: Array<{ externalKey: string; memoryId: string; metadata?: string }> = []): PluginStartDeps {
  return {
    enqueue: () => "task-1",
    deleteMemory: async () => true,
    getMemoryIdByExternalKey: () => undefined,
    setExternalKeyMapping: () => {},
    removeExternalKeyMapping: () => {},
    clearRegistry: () => {},
    listExternalKeys: () => entries,
  };
}

describe("AppleNotesPlugin routes", () => {
  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "kore-routes-test-"));
    process.env.KORE_HOME = tmpHome;
  });

  afterEach(async () => {
    delete process.env.KORE_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("GET /api/v1/plugins/apple-notes/status returns correct shape", async () => {
    const entries = [
      { externalKey: "1", memoryId: "mem-a" },
      { externalKey: "2", memoryId: "pending:task-1" },
      { externalKey: "3", memoryId: "mem-b" },
    ];
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps(entries));

    const app = new Elysia();
    plugin.routes!(app);

    const res = await app.handle(new Request("http://localhost/api/v1/plugins/apple-notes/status"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("enabled", true);
    expect(body).toHaveProperty("last_sync_at");
    expect(body).toHaveProperty("last_sync_result");
    expect(body).toHaveProperty("total_tracked_notes", 3);
    expect(body).toHaveProperty("next_sync_in_seconds");
    expect(typeof body.next_sync_in_seconds).toBe("number");
    expect(body).toHaveProperty("staging_path");
    expect(body.staging_path).toContain("staging/apple-notes");

    await plugin.stop!();
  });

  test("GET /api/v1/plugins/apple-notes/status returns null sync state before first sync", async () => {
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());

    const app = new Elysia();
    plugin.routes!(app);

    const res = await app.handle(new Request("http://localhost/api/v1/plugins/apple-notes/status"));
    const body = await res.json();

    expect(body.last_sync_at).toBeNull();
    expect(body.last_sync_result).toBeNull();

    await plugin.stop!();
  });

  test("POST /api/v1/plugins/apple-notes/sync returns 202", async () => {
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());

    const app = new Elysia();
    plugin.routes!(app);

    const res = await app.handle(
      new Request("http://localhost/api/v1/plugins/apple-notes/sync", { method: "POST" })
    );
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body).toHaveProperty("status", "sync_triggered");
    expect(body).toHaveProperty("message");

    await plugin.stop!();
  });
});

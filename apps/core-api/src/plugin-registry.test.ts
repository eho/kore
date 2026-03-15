import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PluginRegistryRepository } from "./plugin-registry";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

let tempDir: string;
let db: Database;
let registry: PluginRegistryRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-registry-test-"));
  db = new Database(join(tempDir, `registry-${Date.now()}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  registry = new PluginRegistryRepository(db);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── set / get ──────────────────────────────────────────────────────

describe("set and get", () => {
  test("stores and retrieves a mapping", () => {
    registry.set("my-plugin", "ext-123", "mem-456");
    expect(registry.get("my-plugin", "ext-123")).toBe("mem-456");
  });

  test("returns undefined for non-existent key", () => {
    expect(registry.get("my-plugin", "no-such-key")).toBeUndefined();
  });

  test("returns undefined for non-existent plugin", () => {
    registry.set("my-plugin", "ext-123", "mem-456");
    expect(registry.get("other-plugin", "ext-123")).toBeUndefined();
  });

  test("upserts on duplicate key", () => {
    registry.set("my-plugin", "ext-123", "mem-old");
    registry.set("my-plugin", "ext-123", "mem-new");
    expect(registry.get("my-plugin", "ext-123")).toBe("mem-new");
  });
});

// ─── remove ─────────────────────────────────────────────────────────

describe("remove", () => {
  test("removes a specific mapping", () => {
    registry.set("my-plugin", "ext-123", "mem-456");
    registry.remove("my-plugin", "ext-123");
    expect(registry.get("my-plugin", "ext-123")).toBeUndefined();
  });

  test("does not affect other keys", () => {
    registry.set("my-plugin", "ext-1", "mem-1");
    registry.set("my-plugin", "ext-2", "mem-2");
    registry.remove("my-plugin", "ext-1");
    expect(registry.get("my-plugin", "ext-2")).toBe("mem-2");
  });

  test("no-op when key does not exist", () => {
    // Should not throw
    registry.remove("my-plugin", "no-such-key");
  });
});

// ─── clear ──────────────────────────────────────────────────────────

describe("clear", () => {
  test("removes all mappings for a plugin", () => {
    registry.set("my-plugin", "ext-1", "mem-1");
    registry.set("my-plugin", "ext-2", "mem-2");
    registry.set("my-plugin", "ext-3", "mem-3");
    registry.clear("my-plugin");

    expect(registry.get("my-plugin", "ext-1")).toBeUndefined();
    expect(registry.get("my-plugin", "ext-2")).toBeUndefined();
    expect(registry.get("my-plugin", "ext-3")).toBeUndefined();
  });

  test("does not affect other plugins' entries", () => {
    registry.set("plugin-a", "ext-1", "mem-1");
    registry.set("plugin-b", "ext-1", "mem-2");
    registry.clear("plugin-a");

    expect(registry.get("plugin-a", "ext-1")).toBeUndefined();
    expect(registry.get("plugin-b", "ext-1")).toBe("mem-2");
  });
});

// ─── listByPlugin ───────────────────────────────────────────────────

describe("listByPlugin", () => {
  test("returns all mappings for a plugin", () => {
    registry.set("my-plugin", "ext-1", "mem-1");
    registry.set("my-plugin", "ext-2", "mem-2");

    const entries = registry.listByPlugin("my-plugin");
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ externalKey: "ext-1", memoryId: "mem-1" });
    expect(entries).toContainEqual({ externalKey: "ext-2", memoryId: "mem-2" });
  });

  test("returns empty array for unknown plugin", () => {
    expect(registry.listByPlugin("no-such-plugin")).toEqual([]);
  });

  test("does not include other plugins' entries", () => {
    registry.set("plugin-a", "ext-1", "mem-1");
    registry.set("plugin-b", "ext-2", "mem-2");

    const entries = registry.listByPlugin("plugin-a");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ externalKey: "ext-1", memoryId: "mem-1" });
  });
});

// ─── plugin scoping ─────────────────────────────────────────────────

describe("plugin scoping", () => {
  test("plugins cannot see each other's keys", () => {
    registry.set("plugin-a", "shared-key", "mem-a");
    registry.set("plugin-b", "shared-key", "mem-b");

    expect(registry.get("plugin-a", "shared-key")).toBe("mem-a");
    expect(registry.get("plugin-b", "shared-key")).toBe("mem-b");
  });

  test("removing a key for one plugin does not affect another", () => {
    registry.set("plugin-a", "shared-key", "mem-a");
    registry.set("plugin-b", "shared-key", "mem-b");
    registry.remove("plugin-a", "shared-key");

    expect(registry.get("plugin-a", "shared-key")).toBeUndefined();
    expect(registry.get("plugin-b", "shared-key")).toBe("mem-b");
  });
});

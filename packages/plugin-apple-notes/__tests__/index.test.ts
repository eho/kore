import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PluginStartDeps, MemoryEvent } from "@kore/shared-types";
import appleNotesPlugin from "../index";

// ─── Mock deps ──────────────────────────────────────────────────────

let mockEntries: Array<{ externalKey: string; memoryId: string; metadata?: string }>;
let setMappingCalls: Array<{ externalKey: string; memoryId: string }>;

function createMockDeps(): PluginStartDeps {
  mockEntries = [];
  setMappingCalls = [];

  return {
    enqueue: () => "task-1",
    deleteMemory: async () => true,
    getMemoryIdByExternalKey: () => undefined,
    setExternalKeyMapping: (externalKey, memoryId) => {
      setMappingCalls.push({ externalKey, memoryId });
      // Update mock entries to reflect the change
      const idx = mockEntries.findIndex((e) => e.externalKey === externalKey);
      if (idx >= 0) {
        mockEntries[idx].memoryId = memoryId;
      }
    },
    removeExternalKeyMapping: () => {},
    clearRegistry: () => {},
    listExternalKeys: () => mockEntries,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("AppleNotesPlugin onMemoryIndexed", () => {
  let deps: PluginStartDeps;

  beforeEach(async () => {
    deps = createMockDeps();
    // Start the plugin so deps are stored (skip sync loop by not setting env vars)
    // We call onMemoryIndexed directly after setting deps via start
    // But start() also creates dirs and starts sync loop, so we mock minimally
    // Instead, we'll use a test-specific approach: manually trigger the handler
  });

  afterEach(async () => {
    if (appleNotesPlugin.stop) {
      await appleNotesPlugin.stop();
    }
  });

  test("resolves matching pending entry when source is apple_notes", async () => {
    // Simulate: deps are set, registry has a pending entry
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-abc", metadata: '{"mtime":1234}' },
      { externalKey: "99", memoryId: "mem-existing", metadata: '{"mtime":5678}' },
    ];

    // Start plugin to store deps reference (creates staging dirs in tmp)
    process.env.KORE_HOME = await require("node:fs/promises")
      .mkdtemp(require("node:path").join(require("node:os").tmpdir(), "kore-anote-test-"));
    await appleNotesPlugin.start!(deps);

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc",
    };

    await appleNotesPlugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(1);
    expect(setMappingCalls[0]).toEqual({
      externalKey: "42",
      memoryId: "mem-new-uuid",
    });
  });

  test("ignores events with non-apple_notes source", async () => {
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-abc" },
    ];

    process.env.KORE_HOME = await require("node:fs/promises")
      .mkdtemp(require("node:path").join(require("node:os").tmpdir(), "kore-anote-test-"));
    await appleNotesPlugin.start!(deps);

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "x_bookmark", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc",
    };

    await appleNotesPlugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
  });

  test("ignores events without taskId", async () => {
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-abc" },
    ];

    process.env.KORE_HOME = await require("node:fs/promises")
      .mkdtemp(require("node:path").join(require("node:os").tmpdir(), "kore-anote-test-"));
    await appleNotesPlugin.start!(deps);

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      // no taskId
    };

    await appleNotesPlugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
  });

  test("does nothing when no matching pending entry exists", async () => {
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-xyz" }, // different taskId
      { externalKey: "99", memoryId: "mem-existing" },     // already resolved
    ];

    process.env.KORE_HOME = await require("node:fs/promises")
      .mkdtemp(require("node:path").join(require("node:os").tmpdir(), "kore-anote-test-"));
    await appleNotesPlugin.start!(deps);

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc", // no pending:task-abc in registry
    };

    await appleNotesPlugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
  });
});

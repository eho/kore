import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PluginStartDeps, MemoryEvent } from "@kore/shared-types";
import type { ExportResult } from "@kore/an-export";
import { createAppleNotesPlugin } from "../index";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const noopSyncNotes = async (): Promise<ExportResult> => ({
  exported: 0, skipped: 0, deleted: 0, failed: [],
});

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
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "kore-anote-test-"));
    process.env.KORE_HOME = tmpHome;
  });

  afterEach(async () => {
    delete process.env.KORE_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("resolves matching pending entry when source is apple_notes", async () => {
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-abc", metadata: '{"mtime":1234}' },
      { externalKey: "99", memoryId: "mem-existing", metadata: '{"mtime":5678}' },
    ];

    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());
    // Re-assign mockEntries after start so they're visible through listExternalKeys
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-abc", metadata: '{"mtime":1234}' },
      { externalKey: "99", memoryId: "mem-existing", metadata: '{"mtime":5678}' },
    ];

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc",
    };

    await plugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(1);
    expect(setMappingCalls[0]).toEqual({
      externalKey: "42",
      memoryId: "mem-new-uuid",
    });

    await plugin.stop!();
  });

  test("ignores events with non-apple_notes source", async () => {
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());
    mockEntries = [{ externalKey: "42", memoryId: "pending:task-abc" }];

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "x_bookmark", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc",
    };

    await plugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
    await plugin.stop!();
  });

  test("ignores events without taskId", async () => {
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());
    mockEntries = [{ externalKey: "42", memoryId: "pending:task-abc" }];

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      // no taskId
    };

    await plugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
    await plugin.stop!();
  });

  test("does nothing when no matching pending entry exists", async () => {
    const plugin = createAppleNotesPlugin({ _syncNotesFn: noopSyncNotes });
    await plugin.start!(createMockDeps());
    mockEntries = [
      { externalKey: "42", memoryId: "pending:task-xyz" },
      { externalKey: "99", memoryId: "mem-existing" },
    ];

    const event: MemoryEvent = {
      id: "mem-new-uuid",
      filePath: "/data/notes/test.md",
      frontmatter: { source: "apple_notes", type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-abc",
    };

    await plugin.onMemoryIndexed!(event);

    expect(setMappingCalls).toHaveLength(0);
    await plugin.stop!();
  });
});

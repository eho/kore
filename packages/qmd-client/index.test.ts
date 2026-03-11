import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { QMDStore, UpdateResult, IndexStatus } from "@tobilu/qmd";

// ── Mock Setup ─────────────────────────────────────────────────────────────
// Mock createStore from @tobilu/qmd before importing qmd-client.

const mockStore: Partial<QMDStore> = {
  update: mock(() =>
    Promise.resolve({
      collections: 1,
      indexed: 5,
      updated: 2,
      unchanged: 3,
      removed: 0,
      needsEmbedding: 2,
    } satisfies UpdateResult),
  ),
  embed: mock(() =>
    Promise.resolve({
      docsProcessed: 2,
      chunksEmbedded: 10,
      errors: 0,
      durationMs: 500,
    }),
  ),
  getStatus: mock(() =>
    Promise.resolve({
      totalDocuments: 5,
      needsEmbedding: 2,
      hasVectorIndex: true,
      collections: [
        {
          name: "memories",
          path: "/app/data",
          pattern: "**/*.md",
          documents: 5,
          lastUpdated: "2026-03-11T00:00:00Z",
        },
      ],
    } satisfies IndexStatus),
  ),
  getIndexHealth: mock(() =>
    Promise.resolve({
      needsEmbedding: 2,
      totalDocs: 5,
      daysStale: null,
    }),
  ),
  addCollection: mock(() => Promise.resolve()),
  addContext: mock(() => Promise.resolve(true)),
  close: mock(() => Promise.resolve()),
};

mock.module("@tobilu/qmd", () => ({
  createStore: mock(() => Promise.resolve(mockStore)),
}));

// Import qmd-client AFTER mocking @tobilu/qmd
const {
  initStore,
  closeStore,
  update,
  embed,
  getStatus,
  getIndexHealth,
  addCollection,
  addContext,
  resetStore,
} = await import("./index");

const { createStore: mockCreateStore } = await import("@tobilu/qmd");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("qmd-client", () => {
  beforeEach(() => {
    resetStore();
    (mockCreateStore as ReturnType<typeof mock>).mockClear();
    // Clear all mock store method call counts
    for (const fn of Object.values(mockStore)) {
      if (typeof fn === "function" && "mockClear" in fn) {
        (fn as ReturnType<typeof mock>).mockClear();
      }
    }
  });

  // ─── initStore() ───────────────────────────────────────────

  describe("initStore()", () => {
    test("calls createStore with correct dbPath and inline config", async () => {
      await initStore("/tmp/test.sqlite");

      expect(mockCreateStore).toHaveBeenCalledTimes(1);
      const callArgs = (mockCreateStore as ReturnType<typeof mock>).mock
        .calls[0] as [{ dbPath: string; config: Record<string, unknown> }];
      expect(callArgs[0].dbPath).toBe("/tmp/test.sqlite");
      expect(callArgs[0].config).toEqual({
        collections: {
          memories: {
            path: expect.any(String),
            pattern: "**/*.md",
          },
        },
      });
    });

    test("throws if called twice without closeStore()", async () => {
      await initStore("/tmp/test.sqlite");
      expect(initStore("/tmp/test2.sqlite")).rejects.toThrow(
        "already initialized",
      );
    });

    test("uses KORE_QMD_DB_PATH env var as default dbPath", async () => {
      const original = process.env.KORE_QMD_DB_PATH;
      process.env.KORE_QMD_DB_PATH = "/custom/path.sqlite";
      try {
        await initStore();
        const callArgs = (mockCreateStore as ReturnType<typeof mock>).mock
          .calls[0] as [{ dbPath: string }];
        expect(callArgs[0].dbPath).toBe("/custom/path.sqlite");
      } finally {
        if (original === undefined) {
          delete process.env.KORE_QMD_DB_PATH;
        } else {
          process.env.KORE_QMD_DB_PATH = original;
        }
      }
    });
  });

  // ─── Functions before init ─────────────────────────────────

  describe("before initStore()", () => {
    test("update() throws when store not initialized", () => {
      expect(update()).rejects.toThrow("not initialized");
    });

    test("embed() throws when store not initialized", () => {
      expect(embed()).rejects.toThrow("not initialized");
    });

    test("getStatus() throws when store not initialized", () => {
      expect(getStatus()).rejects.toThrow("not initialized");
    });

    test("addCollection() throws when store not initialized", () => {
      expect(
        addCollection("test", { path: "/data" }),
      ).rejects.toThrow("not initialized");
    });

    test("addContext() throws when store not initialized", () => {
      expect(
        addContext("test", "/", "some context"),
      ).rejects.toThrow("not initialized");
    });
  });

  // ─── update() ──────────────────────────────────────────────

  describe("update()", () => {
    test("returns UpdateResult on success", async () => {
      await initStore("/tmp/test.sqlite");
      const result = await update();
      expect(result).toEqual({
        collections: 1,
        indexed: 5,
        updated: 2,
        unchanged: 3,
        removed: 0,
        needsEmbedding: 2,
      });
      expect(mockStore.update).toHaveBeenCalledTimes(1);
    });

    test("propagates errors from store.update()", async () => {
      await initStore("/tmp/test.sqlite");
      (mockStore.update as ReturnType<typeof mock>).mockImplementationOnce(
        () => Promise.reject(new Error("SQLite lock")),
      );
      expect(update()).rejects.toThrow("SQLite lock");
    });
  });

  // ─── embed() ──────────────────────────────────────────────

  describe("embed()", () => {
    test("delegates to store.embed() and returns EmbedResult", async () => {
      await initStore("/tmp/test.sqlite");
      const result = await embed();
      expect(result).toEqual({
        docsProcessed: 2,
        chunksEmbedded: 10,
        errors: 0,
        durationMs: 500,
      });
      expect(mockStore.embed).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getStatus() ──────────────────────────────────────────

  describe("getStatus()", () => {
    test("returns typed IndexStatus object", async () => {
      await initStore("/tmp/test.sqlite");
      const result = await getStatus();
      expect(result.totalDocuments).toBe(5);
      expect(result.needsEmbedding).toBe(2);
      expect(result.hasVectorIndex).toBe(true);
      expect(result.collections).toHaveLength(1);
      expect(result.collections[0]!.name).toBe("memories");
    });
  });

  // ─── getIndexHealth() ─────────────────────────────────────

  describe("getIndexHealth()", () => {
    test("returns typed IndexHealthInfo object", async () => {
      await initStore("/tmp/test.sqlite");
      const result = await getIndexHealth();
      expect(result.needsEmbedding).toBe(2);
      expect(result.totalDocs).toBe(5);
      expect(result.daysStale).toBeNull();
    });
  });

  // ─── addCollection() ──────────────────────────────────────

  describe("addCollection()", () => {
    test("delegates to store.addCollection()", async () => {
      await initStore("/tmp/test.sqlite");
      await addCollection("notes", { path: "/data/notes", pattern: "**/*.md" });
      expect(mockStore.addCollection).toHaveBeenCalledWith("notes", {
        path: "/data/notes",
        pattern: "**/*.md",
      });
    });
  });

  // ─── addContext() ─────────────────────────────────────────

  describe("addContext()", () => {
    test("delegates to store.addContext()", async () => {
      await initStore("/tmp/test.sqlite");
      const result = await addContext("memories", "/", "Personal knowledge");
      expect(result).toBe(true);
      expect(mockStore.addContext).toHaveBeenCalledWith(
        "memories",
        "/",
        "Personal knowledge",
      );
    });
  });

  // ─── closeStore() ─────────────────────────────────────────

  describe("closeStore()", () => {
    test("calls store.close() and nullifies singleton", async () => {
      await initStore("/tmp/test.sqlite");
      await closeStore();
      expect(mockStore.close).toHaveBeenCalledTimes(1);
      // After close, calling functions should throw
      expect(update()).rejects.toThrow("not initialized");
    });

    test("is safe to call when not initialized", async () => {
      // Should not throw
      await closeStore();
    });

    test("allows re-initialization after close", async () => {
      await initStore("/tmp/test.sqlite");
      await closeStore();
      await initStore("/tmp/test2.sqlite");
      // Should work without issues
      const result = await getStatus();
      expect(result.totalDocuments).toBe(5);
    });
  });

  // ─── resetStore() ─────────────────────────────────────────

  describe("resetStore()", () => {
    test("nullifies singleton without calling close", async () => {
      await initStore("/tmp/test.sqlite");
      resetStore();
      // close was NOT called
      expect(mockStore.close).not.toHaveBeenCalled();
      // But store is now null
      expect(update()).rejects.toThrow("not initialized");
    });
  });
});

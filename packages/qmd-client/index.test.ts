import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { QMDStore, UpdateResult, IndexStatus } from "@tobilu/qmd";

// ── Mock Setup ─────────────────────────────────────────────────────────────
// Mock createStore from @tobilu/qmd before importing qmd-client.

const mockStore: Partial<QMDStore> = {
  internal: {
    db: {
      loadExtension: mock(() => {}),
    },
  } as any,
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
  findSpatialite,
} = await import("./index");

const { createStore: mockCreateStore } = await import("@tobilu/qmd");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("qmd-client", () => {
  let originalSpatialitePath: string | undefined;

  beforeEach(() => {
    resetStore();
    originalSpatialitePath = process.env.SPATIALITE_PATH;
    process.env.SPATIALITE_PATH = "/tmp/fake-spatialite.so";

    (mockCreateStore as ReturnType<typeof mock>).mockClear();
    // Clear all mock store method call counts
    for (const fn of Object.values(mockStore)) {
      if (typeof fn === "function" && "mockClear" in fn) {
        (fn as ReturnType<typeof mock>).mockClear();
      }
    }
    // Deep clear loadExtension
    (mockStore.internal as any).db.loadExtension.mockClear();
  });

  afterEach(() => {
    if (originalSpatialitePath === undefined) {
      delete process.env.SPATIALITE_PATH;
    } else {
      process.env.SPATIALITE_PATH = originalSpatialitePath;
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

    test("auto-detects and loads Spatialite extension", async () => {
      process.env.SPATIALITE_PATH = "/custom/spatialite.so";
      await initStore("/tmp/test.sqlite");

      expect((mockStore.internal as any).db.loadExtension).toHaveBeenCalledWith(
        "/custom/spatialite.so",
      );
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

  // ─── Concurrency Lock ──────────────────────────────────────

  describe("concurrency lock", () => {
    test("update() and embed() do not run concurrently", async () => {
      await initStore("/tmp/test.sqlite");

      const executionLog: string[] = [];

      (mockStore.update as ReturnType<typeof mock>).mockImplementation(
        () =>
          new Promise((resolve) => {
            executionLog.push("update-start");
            setTimeout(() => {
              executionLog.push("update-end");
              resolve({
                collections: 1,
                indexed: 5,
                updated: 2,
                unchanged: 3,
                removed: 0,
                needsEmbedding: 2,
              });
            }, 50);
          }),
      );

      (mockStore.embed as ReturnType<typeof mock>).mockImplementation(
        () =>
          new Promise((resolve) => {
            executionLog.push("embed-start");
            setTimeout(() => {
              executionLog.push("embed-end");
              resolve({
                docsProcessed: 2,
                chunksEmbedded: 10,
                errors: 0,
                durationMs: 500,
              });
            }, 50);
          }),
      );

      // Fire both concurrently
      const [updateResult, embedResult] = await Promise.all([
        update(),
        embed(),
      ]);

      expect(updateResult.indexed).toBe(5);
      expect(embedResult.docsProcessed).toBe(2);

      // They should have run sequentially: update fully completes before embed starts
      expect(executionLog).toEqual([
        "update-start",
        "update-end",
        "embed-start",
        "embed-end",
      ]);
    });

    test("lock releases after an error so subsequent calls still work", async () => {
      await initStore("/tmp/test.sqlite");

      (mockStore.update as ReturnType<typeof mock>).mockImplementationOnce(
        () => Promise.reject(new Error("first call fails")),
      );

      // First call fails
      await expect(update()).rejects.toThrow("first call fails");

      // Second call should still work (lock released)
      const result = await update();
      expect(result.indexed).toBe(5);
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

// ── findSpatialite() ───────────────────────────────────────────────────────

describe("findSpatialite()", () => {
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let originalSpatialitePath: string | undefined;

  beforeEach(() => {
    originalSpatialitePath = process.env.SPATIALITE_PATH;
    delete process.env.SPATIALITE_PATH;
    existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    if (originalSpatialitePath === undefined) {
      delete process.env.SPATIALITE_PATH;
    } else {
      process.env.SPATIALITE_PATH = originalSpatialitePath;
    }
  });

  test("returns SPATIALITE_PATH env var without checking filesystem", () => {
    process.env.SPATIALITE_PATH = "/custom/mod_spatialite.so";
    const result = findSpatialite();
    expect(result).toBe("/custom/mod_spatialite.so");
    expect(existsSyncSpy).not.toHaveBeenCalled();
  });

  test("returns macOS arm64 Homebrew path when it exists", () => {
    existsSyncSpy.mockImplementation(
      (p: unknown) => p === "/opt/homebrew/lib/mod_spatialite.dylib",
    );
    const result = findSpatialite();
    expect(result).toBe("/opt/homebrew/lib/mod_spatialite.dylib");
  });

  test("returns macOS x86 Homebrew path when arm64 is absent", () => {
    existsSyncSpy.mockImplementation(
      (p: unknown) => p === "/usr/local/lib/mod_spatialite.dylib",
    );
    const result = findSpatialite();
    expect(result).toBe("/usr/local/lib/mod_spatialite.dylib");
  });

  test("returns Linux x86_64 path when it exists", () => {
    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === "/usr/lib/x86_64-linux-gnu/mod_spatialite.so",
    );
    const result = findSpatialite();
    expect(result).toBe("/usr/lib/x86_64-linux-gnu/mod_spatialite.so");
  });

  test("returns Linux aarch64 path when it exists", () => {
    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === "/usr/lib/aarch64-linux-gnu/mod_spatialite.so",
    );
    const result = findSpatialite();
    expect(result).toBe("/usr/lib/aarch64-linux-gnu/mod_spatialite.so");
  });

  test("returns null when no path found", () => {
    expect(findSpatialite()).toBeNull();
  });
});

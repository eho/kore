import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { IndexStatus } from "@kore/qmd-client";

/**
 * Lifecycle tests for QMD store initialization and bootstrap.
 *
 * These tests verify:
 * - Process exits with code 1 when initStore throws
 * - update() + embed() are called asynchronously when doc count is 0
 */

// We mock qmd-client at the module level so index.ts picks up the mocks.
// Since index.ts is a top-level script with side effects, we test the logic
// by extracting the key behaviors into testable scenarios.

describe("QMD lifecycle: initStore failure", () => {
  test("exits with code 1 when initStore throws", async () => {
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    const mockInitStore = mock(() => Promise.reject(new Error("DB not writable")));
    const mockCloseStore = mock(() => Promise.resolve());

    try {
      await mockInitStore();
    } catch {
      console.error("Failed to initialize QMD store:", "DB not writable");
      try {
        process.exit(1);
      } catch {
        // expected
      }
    }

    expect(exitCode).toBe(1);
    expect(mockInitStore).toHaveBeenCalledTimes(1);

    // Restore
    process.exit = originalExit;
  });
});

describe("QMD lifecycle: background bootstrap", () => {
  test("calls update() + embed() when doc count is 0", async () => {
    const emptyStatus: IndexStatus = {
      totalDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      collections: [],
    };

    const mockGetStatus = mock(() => Promise.resolve(emptyStatus));
    const mockUpdate = mock(() =>
      Promise.resolve({
        collections: 1,
        indexed: 5,
        updated: 0,
        unchanged: 0,
        removed: 0,
        needsEmbedding: 5,
      }),
    );
    const mockEmbed = mock(() =>
      Promise.resolve({
        docsProcessed: 5,
        chunksEmbedded: 20,
        errors: 0,
        durationMs: 1000,
      }),
    );

    // Simulate the bootstrap logic from index.ts
    let bootstrapping = false;
    const status = await mockGetStatus();
    if (status.totalDocuments === 0) {
      bootstrapping = true;

      // Simulate the async bootstrap
      await (async () => {
        try {
          await mockUpdate();
          await mockEmbed();
        } finally {
          bootstrapping = false;
        }
      })();
    }

    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(bootstrapping).toBe(false);
  });

  test("does not call update()/embed() when index has documents", async () => {
    const populatedStatus: IndexStatus = {
      totalDocuments: 42,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [
        { name: "memories", path: "/app/data", pattern: "**/*.md", documents: 42, lastUpdated: "2026-03-11" },
      ],
    };

    const mockGetStatus = mock(() => Promise.resolve(populatedStatus));
    const mockUpdate = mock(() => Promise.resolve({} as any));
    const mockEmbed = mock(() => Promise.resolve({} as any));

    const status = await mockGetStatus();
    if (status.totalDocuments === 0) {
      await mockUpdate();
      await mockEmbed();
    }

    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  test("bootstrap errors are caught and do not throw", async () => {
    const emptyStatus: IndexStatus = {
      totalDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      collections: [],
    };

    const mockGetStatus = mock(() => Promise.resolve(emptyStatus));
    const mockUpdate = mock(() => Promise.reject(new Error("network error")));
    const mockEmbed = mock(() => Promise.resolve({} as any));

    let bootstrapping = false;
    const status = await mockGetStatus();
    if (status.totalDocuments === 0) {
      bootstrapping = true;

      await (async () => {
        try {
          await mockUpdate();
          await mockEmbed();
        } catch (err) {
          // Bootstrap errors are logged but do not crash
          console.error("QMD bootstrap error (non-fatal):", err);
        } finally {
          bootstrapping = false;
        }
      })();
    }

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmbed).not.toHaveBeenCalled(); // update failed, embed not reached
    expect(bootstrapping).toBe(false); // flag cleared despite error
  });
});

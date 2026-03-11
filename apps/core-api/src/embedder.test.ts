import { test, expect, beforeEach, afterEach, jest } from "bun:test";
import { startEmbedInterval } from "./embedder";
import type { EmbedResult } from "@kore/qmd-client";
import type { EmbedderHandle } from "./embedder";

const MOCK_EMBED_RESULT: EmbedResult = {
  docsProcessed: 2,
  chunksEmbedded: 10,
  errors: 0,
  durationMs: 500,
};

let handle: EmbedderHandle | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
});

test("calls embedFn after the interval fires", async () => {
  let embedCalls = 0;
  const mockEmbed = async (): Promise<EmbedResult> => {
    embedCalls++;
    return MOCK_EMBED_RESULT;
  };

  handle = startEmbedInterval({ intervalMs: 50, embedFn: mockEmbed });

  // Wait for at least one interval tick
  await new Promise((r) => setTimeout(r, 120));

  expect(embedCalls).toBeGreaterThanOrEqual(1);
});

test("does not call embedFn before the interval fires", async () => {
  let embedCalls = 0;
  const mockEmbed = async (): Promise<EmbedResult> => {
    embedCalls++;
    return MOCK_EMBED_RESULT;
  };

  handle = startEmbedInterval({ intervalMs: 500, embedFn: mockEmbed });

  // Check immediately — should not have fired yet
  await new Promise((r) => setTimeout(r, 50));
  expect(embedCalls).toBe(0);
});

test("catches errors without stopping the interval", async () => {
  let embedCalls = 0;
  const mockEmbed = async (): Promise<EmbedResult> => {
    embedCalls++;
    if (embedCalls === 1) {
      throw new Error("model load failed");
    }
    return MOCK_EMBED_RESULT;
  };

  handle = startEmbedInterval({ intervalMs: 50, embedFn: mockEmbed });

  // Wait for multiple interval ticks
  await new Promise((r) => setTimeout(r, 180));

  // Should have been called multiple times despite the first error
  expect(embedCalls).toBeGreaterThanOrEqual(2);
});

test("stop() prevents further embed calls", async () => {
  let embedCalls = 0;
  const mockEmbed = async (): Promise<EmbedResult> => {
    embedCalls++;
    return MOCK_EMBED_RESULT;
  };

  handle = startEmbedInterval({ intervalMs: 50, embedFn: mockEmbed });
  handle.stop();
  handle = null;

  // Wait past the interval
  await new Promise((r) => setTimeout(r, 150));

  expect(embedCalls).toBe(0);
});

test("reads KORE_EMBED_INTERVAL_MS from env when intervalMs not provided", async () => {
  const originalEnv = process.env.KORE_EMBED_INTERVAL_MS;
  let embedCalls = 0;
  const mockEmbed = async (): Promise<EmbedResult> => {
    embedCalls++;
    return MOCK_EMBED_RESULT;
  };

  try {
    process.env.KORE_EMBED_INTERVAL_MS = "50";
    handle = startEmbedInterval({ embedFn: mockEmbed });

    await new Promise((r) => setTimeout(r, 120));

    expect(embedCalls).toBeGreaterThanOrEqual(1);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.KORE_EMBED_INTERVAL_MS;
    } else {
      process.env.KORE_EMBED_INTERVAL_MS = originalEnv;
    }
  }
});

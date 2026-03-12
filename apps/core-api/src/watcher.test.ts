import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWatcher } from "./watcher";
import type { UpdateResult } from "@kore/qmd-client";

const MOCK_UPDATE_RESULT: UpdateResult = {
  collections: 1,
  indexed: 1,
  updated: 0,
  unchanged: 0,
  removed: 0,
  needsEmbedding: 1,
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-watcher-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("watcher calls updateFn when a .md file is written", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  try {
    // Brief delay to let fs.watch register before triggering an event
    await new Promise((r) => setTimeout(r, 50));

    // Write a .md file to trigger the watcher
    await Bun.write(join(tempDir, "test_memory.md"), "# Test");

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 400));

    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

test("watcher ignores non-.md files", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  try {
    // Write a non-.md file
    await Bun.write(join(tempDir, "test.txt"), "hello");

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 300));

    expect(updateCalls).toBe(0);
  } finally {
    handle.stop();
  }
});

test("watcher debounces rapid changes into a single update call", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 200,
    updateFn: mockUpdate,
  });

  try {
    // Write multiple .md files in rapid succession
    await Bun.write(join(tempDir, "file1.md"), "# One");
    await new Promise((r) => setTimeout(r, 50));
    await Bun.write(join(tempDir, "file2.md"), "# Two");
    await new Promise((r) => setTimeout(r, 50));
    await Bun.write(join(tempDir, "file3.md"), "# Three");

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 400));

    // Should have debounced into a single update call
    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

test("watcher resets debounce timer on each new change", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 200,
    updateFn: mockUpdate,
  });

  try {
    // Write a file
    await Bun.write(join(tempDir, "first.md"), "# First");

    // Wait 150ms (before debounce fires at 200ms)
    await new Promise((r) => setTimeout(r, 150));
    expect(updateCalls).toBe(0);

    // Write another file, resetting the debounce
    await Bun.write(join(tempDir, "second.md"), "# Second");

    // Wait another 150ms (still within debounce from second write)
    await new Promise((r) => setTimeout(r, 150));
    expect(updateCalls).toBe(0);

    // Wait for the debounce to fully settle
    await new Promise((r) => setTimeout(r, 200));
    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

test("stop() prevents further update calls", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  // Write a file then immediately stop
  await Bun.write(join(tempDir, "test.md"), "# Test");
  handle.stop();

  // Wait well past the debounce window
  await new Promise((r) => setTimeout(r, 300));

  expect(updateCalls).toBe(0);
});

test("watcher handles updateFn failure gracefully", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  try {
    await Bun.write(join(tempDir, "test.md"), "# Test");

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 300));

    // Should still have called updateFn without crashing
    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

test("watcher handles updateFn exception gracefully", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    throw new Error("connection refused");
  };

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  try {
    await Bun.write(join(tempDir, "test.md"), "# Test");

    // Wait for debounce + processing — should not crash
    await new Promise((r) => setTimeout(r, 300));

    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

test("watcher detects changes in subdirectories", async () => {
  let updateCalls = 0;
  const mockUpdate = async (): Promise<UpdateResult> => {
    updateCalls++;
    return MOCK_UPDATE_RESULT;
  };

  // Create a subdirectory (simulating type directories like notes/)
  const subDir = join(tempDir, "notes");
  await Bun.write(join(subDir, ".keep"), "");

  const handle = startWatcher({
    dataPath: tempDir,
    debounceMs: 100,
    updateFn: mockUpdate,
  });

  try {
    // Write a .md file inside a subdirectory
    await Bun.write(join(subDir, "my_note.md"), "# My Note");

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 300));

    expect(updateCalls).toBe(1);
  } finally {
    handle.stop();
  }
});

import { test, expect, describe, afterEach } from "bun:test";
import {
  update,
  collectionAdd,
  status,
  setSpawn,
  type SpawnFn,
} from "./index";

function mockSpawn(
  overrides: Partial<{ exitCode: number; stdout: string; stderr: string }> = {}
): { spy: SpawnFn & { calls: string[][] }; restore: () => void } {
  const calls: string[][] = [];
  const fn: SpawnFn & { calls: string[][] } = async (cmd) => {
    calls.push(cmd);
    return {
      exitCode: overrides.exitCode ?? 0,
      stdout: overrides.stdout ?? "",
      stderr: overrides.stderr ?? "",
    };
  };
  fn.calls = calls;
  const restore = setSpawn(fn);
  return { spy: fn, restore };
}

function mockSpawnThrow(errorMessage: string) {
  const restore = setSpawn(async () => {
    throw new Error(errorMessage);
  });
  return { restore };
}

describe("qmd-client", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  // ─── update() ─────────────────────────────────────────────

  describe("update()", () => {
    test("calls qmd update and returns success", async () => {
      const { spy, restore: r } = mockSpawn();
      restore = r;
      const result = await update();
      expect(result).toEqual({ success: true });
      expect(spy.calls).toEqual([["qmd", "update"]]);
    });

    test("returns error on non-zero exit code", async () => {
      const { spy: _, restore: r } = mockSpawn({
        exitCode: 1,
        stderr: "index locked",
      });
      restore = r;
      const result = await update();
      expect(result.success).toBe(false);
      expect(result.error).toBe("index locked");
    });

    test("returns exit code message when stderr is empty", async () => {
      const { restore: r } = mockSpawn({ exitCode: 2, stderr: "" });
      restore = r;
      const result = await update();
      expect(result.success).toBe(false);
      expect(result.error).toBe("qmd update exited with code 2");
    });

    test("handles spawn failure gracefully", async () => {
      const { restore: r } = mockSpawnThrow("qmd not found");
      restore = r;
      const result = await update();
      expect(result.success).toBe(false);
      expect(result.error).toContain("qmd not found");
    });
  });

  // ─── collectionAdd() ─────────────────────────────────────

  describe("collectionAdd()", () => {
    test("calls qmd collection add with correct args", async () => {
      const { spy, restore: r } = mockSpawn();
      restore = r;
      const result = await collectionAdd("/data/notes", "my-notes");
      expect(result).toEqual({ success: true });
      expect(spy.calls).toEqual([
        ["qmd", "collection", "add", "/data/notes", "--name", "my-notes"],
      ]);
    });

    test("returns error on non-zero exit code", async () => {
      const { restore: r } = mockSpawn({
        exitCode: 1,
        stderr: "collection already exists",
      });
      restore = r;
      const result = await collectionAdd("/data", "test");
      expect(result.success).toBe(false);
      expect(result.error).toBe("collection already exists");
    });

    test("returns exit code message when stderr is empty", async () => {
      const { restore: r } = mockSpawn({ exitCode: 3, stderr: "  " });
      restore = r;
      const result = await collectionAdd("/data", "test");
      expect(result.success).toBe(false);
      // stderr is whitespace-only, so falls back to exit code message
      expect(result.error).toBe("qmd collection add exited with code 3");
    });

    test("handles spawn failure gracefully", async () => {
      const { restore: r } = mockSpawnThrow("permission denied");
      restore = r;
      const result = await collectionAdd("/data", "test");
      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });
  });

  // ─── status() ─────────────────────────────────────────────

  describe("status()", () => {
    test("calls qmd status and returns online", async () => {
      const { spy, restore: r } = mockSpawn({ stdout: "QMD is running" });
      restore = r;
      const result = await status();
      expect(result).toEqual({ online: true });
      expect(spy.calls).toEqual([["qmd", "status"]]);
    });

    test("returns offline on non-zero exit code", async () => {
      const { restore: r } = mockSpawn({
        exitCode: 1,
        stderr: "daemon not running",
      });
      restore = r;
      const result = await status();
      expect(result.online).toBe(false);
      expect(result.error).toBe("daemon not running");
    });

    test("returns exit code message when stderr is empty", async () => {
      const { restore: r } = mockSpawn({ exitCode: 127, stderr: "" });
      restore = r;
      const result = await status();
      expect(result.online).toBe(false);
      expect(result.error).toBe("qmd status exited with code 127");
    });

    test("handles spawn failure gracefully (binary not found)", async () => {
      const { restore: r } = mockSpawnThrow(
        "Failed to spawn \"qmd\": No such file"
      );
      restore = r;
      const result = await status();
      expect(result.online).toBe(false);
      expect(result.error).toContain("Failed to spawn");
    });
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the utility functions by setting KORE_HOME to a temp directory
// and importing the modules fresh via dynamic import isn't easy with Bun,
// so we test the logic directly.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kore-pid-test-"));
  process.env.KORE_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.KORE_HOME;
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// Direct imports — KORE_HOME is read at call time via resolveKoreHome()
import {
  pidFilePath,
  readPidFile,
  writePidFile,
  deletePidFile,
  isProcessAlive,
} from "../src/utils/pid.ts";

describe("pidFilePath", () => {
  test("returns path under KORE_HOME", () => {
    const path = pidFilePath();
    expect(path).toBe(join(tmpDir, ".kore.pid"));
  });
});

describe("writePidFile / readPidFile roundtrip", () => {
  test("writes and reads back the same PID", () => {
    writePidFile(12345);
    const pid = readPidFile();
    expect(pid).toBe(12345);
  });

  test("file contains only the PID as text", () => {
    writePidFile(99999);
    const raw = readFileSync(join(tmpDir, ".kore.pid"), "utf-8");
    expect(raw.trim()).toBe("99999");
  });

  test("overwrites previous PID file", () => {
    writePidFile(111);
    writePidFile(222);
    expect(readPidFile()).toBe(222);
  });
});

describe("readPidFile", () => {
  test("returns null when file is missing", () => {
    expect(readPidFile()).toBeNull();
  });

  test("returns null when file contains non-numeric content", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "not-a-number\n");
    expect(readPidFile()).toBeNull();
  });

  test("returns null when file contains zero", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "0\n");
    expect(readPidFile()).toBeNull();
  });

  test("returns null when file contains negative number", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "-1\n");
    expect(readPidFile()).toBeNull();
  });

  test("returns null when file is empty", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "");
    expect(readPidFile()).toBeNull();
  });

  test("handles PID with whitespace padding", () => {
    writeFileSync(join(tmpDir, ".kore.pid"), "  42  \n");
    expect(readPidFile()).toBe(42);
  });
});

describe("deletePidFile", () => {
  test("removes existing PID file", () => {
    writePidFile(12345);
    expect(existsSync(join(tmpDir, ".kore.pid"))).toBe(true);
    deletePidFile();
    expect(existsSync(join(tmpDir, ".kore.pid"))).toBe(false);
  });

  test("does not throw when file is already missing", () => {
    expect(() => deletePidFile()).not.toThrow();
  });
});

describe("isProcessAlive", () => {
  test("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for a non-existent PID", () => {
    // PID 2147483647 is unlikely to exist
    expect(isProcessAlive(2147483647)).toBe(false);
  });
});

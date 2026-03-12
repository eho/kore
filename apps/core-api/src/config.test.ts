import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

// Save original env to restore after each test
let originalKoreHome: string | undefined;

beforeEach(() => {
  originalKoreHome = process.env.KORE_HOME;
  delete process.env.KORE_HOME;
});

afterEach(() => {
  if (originalKoreHome === undefined) {
    delete process.env.KORE_HOME;
  } else {
    process.env.KORE_HOME = originalKoreHome;
  }
});

// Re-import functions fresh per test by importing module-level after env setup.
// Since bun caches modules, we import once and rely on env reads at call time.
import {
  resolveKoreHome,
  resolveDataPath,
  resolveQueueDbPath,
  resolveQmdDbPath,
} from "./config";

describe("resolveKoreHome()", () => {
  test("defaults to ~/.kore when KORE_HOME is not set", () => {
    const result = resolveKoreHome();
    expect(result).toBe(join(homedir(), ".kore"));
  });

  test("uses KORE_HOME env var when set to an absolute path", () => {
    process.env.KORE_HOME = "/custom/kore";
    expect(resolveKoreHome()).toBe("/custom/kore");
  });

  test("expands tilde in KORE_HOME env var", () => {
    process.env.KORE_HOME = "~/.my-kore";
    expect(resolveKoreHome()).toBe(join(homedir(), ".my-kore"));
  });

  test("expands bare ~ to homedir", () => {
    process.env.KORE_HOME = "~";
    expect(resolveKoreHome()).toBe(homedir());
  });
});

describe("resolveDataPath()", () => {
  test("returns $KORE_HOME/data by default", () => {
    expect(resolveDataPath()).toBe(join(homedir(), ".kore", "data"));
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveDataPath()).toBe("/opt/kore/data");
  });
});

describe("resolveQueueDbPath()", () => {
  test("returns $KORE_HOME/db/kore-queue.db by default", () => {
    expect(resolveQueueDbPath()).toBe(
      join(homedir(), ".kore", "db", "kore-queue.db"),
    );
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveQueueDbPath()).toBe("/opt/kore/db/kore-queue.db");
  });
});

describe("resolveQmdDbPath()", () => {
  test("returns $KORE_HOME/db/qmd.sqlite by default", () => {
    expect(resolveQmdDbPath()).toBe(
      join(homedir(), ".kore", "db", "qmd.sqlite"),
    );
  });

  test("derives from custom KORE_HOME", () => {
    process.env.KORE_HOME = "/opt/kore";
    expect(resolveQmdDbPath()).toBe("/opt/kore/db/qmd.sqlite");
  });
});

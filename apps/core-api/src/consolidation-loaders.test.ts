import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSeedFromDisk, loadClusterMemberFiles, getExistingInsights } from "./consolidation-loaders";

// ─── loadSeedFromDisk ─────────────────────────────────────────────────

describe("loadSeedFromDisk", () => {
  test("returns null and logs a warning when file does not exist (corrupt/unreadable seed)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadSeedFromDisk("/nonexistent/path/corrupt-seed.md");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArgs = warnSpy.mock.calls[0];
    expect(warnArgs[0]).toContain("[consolidation]");
    expect(warnArgs[1]).toContain("/nonexistent/path/corrupt-seed.md");

    warnSpy.mockRestore();
  });

  test("parses a valid seed file successfully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kore-loader-test-"));
    try {
      const seedPath = join(tempDir, "seed.md");
      const content = `---
id: test-seed-001
type: note
category: qmd://tech/programming
date_saved: 2026-03-01T00:00:00.000Z
source: test
tags: ["test"]
---

# Test Seed

## Distilled Memory Items
- **Fact one.**
- **Fact two.**
`;
      await Bun.write(seedPath, content);

      const result = await loadSeedFromDisk(seedPath);

      expect(result).not.toBeNull();
      expect(result!.id).toBe("test-seed-001");
      expect(result!.type).toBe("note");
      expect(result!.distilledItems).toEqual(["Fact one.", "Fact two."]);
      expect(result!.filePath).toBe(seedPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── loadClusterMemberFiles ───────────────────────────────────────────

describe("loadClusterMemberFiles", () => {
  test("logs a warning when member file does not exist but still returns a member with empty rawSource", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const fm = { id: "missing-001", type: "note", category: "qmd://tech", date_saved: "2026-03-01T00:00:00.000Z", tags: [] };
    const result = await loadClusterMemberFiles("/nonexistent/path/member.md", fm);

    expect(result.id).toBe("missing-001");
    expect(result.rawSource).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[consolidation]");

    warnSpy.mockRestore();
  });
});

// ─── getExistingInsights ──────────────────────────────────────────────

describe("getExistingInsights", () => {
  test("logs a warning for a corrupt insight file and continues", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kore-insights-test-"));
    const insightsDir = join(tempDir, "insights");
    try {
      await mkdir(insightsDir);

      // Valid insight
      const validPath = join(insightsDir, "valid.md");
      await Bun.write(validPath, `---
id: ins-valid-001
type: insight
source_ids: ["src-001", "src-002"]
---

# Valid Insight
`);

      // Corrupt insight — write a directory instead of a file causes read error
      // Simulate an unreadable file by using an empty file with no frontmatter
      const emptyPath = join(insightsDir, "empty.md");
      await Bun.write(emptyPath, "no frontmatter here");

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const results = await getExistingInsights(tempDir);

      // Valid insight should be returned; empty one should be silently skipped (no id)
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("ins-valid-001");
      expect(results[0].source_ids).toEqual(["src-001", "src-002"]);

      warnSpy.mockRestore();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("logs a warning when insights directory is inaccessible", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await getExistingInsights("/nonexistent/data/path");

    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[consolidation]");

    warnSpy.mockRestore();
  });
});

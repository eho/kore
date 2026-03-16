import { describe, test, expect, afterEach } from "bun:test";
import { syncNotes, type SyncManifest } from "@kore/an-export";
import { buildIngestContent } from "../content-builder";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB_DIR = resolve(
  import.meta.dir,
  "../../../e2e/notes-testdata/group.com.apple.notes",
);

let tmpDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kore-integration-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("Apple Notes integration (real database)", () => {
  test("syncNotes exports notes from test database", async () => {
    const dest = await createTempDir();

    const result = await syncNotes({
      dest,
      omitFirstLine: false,
      includeTrashed: false,
      includeHandwriting: false,
      dbDir: TEST_DB_DIR,
    });

    expect(result.exported).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);

    // Verify manifest was created
    const manifestFile = Bun.file(join(dest, "an-export-manifest.json"));
    expect(await manifestFile.exists()).toBe(true);

    const manifest: SyncManifest = await manifestFile.json();
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.notes).length).toBeGreaterThan(0);
  });

  test("full sync cycle: export, build content, verify output structure", async () => {
    const dest = await createTempDir();

    await syncNotes({
      dest,
      omitFirstLine: false,
      includeTrashed: false,
      includeHandwriting: false,
      dbDir: TEST_DB_DIR,
    });

    const manifestFile = Bun.file(join(dest, "an-export-manifest.json"));
    const manifest: SyncManifest = await manifestFile.json();

    const entries = Object.values(manifest.notes);
    expect(entries.length).toBeGreaterThan(0);

    // Process each exported note through the content builder
    let processedCount = 0;
    for (const entry of entries) {
      const absolutePath = join(dest, entry.path);
      const relativePath = `notes/${entry.path}`;

      const content = await buildIngestContent(absolutePath, relativePath);
      if (!content) continue; // empty files are skipped

      processedCount++;

      // Verify output structure
      const lines = content.split("\n");

      // Content should contain meaningful text
      expect(content.trim().length).toBeGreaterThan(0);

      // If the note has a # heading, content builder should extract it as Title:
      const hasHeading = content.match(/^#\s+.+$/m);
      if (hasHeading) {
        const titleLine = lines.find((l) => l.startsWith("Title:"));
        expect(titleLine).toBeDefined();
      }

      // If the note is in a folder (has path segments), should have folder prefix
      const segments = entry.path.split("/");
      if (segments.length > 1) {
        const folderLine = lines.find((l) => l.startsWith("Apple Notes Folder:"));
        expect(folderLine).toBeDefined();
      }

      // Content should not exceed 8000 characters
      expect(content.length).toBeLessThanOrEqual(8000);
    }

    expect(processedCount).toBeGreaterThan(0);
  });

  test("folder path extraction for nested folders", async () => {
    const dest = await createTempDir();

    await syncNotes({
      dest,
      omitFirstLine: false,
      includeTrashed: false,
      includeHandwriting: false,
      dbDir: TEST_DB_DIR,
    });

    const manifestFile = Bun.file(join(dest, "an-export-manifest.json"));
    const manifest: SyncManifest = await manifestFile.json();

    // Find notes that are in nested folders (path has 2+ directory segments)
    const nestedNotes = Object.values(manifest.notes).filter(
      (entry) => entry.path.split("/").length > 2,
    );

    for (const entry of nestedNotes) {
      const absolutePath = join(dest, entry.path);
      const relativePath = `notes/${entry.path}`;
      const content = await buildIngestContent(absolutePath, relativePath);
      if (!content) continue;

      const folderLine = content.split("\n").find((l) => l.startsWith("Apple Notes Folder:"));
      expect(folderLine).toBeDefined();

      // Nested folder should contain " / " separator
      if (entry.path.split("/").length > 2) {
        expect(folderLine).toContain(" / ");
      }
    }
  });

  test("attachment references are stripped from content", async () => {
    const dest = await createTempDir();

    await syncNotes({
      dest,
      omitFirstLine: false,
      includeTrashed: false,
      includeHandwriting: false,
      dbDir: TEST_DB_DIR,
    });

    const manifestFile = Bun.file(join(dest, "an-export-manifest.json"));
    const manifest: SyncManifest = await manifestFile.json();

    for (const entry of Object.values(manifest.notes)) {
      const absolutePath = join(dest, entry.path);
      const relativePath = `notes/${entry.path}`;
      const content = await buildIngestContent(absolutePath, relativePath);
      if (!content) continue;

      // No raw local attachment references should remain
      expect(content).not.toMatch(/!\[.*?\]\(\.\.\/attachments\//);

      // If the original had attachments, they should be replaced with [Attachment: ...]
      // (We can't guarantee the test DB has attachments, but we verify the pattern doesn't leak)
    }
  });
});

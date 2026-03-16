/**
 * Integration tests for the Apple Notes plugin content pipeline.
 *
 * Uses version-controlled fixture files that mirror real an-export output,
 * so no database access or Full Disk Access is required.
 *
 * Fixture layout (packages/plugin-apple-notes/__tests__/fixtures/notes/):
 *   an-export-manifest.json   — manifest as produced by an-export
 *   Shopping List.md          — root-level note
 *   Tasks/Learning Roadmap.md — single-folder note
 *   Recipes/Baking/Chocolate Cake.md — nested-folder note with attachment
 *   Empty Note.md             — empty note (should be skipped)
 */
import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { buildIngestContent } from "../content-builder";
import type { SyncManifest } from "@kore/an-export";

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures/notes");

async function loadManifest(): Promise<SyncManifest> {
  return Bun.file(join(FIXTURES_DIR, "an-export-manifest.json")).json();
}

describe("content pipeline (fixture-based)", () => {
  test("root-level note: no folder prefix, correct title", async () => {
    const manifest = await loadManifest();
    const entry = manifest.notes[2]!;

    const content = await buildIngestContent(
      join(FIXTURES_DIR, entry.path),
      `notes/${entry.path}`,
      entry.title,
    );

    expect(content).not.toBeNull();
    expect(content).toContain("Title: Shopping List");
    expect(content).not.toContain("Apple Notes Folder:");
    expect(content).toContain("Milk");
  });

  test("single-folder note: folder prefix and title prepended", async () => {
    const manifest = await loadManifest();
    const entry = manifest.notes[3]!;

    const content = await buildIngestContent(
      join(FIXTURES_DIR, entry.path),
      `notes/${entry.path}`,
      entry.title,
    );

    expect(content).not.toBeNull();
    expect(content).toContain("Apple Notes Folder: Tasks");
    expect(content).toContain("Title: Learning Roadmap");
    expect(content).toContain("Andrew Ng");
  });

  test("nested-folder note: multi-level folder prefix and attachment stripped", async () => {
    const manifest = await loadManifest();
    const entry = manifest.notes[4]!;

    const content = await buildIngestContent(
      join(FIXTURES_DIR, entry.path),
      `notes/${entry.path}`,
      entry.title,
    );

    expect(content).not.toBeNull();
    expect(content).toContain("Apple Notes Folder: Recipes / Baking");
    expect(content).toContain("Title: Chocolate Cake");
    expect(content).not.toMatch(/!\[.*?\]\(\.\.\/attachments\//);
    expect(content).toContain("[Attachment: cake-photo.jpg]");
    expect(content).toContain("cafedelites.com");
  });

  test("empty note: returns null and is skipped", async () => {
    const manifest = await loadManifest();
    const entry = manifest.notes[5]!;

    const content = await buildIngestContent(
      join(FIXTURES_DIR, entry.path),
      `notes/${entry.path}`,
      entry.title,
    );

    expect(content).toBeNull();
  });

  test("all non-empty notes are within 8000 character limit", async () => {
    const manifest = await loadManifest();

    for (const entry of Object.values(manifest.notes)) {
      const content = await buildIngestContent(
        join(FIXTURES_DIR, entry.path),
        `notes/${entry.path}`,
        entry.title,
      );
      if (content !== null) {
        expect(content.length).toBeLessThanOrEqual(8000);
      }
    }
  });
});

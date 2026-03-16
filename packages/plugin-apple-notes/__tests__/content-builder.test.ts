import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildIngestContent,
  extractFolderHierarchy,
  extractTitle,
  stripLocalAttachments,
} from "../content-builder";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kore-content-builder-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeNote(filename: string, content: string): Promise<string> {
  const filePath = join(tempDir, filename);
  await Bun.write(filePath, content);
  return filePath;
}

// --- extractFolderHierarchy ---

describe("extractFolderHierarchy", () => {
  test("extracts folder hierarchy from nested path", () => {
    expect(extractFolderHierarchy("notes/Work/Projects/Q1 Planning.md")).toBe(
      "Work / Projects",
    );
  });

  test("extracts single folder", () => {
    expect(extractFolderHierarchy("notes/Personal/Shopping List.md")).toBe(
      "Personal",
    );
  });

  test("returns null for root-level note", () => {
    expect(extractFolderHierarchy("notes/My Note.md")).toBeNull();
  });

  test("handles deeply nested folders", () => {
    expect(
      extractFolderHierarchy("notes/Work/Engineering/Backend/API Design.md"),
    ).toBe("Work / Engineering / Backend");
  });
});

// --- extractTitle ---

describe("extractTitle", () => {
  test("extracts title from first heading", () => {
    expect(extractTitle("# My Great Note\n\nSome content")).toBe(
      "My Great Note",
    );
  });

  test("extracts title from heading not on first line", () => {
    expect(extractTitle("Some preamble\n\n# The Title\n\nBody")).toBe(
      "The Title",
    );
  });

  test("returns null when no heading found", () => {
    expect(extractTitle("Just some text\nwithout headings")).toBeNull();
  });

  test("does not match ## headings", () => {
    expect(extractTitle("## Subheading\n\nContent")).toBeNull();
  });

  test("trims whitespace from title", () => {
    expect(extractTitle("#   Padded Title   \n\nContent")).toBe("Padded Title");
  });
});

// --- stripLocalAttachments ---

describe("stripLocalAttachments", () => {
  test("replaces local attachment references", () => {
    const input = "Check this ![photo](../attachments/IMG_1234.jpg) out";
    expect(stripLocalAttachments(input)).toBe(
      "Check this [Attachment: IMG_1234.jpg] out",
    );
  });

  test("handles multiple attachments", () => {
    const input =
      "![](../attachments/a.png) and ![](../attachments/b.pdf)";
    expect(stripLocalAttachments(input)).toBe(
      "[Attachment: a.png] and [Attachment: b.pdf]",
    );
  });

  test("decodes URI-encoded filenames", () => {
    const input = "![](../attachments/My%20Photo%20%231.jpg)";
    expect(stripLocalAttachments(input)).toBe(
      "[Attachment: My Photo #1.jpg]",
    );
  });

  test("preserves URL-based images", () => {
    const input = "![alt](https://example.com/image.png)";
    expect(stripLocalAttachments(input)).toBe(input);
  });

  test("preserves markdown tables", () => {
    const input = "| Col1 | Col2 |\n|------|------|\n| a | b |";
    expect(stripLocalAttachments(input)).toBe(input);
  });

  test("preserves internal links", () => {
    const input = "See [[My Other Note]] for details";
    expect(stripLocalAttachments(input)).toBe(input);
  });

  test("handles attachment with alt text", () => {
    const input = "![my drawing](../attachments/sketch.png)";
    expect(stripLocalAttachments(input)).toBe("[Attachment: sketch.png]");
  });
});

// --- buildIngestContent ---

describe("buildIngestContent", () => {
  test("builds full content with folder and title", async () => {
    const path = await writeNote(
      "note1.md",
      "# Meeting Notes\n\nDiscussed Q1 plans.",
    );
    const result = await buildIngestContent(
      path,
      "notes/Work/Projects/note1.md",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("Apple Notes Folder: Work / Projects");
    expect(result).toContain("Title: Meeting Notes");
    expect(result).toContain("Discussed Q1 plans.");
  });

  test("builds content without folder for root-level note", async () => {
    const path = await writeNote("root.md", "# Root Note\n\nContent here.");
    const result = await buildIngestContent(path, "notes/root.md");

    expect(result).not.toBeNull();
    expect(result).not.toContain("Apple Notes Folder:");
    expect(result).toContain("Title: Root Note");
  });

  test("builds content without title if no heading", async () => {
    const path = await writeNote("notitle.md", "Just some text without heading.");
    const result = await buildIngestContent(path, "notes/notitle.md");

    expect(result).not.toBeNull();
    expect(result).not.toContain("Title:");
    expect(result).toContain("Just some text without heading.");
  });

  test("returns null for empty file", async () => {
    const path = await writeNote("empty.md", "");
    const result = await buildIngestContent(path, "notes/empty.md");
    expect(result).toBeNull();
  });

  test("returns null for whitespace-only file", async () => {
    const path = await writeNote("whitespace.md", "   \n\n  \n  ");
    const result = await buildIngestContent(path, "notes/whitespace.md");
    expect(result).toBeNull();
  });

  test("returns null for unreadable file", async () => {
    const result = await buildIngestContent(
      "/nonexistent/path/file.md",
      "notes/file.md",
    );
    expect(result).toBeNull();
  });

  test("strips local attachments in output", async () => {
    const path = await writeNote(
      "attach.md",
      "# Note\n\n![](../attachments/photo.jpg)\n\nMore text.",
    );
    const result = await buildIngestContent(path, "notes/attach.md");

    expect(result).not.toBeNull();
    expect(result).toContain("[Attachment: photo.jpg]");
    expect(result).not.toContain("../attachments/");
  });

  test("preserves URL-based images in output", async () => {
    const path = await writeNote(
      "urlimg.md",
      "# Note\n\n![alt](https://example.com/img.png)\n\nDone.",
    );
    const result = await buildIngestContent(path, "notes/urlimg.md");

    expect(result).not.toBeNull();
    expect(result).toContain("![alt](https://example.com/img.png)");
  });

  test("truncates content exceeding 8000 characters", async () => {
    const longBody = "x".repeat(9000);
    const path = await writeNote("long.md", `# Long Note\n\n${longBody}`);
    const result = await buildIngestContent(
      path,
      "notes/Work/long.md",
    );

    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(8000);
    expect(result).toContain("[Content truncated for extraction]");
    expect(result).toContain("Apple Notes Folder: Work");
    expect(result).toContain("Title: Long Note");
  });

  test("does not truncate content exactly at 8000 characters", async () => {
    // Create content that is exactly at the limit (no header to keep it simple)
    const body = "a".repeat(7999);
    const path = await writeNote("exact.md", body);
    const result = await buildIngestContent(path, "notes/exact.md");

    expect(result).not.toBeNull();
    expect(result).not.toContain("[Content truncated for extraction]");
  });

  test("preserves markdown tables", async () => {
    const table = "# Data\n\n| Name | Value |\n|------|-------|\n| A | 1 |";
    const path = await writeNote("table.md", table);
    const result = await buildIngestContent(path, "notes/table.md");

    expect(result).toContain("| Name | Value |");
  });

  test("preserves internal links", async () => {
    const path = await writeNote(
      "links.md",
      "# Links\n\nSee [[Other Note]] for more.",
    );
    const result = await buildIngestContent(path, "notes/links.md");

    expect(result).toContain("[[Other Note]]");
  });
});

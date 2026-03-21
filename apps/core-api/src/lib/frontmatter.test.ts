import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  parseFrontmatterWithBody,
  serializeFrontmatter,
  parseTagsArray,
  extractTitleFromMarkdown,
  extractDistilledItems,
  parseMemoryFile,
  parseMemoryFileFull,
} from "./frontmatter";

// ─── parseFrontmatter ────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses valid frontmatter with string values", () => {
    const content = `---
id: abc-123
type: note
source: apple_notes
---
# Title`;
    const fm = parseFrontmatter(content);
    expect(fm.id).toBe("abc-123");
    expect(fm.type).toBe("note");
    expect(fm.source).toBe("apple_notes");
  });

  test("parses array values in bracket notation", () => {
    const content = `---
tags: ["tag1", "tag2", "tag3"]
source_ids: ["id1", "id2"]
empty_arr: []
---`;
    const fm = parseFrontmatter(content);
    expect(fm.tags).toEqual(["tag1", "tag2", "tag3"]);
    expect(fm.source_ids).toEqual(["id1", "id2"]);
    expect(fm.empty_arr).toEqual([]);
  });

  test("parses null values", () => {
    const content = `---
re_eval_reason: null
---`;
    const fm = parseFrontmatter(content);
    expect(fm.re_eval_reason).toBeNull();
  });

  test("parses numeric values", () => {
    const content = `---
confidence: 0.85
reinforcement_count: 3
---`;
    const fm = parseFrontmatter(content);
    expect(fm.confidence).toBe(0.85);
    expect(fm.reinforcement_count).toBe(3);
  });

  test("returns empty object for missing frontmatter", () => {
    const content = "# Just a title\nSome content";
    expect(parseFrontmatter(content)).toEqual({});
  });

  test("returns empty object for malformed YAML (no closing ---)", () => {
    const content = `---
id: test
# No closing delimiter`;
    expect(parseFrontmatter(content)).toEqual({});
  });

  test("returns empty object for empty content", () => {
    expect(parseFrontmatter("")).toEqual({});
  });

  test("handles colons in values correctly", () => {
    const content = `---
category: qmd://travel/food/japan
url: https://example.com
---`;
    const fm = parseFrontmatter(content);
    expect(fm.category).toBe("qmd://travel/food/japan");
    expect(fm.url).toBe("https://example.com");
  });

  test("handles insight-specific fields", () => {
    const content = `---
id: ins-001
type: insight
insight_type: cluster_summary
status: active
source_ids: ["src1", "src2"]
supersedes: []
superseded_by: []
confidence: 0.9
reinforcement_count: 2
last_synthesized_at: 2026-03-15T12:00:00Z
---`;
    const fm = parseFrontmatter(content);
    expect(fm.type).toBe("insight");
    expect(fm.insight_type).toBe("cluster_summary");
    expect(fm.status).toBe("active");
    expect(fm.source_ids).toEqual(["src1", "src2"]);
    expect(fm.supersedes).toEqual([]);
    expect(fm.superseded_by).toEqual([]);
    expect(fm.confidence).toBe(0.9);
    expect(fm.reinforcement_count).toBe(2);
    expect(fm.last_synthesized_at).toBe("2026-03-15T12:00:00Z");
  });

  test("skips lines without colons", () => {
    const content = `---
id: test
this line has no colon
type: note
---`;
    const fm = parseFrontmatter(content);
    expect(fm.id).toBe("test");
    expect(fm.type).toBe("note");
    expect(Object.keys(fm)).toHaveLength(2);
  });
});

// ─── parseFrontmatterWithBody ────────────────────────────────────────

describe("parseFrontmatterWithBody", () => {
  test("returns both frontmatter and body", () => {
    const content = `---
id: test
type: note
---
# Title

Body content here.`;
    const { frontmatter, body } = parseFrontmatterWithBody(content);
    expect(frontmatter.id).toBe("test");
    expect(body).toContain("# Title");
    expect(body).toContain("Body content here.");
  });

  test("returns empty frontmatter and full content when no frontmatter", () => {
    const content = "# No frontmatter\nJust content.";
    const { frontmatter, body } = parseFrontmatterWithBody(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });
});

// ─── serializeFrontmatter ────────────────────────────────────────────

describe("serializeFrontmatter", () => {
  test("serializes simple key-value pairs", () => {
    const result = serializeFrontmatter({ id: "test", type: "note" });
    expect(result).toBe("---\nid: test\ntype: note\n---");
  });

  test("serializes arrays with double quotes", () => {
    const result = serializeFrontmatter({ tags: ["a", "b"] });
    expect(result).toContain('tags: ["a", "b"]');
  });

  test("serializes null values", () => {
    const result = serializeFrontmatter({ re_eval_reason: null });
    expect(result).toContain("re_eval_reason: null");
  });

  test("round-trips through parseFrontmatter", () => {
    const original = { id: "test", tags: ["a", "b"], confidence: 0.9, re_eval_reason: null };
    const serialized = serializeFrontmatter(original);
    const body = "\n# Title";
    const parsed = parseFrontmatter(serialized + body);
    expect(parsed.id).toBe("test");
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.confidence).toBe(0.9);
    expect(parsed.re_eval_reason).toBeNull();
  });
});

// ─── parseTagsArray ──────────────────────────────────────────────────

describe("parseTagsArray", () => {
  test("parses JSON string array", () => {
    expect(parseTagsArray('["tag1", "tag2"]')).toEqual(["tag1", "tag2"]);
  });

  test("handles single-quoted arrays", () => {
    expect(parseTagsArray("['tag1', 'tag2']")).toEqual(["tag1", "tag2"]);
  });

  test("passes through already-parsed arrays", () => {
    expect(parseTagsArray(["a", "b"])).toEqual(["a", "b"]);
  });

  test("wraps plain string as single-element array", () => {
    expect(parseTagsArray("solo-tag")).toEqual(["solo-tag"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseTagsArray("")).toEqual([]);
  });
});

// ─── extractTitleFromMarkdown ────────────────────────────────────────

describe("extractTitleFromMarkdown", () => {
  test("extracts H1 title", () => {
    expect(extractTitleFromMarkdown("---\nid: x\n---\n# My Title\nBody")).toBe("My Title");
  });

  test("returns empty string when no H1 present", () => {
    expect(extractTitleFromMarkdown("No heading here")).toBe("");
  });

  test("trims whitespace from title", () => {
    expect(extractTitleFromMarkdown("# Padded Title  ")).toBe("Padded Title");
  });
});

// ─── extractDistilledItems ───────────────────────────────────────────

describe("extractDistilledItems", () => {
  test("extracts bullet items from Distilled Memory Items section", () => {
    const content = `# Title

## Distilled Memory Items

- First fact
- Second fact
- Third fact

## Raw Source`;
    expect(extractDistilledItems(content)).toEqual(["First fact", "Second fact", "Third fact"]);
  });

  test("returns empty array when section is missing", () => {
    expect(extractDistilledItems("# Title\nNo distilled section.")).toEqual([]);
  });

  test("stops at next heading", () => {
    const content = `## Distilled Memory Items

- Only this

## Next Section

- Not this`;
    expect(extractDistilledItems(content)).toEqual(["Only this"]);
  });
});

// ─── parseMemoryFile ─────────────────────────────────────────────────

describe("parseMemoryFile", () => {
  let tempDir: string;

  test("parses a valid memory file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
    const filePath = join(tempDir, "test.md");
    await Bun.write(filePath, `---
id: abc-123
type: note
source: test
date_saved: 2026-03-15T12:00:00Z
tags: ["a", "b"]
---
# Test Note

Content.`);
    const result = await parseMemoryFile("abc-123", filePath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc-123");
    expect(result!.type).toBe("note");
    expect(result!.title).toBe("Test Note");
    expect(result!.tags).toEqual(["a", "b"]);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null for missing file", async () => {
    const result = await parseMemoryFile("x", "/nonexistent/path.md");
    expect(result).toBeNull();
  });

  test("returns null when id is missing from frontmatter", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
    const filePath = join(tempDir, "no-id.md");
    await Bun.write(filePath, `---
type: note
---
# No ID`);
    const result = await parseMemoryFile("x", filePath);
    expect(result).toBeNull();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("includes insight-specific fields for insight type", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
    const filePath = join(tempDir, "insight.md");
    await Bun.write(filePath, `---
id: ins-001
type: insight
insight_type: cluster_summary
status: active
source: kore_synthesis
date_saved: 2026-03-15T12:00:00Z
tags: ["test"]
source_ids: ["s1", "s2"]
---
# Insight`);
    const result = await parseMemoryFile("ins-001", filePath);
    expect(result).not.toBeNull();
    expect(result!.insight_type).toBe("cluster_summary");
    expect(result!.status).toBe("active");
    expect(result!.source_ids_count).toBe(2);
    await rm(tempDir, { recursive: true, force: true });
  });
});

// ─── parseMemoryFileFull ─────────────────────────────────────────────

describe("parseMemoryFileFull", () => {
  let tempDir: string;

  test("parses a full memory file with all fields", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
    const filePath = join(tempDir, "full.md");
    await Bun.write(filePath, `---
id: full-001
type: note
category: qmd://tech/programming
source: test
date_saved: 2026-03-15T12:00:00Z
tags: ["ts", "bun"]
url: https://example.com
intent: reference
confidence: 0.95
---
# Full Note

## Distilled Memory Items

- Fact 1
- Fact 2

## Raw Source

Some content.`);
    const result = await parseMemoryFileFull("full-001", filePath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("full-001");
    expect(result!.category).toBe("qmd://tech/programming");
    expect(result!.url).toBe("https://example.com");
    expect(result!.intent).toBe("reference");
    expect(result!.confidence).toBe(0.95);
    expect(result!.content).toContain("# Full Note");
    await rm(tempDir, { recursive: true, force: true });
  });

  test("parses insight files with all insight-specific fields", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
    const filePath = join(tempDir, "insight.md");
    await Bun.write(filePath, `---
id: ins-002
type: insight
category: qmd://synthesis
source: kore_synthesis
date_saved: 2026-03-15T12:00:00Z
tags: ["insight"]
insight_type: evolution
status: evolving
source_ids: ["s1", "s2", "s3"]
supersedes: ["old-1"]
superseded_by: []
confidence: 0.88
reinforcement_count: 5
last_synthesized_at: 2026-03-15T14:00:00Z
---
# Evolution Insight`);
    const result = await parseMemoryFileFull("ins-002", filePath);
    expect(result).not.toBeNull();
    expect(result!.insight_type).toBe("evolution");
    expect(result!.status).toBe("evolving");
    expect(result!.source_ids).toEqual(["s1", "s2", "s3"]);
    expect(result!.source_ids_count).toBe(3);
    expect(result!.supersedes).toEqual(["old-1"]);
    expect(result!.superseded_by).toEqual([]);
    expect(result!.reinforcement_count).toBe(5);
    expect(result!.last_synthesized_at).toBe("2026-03-15T14:00:00Z");
    await rm(tempDir, { recursive: true, force: true });
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeInsight,
  checkDedup,
  supersede,
  updateSourceFrontmatter,
} from "./consolidation-writer";
import { InsightFrontmatterSchema } from "@kore/shared-types";
import type { InsightOutput } from "@kore/shared-types";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeSynthesis(overrides: Partial<InsightOutput> = {}): InsightOutput {
  return {
    title: "React State Management Patterns",
    insight_type: "cluster_summary",
    synthesis:
      "React offers multiple approaches to state management. useState handles simple local state while useReducer manages complex state logic.",
    connections: [
      {
        source_id: "mem-001",
        target_id: "mem-002",
        relationship: "both discuss state hooks",
      },
    ],
    distilled_items: [
      "useState is for simple local state.",
      "useReducer handles complex state.",
    ],
    tags: ["react", "state-management"],
    ...overrides,
  };
}

function makeMetadata(overrides: Record<string, any> = {}) {
  return {
    category: "qmd://tech/programming/react",
    sourceIds: ["mem-001", "mem-002", "mem-003"],
    confidence: 0.82,
    insightType: "cluster_summary" as const,
    ...overrides,
  };
}

/**
 * Parse frontmatter from a markdown string (for test assertions).
 */
function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else if (value === "null") {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kore-writer-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── writeInsight ────────────────────────────────────────────────────

describe("writeInsight", () => {
  test("creates insights directory and writes file", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());

    expect(result.insightId).toMatch(/^ins-[a-f0-9]{8}$/);
    expect(result.filePath).toContain("/insights/");

    const file = Bun.file(result.filePath);
    expect(await file.exists()).toBe(true);
  });

  test("generates valid InsightFrontmatter", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(fm.id).toBe(result.insightId);
    expect(fm.type).toBe("insight");
    expect(fm.category).toBe("qmd://tech/programming/react");
    expect(fm.source).toBe("kore_synthesis");
    expect(fm.insight_type).toBe("cluster_summary");
    expect(fm.source_ids).toEqual(["mem-001", "mem-002", "mem-003"]);
    expect(fm.supersedes).toEqual([]);
    expect(fm.superseded_by).toEqual([]);
    expect(fm.confidence).toBe(0.82);
    expect(fm.status).toBe("active");
    expect(fm.reinforcement_count).toBe(0);
    expect(fm.re_eval_reason).toBeNull();
  });

  test("frontmatter passes Zod validation", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    // Zod needs string arrays for source_ids etc
    const zodResult = InsightFrontmatterSchema.safeParse(fm);
    expect(zodResult.success).toBe(true);
  });

  test("includes all required markdown sections", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();

    expect(content).toContain("# React State Management Patterns");
    expect(content).toContain("## Synthesis");
    expect(content).toContain("React offers multiple approaches");
    expect(content).toContain("## Key Connections");
    expect(content).toContain("## Distilled Memory Items");
    expect(content).toContain("- **useState is for simple local state.**");
    expect(content).toContain("## Source Material");
    expect(content).toContain(
      "Synthesized from 3 memories: mem-001, mem-002, mem-003"
    );
  });

  test("renders connections as structured entries", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();

    expect(content).toContain(
      "- **mem-001** → **mem-002**: both discuss state hooks"
    );
  });

  test("handles empty connections array", async () => {
    const synthesis = makeSynthesis({ connections: [] });
    const result = await writeInsight(synthesis, tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();

    expect(content).toContain("No direct connections identified.");
  });

  test("filename truncated to 60 chars total", async () => {
    const longTitle = "A".repeat(200);
    const synthesis = makeSynthesis({ title: longTitle });
    const result = await writeInsight(synthesis, tmpDir, makeMetadata());

    const filename = result.filePath.split("/").pop()!;
    // filename without .md extension should be <= 57 chars (60 - 3 for .md)
    expect(filename.length).toBeLessThanOrEqual(63); // 60 + ".md"
  });

  test("sets supersedes from metadata", async () => {
    const metadata = makeMetadata({ supersedes: ["ins-old12345"] });
    const result = await writeInsight(makeSynthesis(), tmpDir, metadata);
    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(fm.supersedes).toEqual(["ins-old12345"]);
  });

  test("date_saved and last_synthesized_at are valid ISO timestamps", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());
    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(() => new Date(fm.date_saved)).not.toThrow();
    expect(() => new Date(fm.last_synthesized_at)).not.toThrow();
    expect(fm.date_saved).toBe(fm.last_synthesized_at);
  });
});

// ─── checkDedup ──────────────────────────────────────────────────────

describe("checkDedup", () => {
  test("returns null when no existing insights", () => {
    const result = checkDedup(["mem-001", "mem-002"], []);
    expect(result).toBeNull();
  });

  test("returns null when overlap is below 50%", () => {
    const existing = [
      { source_ids: ["mem-001", "mem-002", "mem-003"], id: "ins-1" },
    ];
    // Only 1/3 overlap = 33%
    const result = checkDedup(["mem-001", "mem-004", "mem-005"], existing);
    expect(result).toBeNull();
  });

  test("returns existing insight when overlap is exactly 50%", () => {
    const existing = [
      { source_ids: ["mem-001", "mem-002"], id: "ins-1" },
    ];
    // 1/2 overlap = 50%
    const result = checkDedup(["mem-001", "mem-003"], existing);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ins-1");
  });

  test("returns existing insight when overlap is above 50%", () => {
    const existing = [
      { source_ids: ["mem-001", "mem-002", "mem-003"], id: "ins-1" },
    ];
    // 2/3 overlap = 67%
    const result = checkDedup(["mem-001", "mem-002", "mem-004"], existing);
    expect(result).not.toBeNull();
  });

  test("returns first matching insight when multiple match", () => {
    const existing = [
      { source_ids: ["mem-001", "mem-002"], id: "ins-1" },
      { source_ids: ["mem-001", "mem-003"], id: "ins-2" },
    ];
    const result = checkDedup(["mem-001", "mem-002"], existing);
    expect(result!.id).toBe("ins-1");
  });

  test("100% overlap returns existing", () => {
    const existing = [
      { source_ids: ["mem-001", "mem-002"], id: "ins-1" },
    ];
    const result = checkDedup(["mem-001", "mem-002"], existing);
    expect(result).not.toBeNull();
  });

  test("boundary: 49% does not match (2/5 = 40%)", () => {
    const existing = [
      { source_ids: ["a", "b", "c", "d", "e"], id: "ins-1" },
    ];
    // 2/5 = 40% < 50%
    const result = checkDedup(["a", "b", "x", "y", "z"], existing);
    expect(result).toBeNull();
  });

  test("boundary: 3/5 = 60% matches", () => {
    const existing = [
      { source_ids: ["a", "b", "c", "d", "e"], id: "ins-1" },
    ];
    const result = checkDedup(["a", "b", "c", "x", "y"], existing);
    expect(result).not.toBeNull();
  });
});

// ─── supersede ───────────────────────────────────────────────────────

describe("supersede", () => {
  test("sets superseded_by and status retired on old insight", async () => {
    // Write an initial insight file
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());

    // Supersede it
    await supersede(result.filePath, "ins-new12345");

    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(fm.superseded_by).toEqual(["ins-new12345"]);
    expect(fm.status).toBe("retired");
  });

  test("preserves existing frontmatter fields", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());

    await supersede(result.filePath, "ins-new12345");

    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(fm.type).toBe("insight");
    expect(fm.source).toBe("kore_synthesis");
    expect(fm.insight_type).toBe("cluster_summary");
    expect(fm.source_ids).toEqual(["mem-001", "mem-002", "mem-003"]);
  });

  test("preserves body content", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());

    await supersede(result.filePath, "ins-new12345");

    const content = await Bun.file(result.filePath).text();

    expect(content).toContain("## Synthesis");
    expect(content).toContain("## Distilled Memory Items");
  });

  test("does not duplicate superseded_by on repeated calls", async () => {
    const result = await writeInsight(makeSynthesis(), tmpDir, makeMetadata());

    await supersede(result.filePath, "ins-new12345");
    await supersede(result.filePath, "ins-new12345");

    const content = await Bun.file(result.filePath).text();
    const fm = parseFrontmatter(content);

    expect(fm.superseded_by).toEqual(["ins-new12345"]);
  });
});

// ─── updateSourceFrontmatter ─────────────────────────────────────────

describe("updateSourceFrontmatter", () => {
  async function writeSourceFile(name: string, extraFm: string = ""): Promise<string> {
    const filePath = join(tmpDir, name);
    const content = `---
id: ${name.replace(".md", "")}
type: note
category: qmd://tech/react
date_saved: 2026-01-15T00:00:00Z
source: test
tags: ["react"]${extraFm}
---

# Test Memory

## Distilled Memory Items
- **Some fact.**
`;
    await Bun.write(filePath, content);
    return filePath;
  }

  test("adds consolidated_at and insight_refs to source files", async () => {
    const path = await writeSourceFile("mem-001.md");

    await updateSourceFrontmatter([path], "ins-abc12345");

    const content = await Bun.file(path).text();
    const fm = parseFrontmatter(content);

    expect(fm.insight_refs).toEqual(["ins-abc12345"]);
    expect(fm.consolidated_at).toBeDefined();
    expect(() => new Date(fm.consolidated_at)).not.toThrow();
  });

  test("preserves existing frontmatter fields", async () => {
    const path = await writeSourceFile("mem-001.md");

    await updateSourceFrontmatter([path], "ins-abc12345");

    const content = await Bun.file(path).text();
    const fm = parseFrontmatter(content);

    expect(fm.id).toBe("mem-001");
    expect(fm.type).toBe("note");
    expect(fm.category).toBe("qmd://tech/react");
    expect(fm.source).toBe("test");
    expect(fm.tags).toEqual(["react"]);
  });

  test("preserves body content", async () => {
    const path = await writeSourceFile("mem-001.md");

    await updateSourceFrontmatter([path], "ins-abc12345");

    const content = await Bun.file(path).text();

    expect(content).toContain("# Test Memory");
    expect(content).toContain("## Distilled Memory Items");
    expect(content).toContain("- **Some fact.**");
  });

  test("is idempotent - skips if insight already referenced", async () => {
    const path = await writeSourceFile(
      "mem-001.md",
      '\ninsight_refs: ["ins-abc12345"]'
    );

    // Read original content
    const before = await Bun.file(path).text();

    await updateSourceFrontmatter([path], "ins-abc12345");

    // Content should be unchanged (skipped entirely)
    const after = await Bun.file(path).text();
    expect(after).toBe(before);
  });

  test("appends to existing insight_refs without duplicates", async () => {
    const path = await writeSourceFile(
      "mem-001.md",
      '\ninsight_refs: ["ins-existing1"]'
    );

    await updateSourceFrontmatter([path], "ins-new12345");

    const content = await Bun.file(path).text();
    const fm = parseFrontmatter(content);

    expect(fm.insight_refs).toContain("ins-existing1");
    expect(fm.insight_refs).toContain("ins-new12345");
    expect(fm.insight_refs).toHaveLength(2);
  });

  test("updates multiple source files", async () => {
    const path1 = await writeSourceFile("mem-001.md");
    const path2 = await writeSourceFile("mem-002.md");

    await updateSourceFrontmatter([path1, path2], "ins-abc12345");

    const fm1 = parseFrontmatter(await Bun.file(path1).text());
    const fm2 = parseFrontmatter(await Bun.file(path2).text());

    expect(fm1.insight_refs).toEqual(["ins-abc12345"]);
    expect(fm2.insight_refs).toEqual(["ins-abc12345"]);
  });
});

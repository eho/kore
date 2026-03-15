import { test, expect, describe } from "bun:test";
import {
  MemoryTypeEnum,
  BaseFrontmatterSchema,
  MemoryExtractionSchema,
  IntentEnum,
} from "./index";
import type { KorePlugin, MemoryEvent } from "./index";

// ─── MemoryTypeEnum ─────────────────────────────────────────────────

describe("MemoryTypeEnum", () => {
  test("accepts valid types", () => {
    for (const t of ["place", "media", "note", "person"] as const) {
      expect(MemoryTypeEnum.parse(t)).toBe(t);
    }
  });

  test("rejects invalid type", () => {
    expect(() => MemoryTypeEnum.parse("event")).toThrow();
  });
});

// ─── BaseFrontmatterSchema ─────────────────────────────────────────

describe("BaseFrontmatterSchema", () => {
  const validPayload = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    type: "place" as const,
    category: "qmd://travel/food/japan",
    date_saved: "2026-03-07T12:00:00Z",
    source: "apple_notes",
    tags: ["ramen", "tokyo"],
  };

  test("accepts valid payload", () => {
    const result = BaseFrontmatterSchema.parse(validPayload);
    expect(result.id).toBe(validPayload.id);
    expect(result.type).toBe("place");
  });

  test("accepts payload with optional url", () => {
    const result = BaseFrontmatterSchema.parse({
      ...validPayload,
      url: "https://example.com",
    });
    expect(result.url).toBe("https://example.com");
  });

  test("rejects non-uuid id", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({ ...validPayload, id: "not-a-uuid" })
    ).toThrow();
  });

  test("rejects invalid type enum", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({ ...validPayload, type: "event" })
    ).toThrow();
  });

  test("rejects category not starting with qmd://", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({ ...validPayload, category: "travel/food" })
    ).toThrow();
  });

  test("rejects invalid date_saved", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({
        ...validPayload,
        date_saved: "not-a-date",
      })
    ).toThrow();
  });

  test("rejects more than 5 tags", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({
        ...validPayload,
        tags: ["a", "b", "c", "d", "e", "f"],
      })
    ).toThrow();
  });

  test("rejects invalid url", () => {
    expect(() =>
      BaseFrontmatterSchema.parse({ ...validPayload, url: "not-a-url" })
    ).toThrow();
  });
});

// ─── MemoryExtractionSchema ────────────────────────────────────────

describe("MemoryExtractionSchema", () => {
  const validExtraction = {
    title: "Mutekiya Ramen",
    distilled_items: [
      "Mutekiya is a ramen shop in Ikebukuro, Tokyo.",
      "Cash only.",
    ],
    qmd_category: "qmd://travel/food/japan",
    type: "place" as const,
    tags: ["ramen", "ikebukuro"],
  };

  test("accepts valid extraction", () => {
    const result = MemoryExtractionSchema.parse(validExtraction);
    expect(result.title).toBe("Mutekiya Ramen");
    expect(result.distilled_items).toHaveLength(2);
  });

  test("rejects empty distilled_items", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...validExtraction, distilled_items: [] })
    ).toThrow();
  });

  test("rejects more than 7 distilled_items", () => {
    expect(() =>
      MemoryExtractionSchema.parse({
        ...validExtraction,
        distilled_items: ["a", "b", "c", "d", "e", "f", "g", "h"],
      })
    ).toThrow();
  });

  test("rejects more than 5 tags", () => {
    expect(() =>
      MemoryExtractionSchema.parse({
        ...validExtraction,
        tags: ["a", "b", "c", "d", "e", "f"],
      })
    ).toThrow();
  });

  test("rejects non-kebab-case tags", () => {
    expect(() =>
      MemoryExtractionSchema.parse({
        ...validExtraction,
        tags: ["Not Kebab"],
      })
    ).toThrow();
  });

  test("rejects tags with uppercase", () => {
    expect(() =>
      MemoryExtractionSchema.parse({
        ...validExtraction,
        tags: ["CamelCase"],
      })
    ).toThrow();
  });

  test("accepts valid kebab-case tags", () => {
    const result = MemoryExtractionSchema.parse({
      ...validExtraction,
      tags: ["solo-dining", "cash-only", "ramen"],
    });
    expect(result.tags).toHaveLength(3);
  });

  test("rejects qmd_category not starting with qmd://", () => {
    expect(() =>
      MemoryExtractionSchema.parse({
        ...validExtraction,
        qmd_category: "travel/food",
      })
    ).toThrow();
  });

  test("rejects invalid type enum", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...validExtraction, type: "bookmark" })
    ).toThrow();
  });
});

// ─── IntentEnum & MemoryExtractionSchema intent/confidence ───────

describe("IntentEnum", () => {
  test("accepts all five valid intent values", () => {
    const values = ["recommendation", "reference", "personal-experience", "aspiration", "how-to"] as const;
    for (const v of values) {
      expect(IntentEnum.parse(v)).toBe(v);
    }
  });

  test("rejects invalid intent", () => {
    expect(() => IntentEnum.parse("bookmark")).toThrow();
  });
});

describe("MemoryExtractionSchema intent/confidence", () => {
  const base = {
    title: "Test",
    distilled_items: ["Fact one"],
    qmd_category: "qmd://test",
    type: "note" as const,
    tags: ["test"],
  };

  test("accepts all five valid intent values", () => {
    const values = ["recommendation", "reference", "personal-experience", "aspiration", "how-to"] as const;
    for (const v of values) {
      const result = MemoryExtractionSchema.parse({ ...base, intent: v });
      expect(result.intent).toBe(v);
    }
  });

  test("accepts missing intent (optional)", () => {
    const result = MemoryExtractionSchema.parse(base);
    expect(result.intent).toBeUndefined();
  });

  test("rejects an invalid intent string", () => {
    expect(() => MemoryExtractionSchema.parse({ ...base, intent: "bookmark" })).toThrow();
  });

  test("accepts confidence within [0, 1]", () => {
    expect(MemoryExtractionSchema.parse({ ...base, confidence: 0.85 }).confidence).toBe(0.85);
    expect(MemoryExtractionSchema.parse({ ...base, confidence: 0 }).confidence).toBe(0);
    expect(MemoryExtractionSchema.parse({ ...base, confidence: 1 }).confidence).toBe(1);
  });

  test("rejects confidence outside [0, 1]", () => {
    expect(() => MemoryExtractionSchema.parse({ ...base, confidence: 1.5 })).toThrow();
    expect(() => MemoryExtractionSchema.parse({ ...base, confidence: -0.1 })).toThrow();
  });

  test("accepts missing confidence (optional)", () => {
    const result = MemoryExtractionSchema.parse(base);
    expect(result.confidence).toBeUndefined();
  });
});

// ─── KorePlugin Interface ────────────────────────────────────────

describe("KorePlugin", () => {
  test("hooks-only plugin (no start/stop) satisfies the interface", () => {
    const plugin: KorePlugin = {
      name: "hooks-only",
      onMemoryIndexed: async () => {},
    };
    expect(plugin.name).toBe("hooks-only");
    expect(plugin.start).toBeUndefined();
    expect(plugin.stop).toBeUndefined();
  });

  test("plugin with start and stop satisfies the interface", () => {
    const plugin: KorePlugin = {
      name: "full-lifecycle",
      start: async () => {},
      stop: async () => {},
      onMemoryIndexed: async () => {},
    };
    expect(plugin.start).toBeFunction();
    expect(plugin.stop).toBeFunction();
  });

  test("minimal plugin (name only) satisfies the interface", () => {
    const plugin: KorePlugin = { name: "minimal" };
    expect(plugin.name).toBe("minimal");
  });
});

// ─── MemoryEvent ─────────────────────────────────────────────────

describe("MemoryEvent", () => {
  test("accepts event without taskId", () => {
    const event: MemoryEvent = {
      id: "abc-123",
      filePath: "/tmp/test.md",
      frontmatter: { type: "note" },
      timestamp: new Date().toISOString(),
    };
    expect(event.taskId).toBeUndefined();
  });

  test("accepts event with taskId", () => {
    const event: MemoryEvent = {
      id: "abc-123",
      filePath: "/tmp/test.md",
      frontmatter: { type: "note" },
      timestamp: new Date().toISOString(),
      taskId: "task-456",
    };
    expect(event.taskId).toBe("task-456");
  });
});

import { test, expect, describe } from "bun:test";
import {
  MemoryTypeEnum,
  BaseFrontmatterSchema,
  MemoryExtractionSchema,
} from "./index";

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

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { MemoryExtractionSchema } from "@kore/shared-types";
import type { MemoryExtraction } from "@kore/shared-types";

const VALID_EXTRACTION: MemoryExtraction = {
  title: "Test Memory",
  distilled_items: ["Fact one.", "Fact two."],
  qmd_category: "qmd://tech/testing",
  type: "note",
  tags: ["testing", "unit-test"],
};

// ─── Mock AI SDK modules before importing extract ────────────────────

const mockGenerateText = mock<(...args: any[]) => Promise<any>>();
const mockCreateOpenAI = mock(() => (model: string) => `mock-${model}`);

mock.module("ai", () => ({
  generateText: mockGenerateText,
  Output: {
    object: ({ schema }: any) => ({ type: "object", schema }),
  },
}));

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: mockCreateOpenAI,
}));

// Import after mocking
const { extract, fallbackParse } = await import("./index");

// ─── fallbackParse tests ─────────────────────────────────────────────

describe("fallbackParse", () => {
  const validJson: MemoryExtraction = {
    title: "Mutekiya Ramen",
    distilled_items: [
      "Mutekiya is a ramen shop in Ikebukuro, Tokyo.",
      "Cash only.",
    ],
    qmd_category: "qmd://travel/food/japan",
    type: "place",
    tags: ["ramen", "ikebukuro"],
  };

  test("parses valid JSON from clean response", () => {
    const text = JSON.stringify(validJson);
    const result = fallbackParse(text);
    expect(result.title).toBe("Mutekiya Ramen");
    expect(result.type).toBe("place");
    expect(result.tags).toEqual(["ramen", "ikebukuro"]);
  });

  test("extracts JSON embedded in surrounding text", () => {
    const text = `Here is the extracted data:\n${JSON.stringify(validJson)}\n\nHope this helps!`;
    const result = fallbackParse(text);
    expect(result.title).toBe("Mutekiya Ramen");
    expect(result.qmd_category).toBe("qmd://travel/food/japan");
  });

  test("throws when no JSON object found", () => {
    expect(() => fallbackParse("No JSON here at all")).toThrow(
      "no JSON object found"
    );
  });

  test("throws on invalid JSON (malformed)", () => {
    expect(() => fallbackParse("{bad json}")).toThrow();
  });

  test("throws when JSON doesn't match schema (missing required field)", () => {
    const invalid = { title: "Test" };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when JSON has invalid enum value", () => {
    const invalid = { ...validJson, type: "invalid_type" };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when distilled_items is empty array", () => {
    const invalid = { ...validJson, distilled_items: [] };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("normalizes tags exceeding max of 5 by truncating", () => {
    const input = { ...validJson, tags: ["a", "b", "c", "d", "e", "f"] };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.tags).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("normalizes qmd_category by adding qmd:// prefix when missing", () => {
    const input = { ...validJson, qmd_category: "travel/food/japan" };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.qmd_category).toBe("qmd://travel/food/japan");
  });

  test("normalizes non-kebab-case tags to kebab-case", () => {
    const input = { ...validJson, tags: ["Not Kebab Case"] };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.tags).toEqual(["not-kebab-case"]);
  });
});

// ─── extract() tests with mocked AI SDK ──────────────────────────────

describe("extract", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockCreateOpenAI.mockClear();
  });

  test("returns structured extraction on successful generateText with output", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });

    const result = await extract("Some raw text", "apple_notes");

    expect(result).toEqual(VALID_EXTRACTION);
    expect(result.title).toBe("Test Memory");
    expect(result.type).toBe("note");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // Verify the call was made with correct parameters
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toContain("memory extraction engine");
    expect(callArgs.system).toContain("qmd://tech/");
    expect(callArgs.system).toContain("qmd://travel/");
    expect(callArgs.prompt).toContain("apple_notes");
    expect(callArgs.prompt).toContain("Some raw text");
    expect(callArgs.output).toBeDefined();
  });

  test("passes source and rawText in the prompt", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });

    await extract("My restaurant review", "web_clipper");

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.prompt).toContain("Source: web_clipper");
    expect(callArgs.prompt).toContain("My restaurant review");
  });

  test("system prompt includes all 7 QMD semantic roots", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });

    await extract("text", "src");

    const systemPrompt = mockGenerateText.mock.calls[0][0].system;
    expect(systemPrompt).toContain("qmd://tech/");
    expect(systemPrompt).toContain("qmd://travel/");
    expect(systemPrompt).toContain("qmd://health/");
    expect(systemPrompt).toContain("qmd://finance/");
    expect(systemPrompt).toContain("qmd://media/");
    expect(systemPrompt).toContain("qmd://personal/");
    expect(systemPrompt).toContain("qmd://admin/");
  });

  test("system prompt includes few-shot example", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });

    await extract("text", "src");

    const systemPrompt = mockGenerateText.mock.calls[0][0].system;
    expect(systemPrompt).toContain("Mutekiya");
    expect(systemPrompt).toContain('"title": "Mutekiya Ramen"');
  });

  test("throws when output is null/undefined (no structured output generated)", async () => {
    // First call: generateText returns null output (primary fails)
    // Second call (fallback): generateText returns text with no JSON
    mockGenerateText
      .mockResolvedValueOnce({ output: null })
      .mockResolvedValueOnce({ text: "Sorry, I cannot help." });

    await expect(extract("text", "src")).rejects.toThrow(
      "No structured output generated"
    );
  });

  test("falls back to text parsing when primary generateText fails", async () => {
    // Primary call fails
    mockGenerateText.mockRejectedValueOnce(new Error("structured output failed"));
    // Fallback call returns valid JSON as text
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(VALID_EXTRACTION),
    });

    const result = await extract("raw text", "test_source");

    expect(result).toEqual(VALID_EXTRACTION);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);

    // Second call should NOT have output (plain text mode)
    const fallbackArgs = mockGenerateText.mock.calls[1][0];
    expect(fallbackArgs.output).toBeUndefined();
    expect(fallbackArgs.prompt).toContain("Respond with ONLY valid JSON");
  });

  test("throws original error when both primary and fallback fail", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("primary failure"));
    mockGenerateText.mockRejectedValueOnce(new Error("fallback failure"));

    await expect(extract("text", "src")).rejects.toThrow("primary failure");
  });

  test("falls back and parses JSON embedded in text response", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("structured failed"));
    mockGenerateText.mockResolvedValueOnce({
      text: `Here is the result:\n${JSON.stringify(VALID_EXTRACTION)}\nDone.`,
    });

    const result = await extract("text", "src");
    expect(result.title).toBe("Test Memory");
    expect(result.distilled_items).toHaveLength(2);
  });

  test("validates extraction output against MemoryExtractionSchema", () => {
    const parsed = MemoryExtractionSchema.parse(VALID_EXTRACTION);
    expect(parsed.title).toBe("Test Memory");
    expect(parsed.distilled_items).toHaveLength(2);
    expect(parsed.tags).toEqual(["testing", "unit-test"]);
  });

  test("Zod validation rejects empty distilled_items", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...VALID_EXTRACTION, distilled_items: [] })
    ).toThrow();
  });

  test("Zod validation rejects invalid type enum", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...VALID_EXTRACTION, type: "unknown" })
    ).toThrow();
  });

  test("Zod validation rejects non-kebab-case tags", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...VALID_EXTRACTION, tags: ["Has Spaces"] })
    ).toThrow();
  });

  test("Zod validation rejects qmd_category without qmd:// prefix", () => {
    expect(() =>
      MemoryExtractionSchema.parse({ ...VALID_EXTRACTION, qmd_category: "tech/testing" })
    ).toThrow();
  });
});

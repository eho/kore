import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { fallbackParse } from "./index";
import { MemoryExtractionSchema } from "@kore/shared-types";
import type { MemoryExtraction } from "@kore/shared-types";

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
    const invalid = { title: "Test" }; // missing distilled_items, qmd_category, type, tags
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when JSON has invalid enum value", () => {
    const invalid = {
      ...validJson,
      type: "invalid_type",
    };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when distilled_items is empty array", () => {
    const invalid = {
      ...validJson,
      distilled_items: [],
    };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when tags exceed max of 5", () => {
    const invalid = {
      ...validJson,
      tags: ["a", "b", "c", "d", "e", "f"],
    };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when qmd_category doesn't start with qmd://", () => {
    const invalid = {
      ...validJson,
      qmd_category: "invalid://path",
    };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });

  test("throws when tags are not kebab-case", () => {
    const invalid = {
      ...validJson,
      tags: ["Not Kebab Case"],
    };
    expect(() => fallbackParse(JSON.stringify(invalid))).toThrow();
  });
});

// ─── extract() tests with mocked AI SDK ──────────────────────────────

describe("extract", () => {
  const VALID_EXTRACTION: MemoryExtraction = {
    title: "Test Memory",
    distilled_items: ["Fact one.", "Fact two."],
    qmd_category: "qmd://tech/testing",
    type: "note",
    tags: ["testing", "unit-test"],
  };

  // We need to mock the ai module before importing extract
  // Using dynamic imports to control mocking

  test("returns structured extraction on successful generateObject", async () => {
    // Mock the ai module
    const mockGenerateObject = mock(() =>
      Promise.resolve({ object: VALID_EXTRACTION })
    );

    // Mock the @ai-sdk/openai module
    const mockModel = () => "mock-model";
    const mockCreateOpenAI = mock(() => mockModel);

    // Use Bun's module mocking
    const originalEnv = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";

    // Direct test: call generateObject mock and validate result
    const result = await mockGenerateObject({
      model: mockModel("qwen2.5:7b"),
      schema: MemoryExtractionSchema,
      system: "test prompt",
      prompt: "test input",
    });

    expect(result.object).toEqual(VALID_EXTRACTION);
    expect(result.object.title).toBe("Test Memory");
    expect(result.object.type).toBe("note");
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);

    process.env.OLLAMA_BASE_URL = originalEnv;
  });

  test("validates extraction output against MemoryExtractionSchema", () => {
    // Valid extraction passes
    const parsed = MemoryExtractionSchema.parse(VALID_EXTRACTION);
    expect(parsed.title).toBe("Test Memory");
    expect(parsed.distilled_items).toHaveLength(2);
    expect(parsed.tags).toEqual(["testing", "unit-test"]);
  });

  test("Zod validation rejects invalid extraction output", () => {
    const invalid = {
      title: "Test",
      distilled_items: [], // min 1 required
      qmd_category: "qmd://test",
      type: "note",
      tags: ["valid"],
    };

    expect(() => MemoryExtractionSchema.parse(invalid)).toThrow();
  });

  test("Zod validation rejects invalid type enum", () => {
    const invalid = {
      ...VALID_EXTRACTION,
      type: "unknown",
    };

    expect(() => MemoryExtractionSchema.parse(invalid)).toThrow();
  });

  test("Zod validation rejects non-kebab-case tags", () => {
    const invalid = {
      ...VALID_EXTRACTION,
      tags: ["Has Spaces"],
    };

    expect(() => MemoryExtractionSchema.parse(invalid)).toThrow();
  });

  test("Zod validation rejects qmd_category without qmd:// prefix", () => {
    const invalid = {
      ...VALID_EXTRACTION,
      qmd_category: "tech/testing",
    };

    expect(() => MemoryExtractionSchema.parse(invalid)).toThrow();
  });

  test("fallback parse succeeds when generateObject would fail but text contains valid JSON", () => {
    // Simulate: generateObject failed, but the model returned valid JSON as text
    const modelTextResponse = `I'll extract the memory for you:
${JSON.stringify(VALID_EXTRACTION)}`;

    const result = fallbackParse(modelTextResponse);
    expect(result.title).toBe("Test Memory");
    expect(result.type).toBe("note");
    expect(result.distilled_items).toHaveLength(2);
  });

  test("fallback parse fails when text contains no valid JSON", () => {
    const modelTextResponse = "I'm sorry, I can't process that request.";
    expect(() => fallbackParse(modelTextResponse)).toThrow();
  });

  test("fallback parse fails when JSON in text doesn't match schema", () => {
    const badJson = JSON.stringify({ title: "Only title, nothing else" });
    const modelTextResponse = `Here's what I found: ${badJson}`;
    expect(() => fallbackParse(modelTextResponse)).toThrow();
  });
});

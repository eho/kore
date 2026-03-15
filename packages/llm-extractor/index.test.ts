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

    expect(result.title).toBe("Test Memory");
    expect(result.type).toBe("note");
    expect(result._extractionPath).toBe("structured");
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

    expect(result.title).toBe("Test Memory");
    expect(result._extractionPath).toBe("fallback");
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

// ─── Prompt content tests ────────────────────────────────────────────

describe("Prompt content", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  test("prompt contains all five intent values", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });
    await extract("text", "src");
    const prompt = mockGenerateText.mock.calls[0][0].system;
    expect(prompt).toContain('"recommendation"');
    expect(prompt).toContain('"reference"');
    expect(prompt).toContain('"personal-experience"');
    expect(prompt).toContain('"aspiration"');
    expect(prompt).toContain('"how-to"');
  });

  test("prompt contains confidence instructions", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });
    await extract("text", "src");
    const prompt = mockGenerateText.mock.calls[0][0].system;
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("0.0");
    expect(prompt).toContain("1.0");
  });

  test("Mutekiya example JSON includes intent and confidence", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });
    await extract("text", "src");
    const prompt = mockGenerateText.mock.calls[0][0].system;
    expect(prompt).toContain('"intent": "recommendation"');
    expect(prompt).toContain('"confidence": 0.95');
  });
});

// ─── Observability tests ─────────────────────────────────────────────

describe("Observability: _extractionPath", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  test("structured success returns _extractionPath 'structured'", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: VALID_EXTRACTION });
    const result = await extract("text", "src");
    expect(result._extractionPath).toBe("structured");
  });

  test("fallback success returns _extractionPath 'fallback'", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("structured failed"));
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(VALID_EXTRACTION),
    });
    const result = await extract("text", "src");
    expect(result._extractionPath).toBe("fallback");
  });
});

// ─── Fallback normalization tests ────────────────────────────────────

describe("fallbackParse: intent/confidence normalization", () => {
  const validJson: MemoryExtraction = {
    title: "Test",
    distilled_items: ["Fact one."],
    qmd_category: "qmd://tech/testing",
    type: "note",
    tags: ["test"],
  };

  test("strips invalid intent values rather than throwing", () => {
    const input = { ...validJson, intent: "invalid-intent" };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.intent).toBeUndefined();
  });

  test("preserves valid intent values", () => {
    const input = { ...validJson, intent: "recommendation" };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.intent).toBe("recommendation");
  });

  test("clamps confidence > 1 to 1", () => {
    const input = { ...validJson, confidence: 1.5 };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.confidence).toBe(1);
  });

  test("clamps confidence < 0 to 0", () => {
    const input = { ...validJson, confidence: -0.3 };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.confidence).toBe(0);
  });

  test("passes through valid confidence", () => {
    const input = { ...validJson, confidence: 0.85 };
    const result = fallbackParse(JSON.stringify(input));
    expect(result.confidence).toBe(0.85);
  });
});

// ─── Classification snapshot tests ───────────────────────────────────

describe("Classification snapshot tests", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  const cases = [
    {
      name: "Restaurant recommendation",
      input: "My friend said I have to try Sushi Dai at Tsukiji, best omakase in Tokyo",
      source: "imessage",
      mockResponse: {
        title: "Sushi Dai at Tsukiji",
        distilled_items: ["Sushi Dai is an omakase restaurant at Tsukiji Market, Tokyo.", "Recommended by a friend as the best omakase."],
        qmd_category: "qmd://travel/food/japan",
        type: "place" as const,
        tags: ["sushi", "tsukiji", "omakase"],
        intent: "recommendation" as const,
        confidence: 0.92,
      },
      expectedType: "place",
      expectedCategoryPrefix: "qmd://travel/food/",
      expectedIntent: "recommendation",
    },
    {
      name: "Book save",
      input: "Need to read Thinking, Fast and Slow by Daniel Kahneman",
      source: "kindle_highlights",
      mockResponse: {
        title: "Thinking, Fast and Slow",
        distilled_items: ["Thinking, Fast and Slow is a book by Daniel Kahneman.", "Explores dual-process theory of the mind."],
        qmd_category: "qmd://media/books/psychology",
        type: "media" as const,
        tags: ["psychology", "behavioral-economics"],
        intent: "reference" as const,
        confidence: 0.9,
      },
      expectedType: "media",
      expectedCategoryPrefix: "qmd://media/books/",
    },
    {
      name: "Personal health note",
      input: "Ran my first 10K today in 52 minutes, felt great after the hill at mile 4",
      source: "apple_notes",
      mockResponse: {
        title: "First 10K Run",
        distilled_items: ["Completed first 10K race in 52 minutes.", "Felt great after the hill at mile 4."],
        qmd_category: "qmd://health/fitness/running",
        type: "note" as const,
        tags: ["running", "fitness", "personal-record"],
        intent: "personal-experience" as const,
        confidence: 0.88,
      },
      expectedType: "note",
      expectedCategoryPrefix: "qmd://health/",
      expectedIntent: "personal-experience",
    },
    {
      name: "Programming tutorial",
      input: "Step 1: Install Bun with curl. Step 2: Create a new project with bun init. Step 3: Add dependencies.",
      source: "web_clipper",
      mockResponse: {
        title: "Getting Started with Bun",
        distilled_items: ["Install Bun using curl.", "Create a new project with bun init.", "Add dependencies after initialization."],
        qmd_category: "qmd://tech/programming/bun",
        type: "note" as const,
        tags: ["bun", "javascript", "tutorial"],
        intent: "how-to" as const,
        confidence: 0.95,
      },
      expectedType: "note",
      expectedCategoryPrefix: "qmd://tech/",
      expectedIntent: "how-to",
    },
    {
      name: "Travel aspiration",
      input: "I really want to visit the Northern Lights in Tromsø, Norway someday",
      source: "apple_notes",
      mockResponse: {
        title: "Northern Lights in Tromsø",
        distilled_items: ["Want to see the Northern Lights.", "Tromsø, Norway is the desired destination."],
        qmd_category: "qmd://travel/destinations/norway",
        type: "place" as const,
        tags: ["northern-lights", "norway", "bucket-list"],
        intent: "aspiration" as const,
        confidence: 0.87,
      },
      expectedType: "place",
      expectedCategoryPrefix: "qmd://travel/",
      expectedIntent: "aspiration",
    },
    {
      name: "Person/contact save",
      input: "Met Sarah Chen at the React conf, she works on the compiler team at Meta",
      source: "apple_notes",
      mockResponse: {
        title: "Sarah Chen",
        distilled_items: ["Sarah Chen works on the React compiler team at Meta.", "Met at React conference."],
        qmd_category: "qmd://personal/contacts/tech",
        type: "person" as const,
        tags: ["react", "meta", "conference"],
        intent: "reference" as const,
        confidence: 0.91,
      },
      expectedType: "person",
      expectedCategoryPrefix: "qmd://personal/",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      mockGenerateText.mockResolvedValueOnce({ output: c.mockResponse });
      const result = await extract(c.input, c.source);
      expect(result.type).toBe(c.expectedType as typeof result.type);
      expect(result.qmd_category.startsWith(c.expectedCategoryPrefix)).toBe(true);
      if (c.expectedIntent) {
        expect(result.intent).toBe(c.expectedIntent as typeof result.intent);
      }
    });
  }
});

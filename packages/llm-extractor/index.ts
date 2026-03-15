import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { MemoryExtractionSchema, IntentEnum } from "@kore/shared-types";
import type { MemoryExtraction } from "@kore/shared-types";

const VALID_INTENTS = new Set(IntentEnum.options);

const SYSTEM_PROMPT = `You are a memory extraction engine for Kore, a personal knowledge management system.

Given raw text from a user's saved content, extract structured metadata as JSON.

## Rules
- Extract a concise, declarative title (not a sentence, but a name/label).
- Extract 1-7 atomic facts as standalone sentences. Each fact must be independently useful.
- Classify into exactly one QMD category path. Use ONLY these top-level roots:
  - qmd://tech/ (programming, hardware, software, frameworks)
  - qmd://travel/ (geography, restaurants, itineraries, tourism)
  - qmd://health/ (fitness, medical, recipes, nutrition)
  - qmd://finance/ (receipts, investing, budgeting, taxes)
  - qmd://media/ (books, movies, music, games)
  - qmd://personal/ (diary, relationships, goals, reflections)
  - qmd://admin/ (household, manuals, bureaucracy)
  You may add 1-2 sub-paths (e.g. qmd://travel/food/japan).
- Assign a type: "place", "media", "note", or "person".
- Generate 1-5 lowercase kebab-case tags.
- Classify intent — the disposition of why this content was saved. Use exactly one of:
  - "recommendation" — someone suggests this as worth trying/using
  - "reference" — factual information saved for future lookup (use when uncertain)
  - "personal-experience" — something the user directly experienced or did
  - "aspiration" — something the user wants to do, try, or achieve
  - "how-to" — instructions, steps, or procedures
- Assign a confidence score: a float 0.0–1.0 reflecting your certainty in the extraction. >0.8 = clear content, 0.5–0.8 = some interpretation needed, <0.5 = ambiguous or very short.
- When content fits multiple categories, prefer the most specific applicable root.

## Common Misclassifications (avoid these)
- Restaurant recommendation → type: "place", NOT type: "note"
- Book recommendation → type: "media", NOT type: "note"
- Sub-paths describe content, not source (e.g. recipe from YouTube → qmd://health/nutrition/recipes, NOT qmd://media/youtube)

## Example

Input: "John recommended Mutekiya in Ikebukuro for solo dining. Cash only, get the tsukemen. Usually a 30 min wait."

Output:
{
  "title": "Mutekiya Ramen",
  "distilled_items": [
    "Mutekiya is a ramen shop in Ikebukuro, Tokyo.",
    "Recommended by John for solo dining.",
    "Cash only.",
    "The tsukemen is the recommended order.",
    "Expect approximately a 30 minute wait."
  ],
  "qmd_category": "qmd://travel/food/japan",
  "type": "place",
  "tags": ["ramen", "ikebukuro", "solo-dining", "cash-only"],
  "intent": "recommendation",
  "confidence": 0.95
}`;

/**
 * Create the Ollama-backed OpenAI-compatible provider.
 */
function createProvider() {
  let baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  if (!baseURL.endsWith("/v1")) {
    baseURL = baseURL.replace(/\/$/, "") + "/v1";
  }
  return createOpenAI({ baseURL, apiKey: "ollama" });
}

/**
 * Attempt to parse a MemoryExtraction from raw text response as a fallback
 * when structured output generation fails (e.g., model returns malformed JSON).
 *
 * Normalizes common model quirks before Zod validation:
 * - Strips markdown code fences (```json ... ```)
 * - Converts tags to lowercase kebab-case
 * - Adds the qmd:// prefix if missing from qmd_category
 */
export function fallbackParse(text: string): MemoryExtraction {
  // Strip markdown code fences if present
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

  // Try to find a JSON object in the text
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Fallback parse failed: no JSON object found in response");
  }

  const raw = JSON.parse(jsonMatch[0]);

  // Normalize tags: lowercase kebab-case, drop empties, truncate to max 5
  if (Array.isArray(raw.tags)) {
    raw.tags = raw.tags
      .map((t: unknown) =>
        String(t)
          .toLowerCase()
          .replace(/[\s_]+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
      )
      .filter((t: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t))
      .slice(0, 5);
  }

  // Truncate distilled_items to max 7
  if (Array.isArray(raw.distilled_items)) {
    raw.distilled_items = raw.distilled_items.slice(0, 7);
  }

  // Ensure qmd_category has the required prefix
  if (typeof raw.qmd_category === "string" && !raw.qmd_category.startsWith("qmd://")) {
    raw.qmd_category = `qmd://${raw.qmd_category}`;
  }

  // Strip invalid intent values (worker will apply the default)
  if (raw.intent !== undefined && !VALID_INTENTS.has(raw.intent)) {
    delete raw.intent;
  }

  // Clamp confidence to [0, 1]
  if (typeof raw.confidence === "number") {
    raw.confidence = Math.max(0, Math.min(1, raw.confidence));
  }

  return MemoryExtractionSchema.parse(raw);
}

/**
 * Extract structured memory metadata from raw text using a local LLM.
 *
 * Uses Vercel AI SDK's generateText() with Output.object() for Zod schema
 * enforcement, pointed at a local Ollama instance. Falls back to text-based
 * parsing if structured generation fails.
 */
export async function extract(
  rawText: string,
  source: string
): Promise<MemoryExtraction & { _extractionPath: "structured" | "fallback" }> {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";
  console.log(`LLM extractor: calling ${baseURL} with model ${model}`);
  const provider = createProvider();

  try {
    const { output } = await generateText({
      model: provider(model),
      output: Output.object({ schema: MemoryExtractionSchema }),
      system: SYSTEM_PROMPT,
      prompt: `Source: ${source}\n\nRaw text:\n${rawText}`,
    });

    if (!output) {
      throw new Error("No structured output generated by model");
    }

    console.log(`LLM extractor: structured output succeeded for source ${source}`);
    return { ...output, _extractionPath: "structured" as const };
  } catch (primaryError) {
    // Fallback: attempt text-based generation and parse JSON from response
    try {
      const { text } = await generateText({
        model: provider(model),
        system: SYSTEM_PROMPT,
        prompt: `Source: ${source}\n\nRaw text:\n${rawText}\n\nRespond with ONLY valid JSON matching the schema.`,
      });

      const parsed = fallbackParse(text);
      console.log(`LLM extractor: structured output failed, fallback succeeded for source ${source}`);
      return { ...parsed, _extractionPath: "fallback" as const };
    } catch (fallbackError) {
      // Log fallback error to aid debugging, re-throw original
      console.warn("LLM extractor: fallback parse also failed:", fallbackError);
      throw primaryError;
    }
  }
}

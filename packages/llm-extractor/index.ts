import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { MemoryExtractionSchema, IntentEnum } from "@kore/shared-types";
import type { MemoryExtraction } from "@kore/shared-types";

const VALID_INTENTS = new Set(IntentEnum.options);

export const SYSTEM_PROMPT = `You are a memory extraction engine for Kore, a personal knowledge management system.

Given raw text from a user's saved content, extract structured metadata as JSON.

## Rules

### Title and facts
- Extract a concise, declarative title (not a sentence, but a name/label).
- Extract 1-7 atomic facts as standalone sentences. Each fact must be independently useful.

### QMD Category
Classify into exactly one path. Use ONLY these top-level roots:
- qmd://tech/ — digital and software topics ONLY: programming, frameworks, software tools, hardware, devops
- qmd://travel/ — geography, restaurants, itineraries, tourism
- qmd://health/ — fitness, medical, recipes, nutrition
- qmd://finance/ — receipts, investing, budgeting, taxes
- qmd://media/ — books, movies, music, games
- qmd://personal/ — diary, relationships, goals, reflections, language learning, self-improvement
- qmd://admin/ — household, vehicle maintenance, manuals, bureaucracy, home measurements

You may add 1-2 sub-paths (e.g. qmd://travel/food/japan). Sub-paths describe the content, not the source.

### Type
Assign exactly one: "place", "media", "note", or "person".

### Tags
Generate 1-5 lowercase kebab-case tags.

### Intent
Classify exactly one intent — the disposition of why this content was saved:
- "recommendation" — someone (or a publication) endorses something as worth trying. Use this for curated lists of places, books, restaurants, or products with personal opinions, even if the tone is factual or journalistic.
- "reference" — neutral factual information saved for future lookup. Use when there is no clear endorsement or directive. Default when uncertain.
- "personal-experience" — something the user directly experienced or did themselves.
- "aspiration" — something the user wants to do, try, or achieve.
- "how-to" — step-by-step instructions, checklists, procedural guides, or maintenance schedules.

### Confidence
Assign a float 0.0–1.0 reflecting your certainty in the extraction:
- >0.8 — content is clear and unambiguous
- 0.5–0.8 — some interpretation was needed
- <0.5 — content is ambiguous, very short, or noisy

## Common Misclassifications (avoid these)
- Restaurant/book/product recommendation → intent: "recommendation", NOT "reference"
- A curated list from a magazine or website of "best X" → intent: "recommendation"
- A checklist or maintenance schedule → intent: "how-to", NOT "reference"
- Language learning or self-improvement plan → qmd://personal/, NOT qmd://tech/
- Vehicle or home maintenance → qmd://admin/, NOT qmd://tech/
- Restaurant → type: "place", NOT type: "note"
- Book → type: "media", NOT type: "note"

## Examples

### Example 1 — Personal recommendation

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
}

### Example 2 — Curated list from a publication

Input: "Saved from Broadsheet. Planning a special occasion in Sydney? These degustation menus are the best in the city. Quay has harbour views and Peter Gilmore's snow egg. Bennelong is inside the Opera House. Sixpenny in Stanmore does a 6-course with Japanese and Nordic influences."

Output:
{
  "title": "Sydney Degustation Restaurants",
  "distilled_items": [
    "Quay offers waterfront dining with views of the Opera House and Harbour Bridge.",
    "Chef Peter Gilmore's snow egg dessert is a signature dish at Quay.",
    "Bennelong is located inside the Sydney Opera House and serves Modern Australian cuisine.",
    "Sixpenny in Stanmore offers 6 and 9 course tasting menus with Japanese and Nordic influences."
  ],
  "qmd_category": "qmd://travel/food/australia",
  "type": "place",
  "tags": ["sydney", "degustation", "fine-dining", "special-occasion"],
  "intent": "recommendation",
  "confidence": 0.92
}`;

/**
 * Resolve the language model from environment variables.
 *
 * Provider selection via LLM_PROVIDER (default: "ollama"):
 *   - "gemini"  → Google Gemini via GEMINI_API_KEY, model default: gemini-2.5-flash-lite
 *   - "ollama"  → local Ollama via OLLAMA_BASE_URL, model default: qwen2.5:7b
 *
 * LLM_MODEL overrides the per-provider default model name.
 * OLLAMA_MODEL is a legacy alias for LLM_MODEL when using Ollama.
 */
function resolveModel() {
  const provider = process.env.LLM_PROVIDER || "ollama";

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini requires GEMINI_API_KEY to be set");
    const modelName = process.env.LLM_MODEL || "gemini-2.5-flash-lite";
    console.log(`LLM extractor: provider=gemini model=${modelName}`);
    return createGoogleGenerativeAI({ apiKey })(modelName);
  }

  // Default: ollama
  let baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  if (!baseURL.endsWith("/v1")) baseURL = baseURL.replace(/\/$/, "") + "/v1";
  const modelName = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:7b";
  console.log(`LLM extractor: provider=ollama model=${modelName} url=${baseURL}`);
  return createOpenAI({ baseURL, apiKey: "ollama" })(modelName);
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

  // Default invalid or missing intent to "reference"
  if (!raw.intent || !VALID_INTENTS.has(raw.intent)) {
    raw.intent = "reference";
  }

  // Clamp confidence to [0, 1]; default to 0.5 if missing
  if (typeof raw.confidence === "number") {
    raw.confidence = Math.max(0, Math.min(1, raw.confidence));
  } else {
    raw.confidence = 0.5;
  }

  return MemoryExtractionSchema.parse(raw);
}

/**
 * Extract structured memory metadata from raw text using the configured LLM.
 *
 * Uses Vercel AI SDK's generateText() with Output.object() for Zod schema
 * enforcement. Provider is selected via LLM_PROVIDER env var (default: ollama).
 * Falls back to text-based parsing if structured generation fails.
 */
export async function extract(
  rawText: string,
  source: string
): Promise<MemoryExtraction & { _extractionPath: "structured" | "fallback" }> {
  const model = resolveModel();

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: MemoryExtractionSchema }),
      system: SYSTEM_PROMPT,
      prompt: `Source: ${source}\n\nRaw text:\n${rawText}`,
      temperature: 0,
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
        model,
        system: SYSTEM_PROMPT,
        prompt: `Source: ${source}\n\nRaw text:\n${rawText}\n\nRespond with ONLY valid JSON matching the schema.`,
        temperature: 0,
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

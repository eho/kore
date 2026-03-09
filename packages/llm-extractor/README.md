# `@kore/llm-extractor`

Encapsulates all LLM integration for Kore. Exposes a single `extract()` function that takes raw text and returns structured memory metadata — completely locally via Ollama.

## How It Works

1. Calls `generateText()` from [Vercel AI SDK](https://sdk.vercel.ai/) with `Output.object()` to enforce Zod schema validation on the model's output.
2. Uses `createOpenAI()` pointed at your local Ollama instance (OpenAI-compatible API).
3. If structured output fails (e.g. model returns malformed JSON), falls back to a plain text generation and extracts JSON from the response.
4. Returns a `MemoryExtraction` object validated against `MemoryExtractionSchema` from `@kore/shared-types`.

No data leaves your machine.

## Prerequisites

[Ollama](https://ollama.ai) must be running locally with the target model pulled:

```sh
ollama pull qwen2.5:7b
ollama serve
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama OpenAI-compatible endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model name to use for extraction |

These are read at call time — no initialization required.

## API

### `extract(rawText, source) → Promise<MemoryExtraction>`

```ts
import { extract } from "@kore/llm-extractor";

const result = await extract(
  "John recommended Mutekiya in Ikebukuro for solo dining. Cash only, get the tsukemen.",
  "apple_notes"
);

// result:
// {
//   title: "Mutekiya Ramen",
//   distilled_items: ["Mutekiya is a ramen shop in Ikebukuro, Tokyo.", ...],
//   qmd_category: "qmd://travel/food/japan",
//   type: "place",
//   tags: ["ramen", "ikebukuro", "cash-only"]
// }
```

**Parameters:**
- `rawText: string` — the raw unstructured text to extract from
- `source: string` — the originating system (e.g. `"apple_notes"`, `"x_bookmark"`)

**Returns:** `Promise<MemoryExtraction>` — validated against `MemoryExtractionSchema`

**Throws:** if both primary structured generation and fallback text parsing fail.

### `fallbackParse(text) → MemoryExtraction`

Exported for testing. Attempts to extract a JSON object from a raw text response and parse it against `MemoryExtractionSchema`. Throws if no valid JSON is found or validation fails.

## Fallback Behavior

If `generateText()` with structured output fails:
1. A second `generateText()` call is made requesting plain text JSON output.
2. `fallbackParse()` scans the response for the first `{...}` block and validates it.
3. If the fallback also fails, the original error is re-thrown so the queue can increment retries.

## Development

```sh
# Type check
bun run --filter @kore/llm-extractor typecheck

# Run tests (mocks Vercel AI SDK — no Ollama required)
bun test packages/llm-extractor
```

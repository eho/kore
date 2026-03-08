import type { MemoryExtraction } from "@kore/shared-types";

/**
 * Extract structured memory metadata from raw text using a local LLM.
 *
 * This is a stub implementation. US-007 will add the full Vercel AI SDK
 * integration with Ollama, system prompts, and fallback parsing.
 */
export async function extract(
  rawText: string,
  source: string
): Promise<MemoryExtraction> {
  throw new Error(
    "llm-extractor not yet implemented — see US-007"
  );
}

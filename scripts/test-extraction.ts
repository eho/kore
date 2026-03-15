#!/usr/bin/env bun
/**
 * test-extraction.ts
 *
 * Standalone script to test LLM extraction against the e2e dataset.
 *
 * Usage:
 *   bun scripts/test-extraction.ts
 *   bun scripts/test-extraction.ts --model ollama:qwen2.5:7b
 *   bun scripts/test-extraction.ts --model gemini:gemini-2.0-flash-lite
 *   bun scripts/test-extraction.ts --model gemini:gemini-2.5-flash-preview --files tokyo-ramen.md,surry-hills-wine-bar.md
 *
 * Environment:
 *   OLLAMA_BASE_URL       (default: http://localhost:11434/v1)
 *   GOOGLE_GENERATIVE_AI_API_KEY  (required for gemini provider)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { MemoryExtractionSchema } from "@kore/shared-types";
import { fallbackParse, SYSTEM_PROMPT as DEFAULT_EXTRACTOR_PROMPT } from "../packages/llm-extractor/index.ts";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// --model <provider:modelname>  e.g. ollama:qwen2.5:7b  or  gemini:gemini-2.0-flash-lite
const modelArg = getArg("--model") ?? "ollama:qwen2.5:7b";
// --files comma-separated filenames (relative to e2e/dataset/)
const filesArg = getArg("--files");
// --system path to a custom system prompt file
const systemArg = getArg("--system");

// ── Model provider setup ──────────────────────────────────────────────────────

const [provider, ...modelParts] = modelArg.split(":");
const modelName = modelParts.join(":");

function buildModel() {
  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is not set");
      process.exit(1);
    }
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelName);
  }

  if (provider === "openai") {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai(modelName);
  }

  // Default: ollama (OpenAI-compatible)
  let baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  if (!baseURL.endsWith("/v1")) baseURL = baseURL.replace(/\/$/, "") + "/v1";
  const ollama = createOpenAI({ baseURL, apiKey: "ollama" });
  return ollama(modelName);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const systemPrompt = systemArg
  ? readFileSync(systemArg, "utf-8").trim()
  : DEFAULT_EXTRACTOR_PROMPT;

// ── Dataset files ─────────────────────────────────────────────────────────────

const DATASET_DIR = join(import.meta.dir, "../e2e/dataset");

function loadFiles(): Array<{ name: string; content: string }> {
  if (filesArg) {
    return filesArg.split(",").map((f) => {
      const file = f.trim();
      const path = join(DATASET_DIR, file);
      return { name: file, content: readFileSync(path, "utf-8") };
    });
  }
  // Default: all dataset files
  return readdirSync(DATASET_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(join(DATASET_DIR, f), "utf-8") }));
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function extractOne(
  model: ReturnType<typeof buildModel>,
  content: string,
  source: string
): Promise<{ result: object; path: "structured" | "fallback" | "error"; error?: string }> {
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: MemoryExtractionSchema }),
      system: systemPrompt,
      prompt: `Source: ${source}\n\nRaw text:\n${content}`,
    });

    if (!output) throw new Error("No structured output returned");
    return { result: output, path: "structured" };
  } catch {
    // Fallback
    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        prompt: `Source: ${source}\n\nRaw text:\n${content}\n\nRespond with ONLY valid JSON matching the schema.`,
      });
      const parsed = fallbackParse(text);
      return { result: parsed, path: "fallback" };
    } catch (e) {
      return { result: {}, path: "error", error: String(e) };
    }
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

function printResult(
  name: string,
  result: object,
  path: "structured" | "fallback" | "error",
  durationMs: number,
  error?: string
) {
  const sep = "─".repeat(60);
  console.log(`\n${sep}`);
  console.log(`File:     ${name}`);
  console.log(`Path:     ${path}   (${durationMs}ms)`);
  if (path === "error") {
    console.log(`Error:    ${error}`);
    return;
  }
  const r = result as Record<string, unknown>;
  console.log(`Title:    ${r.title}`);
  console.log(`Intent:   ${r.intent ?? "(missing)"}`);
  console.log(`Confidence: ${r.confidence ?? "(missing)"}`);
  console.log(`Type:     ${r.type}`);
  console.log(`Category: ${r.qmd_category}`);
  console.log(`Tags:     ${(r.tags as string[])?.join(", ")}`);
  console.log(`Facts:`);
  for (const item of (r.distilled_items as string[]) ?? []) {
    console.log(`  • ${item}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const files = loadFiles();
const model = buildModel();

console.log(`\nKore Extraction Test`);
console.log(`Model:    ${modelArg}`);
console.log(`Files:    ${files.length}`);
console.log(`Prompt:   ${systemArg ?? "default"}`);

for (const { name, content } of files) {
  process.stdout.write(`\nExtracting ${name}...`);
  const t0 = Date.now();
  const { result, path, error } = await extractOne(model, content, name);
  const ms = Date.now() - t0;
  printResult(name, result, path, ms, error);
}

console.log("\n" + "─".repeat(60));
console.log("Done.");

# LLM Extraction Quality Comparison
**Date:** 2026-03-15
**Dataset:** `e2e/dataset/` (15 files)
**Script:** `bun scripts/test-extraction.ts --model gemini:<model>`

---

## Models Tested

| Model | Provider | Avg speed |
|-------|----------|-----------|
| `gemini-2.5-flash-lite` | Google | ~1.9s/file |
| `gemini-3.1-flash-lite-preview` | Google | ~1.9s/file |

Both models dramatically outperform `ollama:qwen2.5:7b` (~40s/file), which also consistently failed to extract intent.

---

## Round 1 — Original Prompt

### Intent classification accuracy

| File | Expected | 2.5-flash-lite | 3.1-flash-lite-preview |
|------|----------|---------------|----------------------|
| `apple-pie-recipe.md` | `how-to` | `how-to` ✓ | `how-to` ✓ |
| `book-recommendations.md` | `recommendation` | `recommendation` ✓ | `reference` ✗ |
| `car-maintenance.md` | `how-to` | *(missing)* ✗ | `how-to` ✓ |
| `docker-deployment.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `exact-match-control.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `home-measurements.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `implicit-bakery.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| `japanese-learning.md` | `how-to` | `how-to` ✓ | `how-to` ✓ |
| `noisy-meeting-notes.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `react-migration-away.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `react-performance.md` | `reference`/`how-to` | `reference` ~ | `reference` ~ |
| `surry-hills-wine-bar.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| `sydney-degustation.md` | `recommendation` | `reference` ✗ | `reference` ✗ |
| `sydney-ramen-gumshara.md` | `recommendation` | `recommendation` ✓ | `reference` ✗ |
| `tokyo-ramen.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| **Score** | | **11/15 (73%)** | **10/15 (67%)** |

**Round 1 issues identified:**
- Both models: `sydney-degustation` → `reference` (curated list from a publication, should be `recommendation`)
- `gemini-2.5-flash-lite`: dropped `intent` entirely on `car-maintenance`
- `gemini-3.1-flash-lite-preview`: `sydney-ramen-gumshara` → `reference` (descriptive/factual tone confused it)
- Confidence was consistently missing — models silently dropped the optional field in structured output mode
- Category routing: both models used `qmd://tech/` for language learning and vehicle maintenance

---

## Changes Made

### Schema (`packages/shared-types/index.ts`)
- Made `intent` and `confidence` **required** in `MemoryExtractionSchema`
- `BaseFrontmatterSchema` keeps them optional for backward compat with stored files

### Prompt (`packages/llm-extractor/index.ts`)
1. Added disambiguation: *"A curated or ranked list with endorsements = `recommendation`, even if written factually or journalistically"*
2. Strengthened `how-to`: *"A checklist, step-by-step guide, or maintenance schedule = `how-to`"*
3. Fixed category routing: `qmd://tech/` is digital/software only; vehicle/home → `qmd://admin/`; language learning/self-improvement → `qmd://personal/`
4. Added a second few-shot example (degustation list → `recommendation`)
5. Added `temperature: 0` for deterministic output

### Code (`packages/llm-extractor/index.ts`)
- `fallbackParse` now defaults missing/invalid intent to `"reference"` and missing confidence to `0.5`
- Worker: removed the dead `!intent` guard since both fields are always present

---

## Round 2 — Updated Prompt

### Intent classification accuracy

| File | Expected | 2.5-flash-lite | 3.1-flash-lite-preview |
|------|----------|---------------|----------------------|
| `apple-pie-recipe.md` | `how-to` | `how-to` ✓ | `how-to` ✓ |
| `book-recommendations.md` | `recommendation` | `recommendation` ✓ | `aspiration` ✗ |
| `car-maintenance.md` | `how-to` | `reference` ✗ | `how-to` ✓ |
| `docker-deployment.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `exact-match-control.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `home-measurements.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `implicit-bakery.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| `japanese-learning.md` | `how-to` | `how-to` ✓ | `how-to` ✓ |
| `noisy-meeting-notes.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `react-migration-away.md` | `reference` | `reference` ✓ | `reference` ✓ |
| `react-performance.md` | `reference`/`how-to` | `reference` ~ | `reference` ~ |
| `surry-hills-wine-bar.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| `sydney-degustation.md` | `recommendation` | `recommendation` ✓ | `reference` ✗ |
| `sydney-ramen-gumshara.md` | `recommendation` | `recommendation` ✓ | `reference` ✗ |
| `tokyo-ramen.md` | `recommendation` | `recommendation` ✓ | `recommendation` ✓ |
| **Score** | | **13/15 (87%)** | **11/15 (73%)** |

### Confidence coverage

Both models now return confidence on every file. The schema change (required field) fully resolved the dropout issue.

| Observation | Round 1 | Round 2 |
|-------------|---------|---------|
| Files with confidence populated | ~6/15 | **15/15** |

### Category routing improvements (2.5-flash-lite)

| File | Round 1 | Round 2 |
|------|---------|---------|
| `home-measurements.md` | `qmd://tech/automotive` | `qmd://admin/household` ✓ |
| (3.1) `car-maintenance.md` | `qmd://admin/automotive` | `qmd://admin/vehicle-maintenance` ✓ |
| (3.1) `japanese-learning.md` | `qmd://personal/learning` | `qmd://admin/learning` ✗ (regressed) |

Note: `gemini-2.5-flash-lite` still routes `japanese-learning` to `qmd://tech/languages/japanese` despite the updated guidance — persistent model bias toward `qmd://tech/` for anything skill-related.

---

## Remaining Issues

### `gemini-2.5-flash-lite`
- `car-maintenance.md` → `reference` instead of `how-to` despite explicit checklist rule. The model appears to over-anchor on the "maintenance" framing rather than the procedural structure.
- `japanese-learning.md` → `qmd://tech/languages/japanese` (should be `qmd://personal/`)
- Increased fallback path usage (4/15 files vs ~2/15 in Round 1) — longer prompt may be degrading structured output reliability

### `gemini-3.1-flash-lite-preview`
- `sydney-degustation.md` and `sydney-ramen-gumshara.md` → still `reference` despite the new example and rule. This model appears more resistant to the publication/journalistic tone override.
- `book-recommendations.md` → regressed from `reference` to `aspiration` — the new `recommendation` guidance may be over-triggering the aspiration classification for "want to read" framing
- `japanese-learning.md` → `qmd://admin/learning` (wrong root entirely)

---

## Summary

| Dimension | `gemini-2.5-flash-lite` | `gemini-3.1-flash-lite-preview` |
|-----------|------------------------|--------------------------------|
| **Intent accuracy (R1)** | 73% (11/15) | 67% (10/15) |
| **Intent accuracy (R2)** | **87% (13/15)** | **73% (11/15)** |
| **Confidence coverage** | **15/15** (was 6/15) | **15/15** (was 2/15) |
| Category quality | Good | Good |
| Structured output reliability | Moderate (11/15) | **High (14/15)** |
| Speed | **~1.9s** | ~1.9s |

**Recommendation:** Use `gemini-2.5-flash-lite`. The prompt improvements gave +14 percentage points on intent accuracy. The two remaining failures (`car-maintenance`, `japanese-learning` category) are minor and can be addressed with further targeted prompt tuning.

---

## Potential Next Steps

1. **`car-maintenance` intent fix:** The structured checklist format with explicit headers ("Weekly Checks", "Every 5,000 Miles") isn't being recognised as `how-to`. Consider adding to the example: *"A document with periodic tasks grouped by frequency = `how-to`"*.

2. **Category bias for skill content:** Both models show persistent `qmd://tech/` bias for any skill-related content (language learning, etc). A negative example in the prompt (*"Language learning → qmd://personal/, NOT qmd://tech/"*) may be more effective than a positive rule.

3. **Structured output regression:** The fallback rate increased in Round 2 (4/15 → was 2/15). Worth monitoring — if it grows further, consider whether a more concise prompt structure helps. The second example adds ~30 tokens to every call.

4. **`react-performance.md` is borderline:** It's a list of techniques/patterns. Both models chose `reference`. Could be argued either way — may need a UX decision on what's most useful for search retrieval.

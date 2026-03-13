# E2E Testing & Dataset Guide

This directory contains the strategy and instructions for end-to-end (E2E) testing of Kore's ingestion and search pipelines, along with a curated dataset to challenge the system.

## Manual Testing Guide

Use this guide to validate the Kore ingestion and search pipeline step by step before running the automated E2E suite.

### Prerequisites

Start the API natively:
```sh
bun run start
# Watch logs directly in this terminal — worker and watcher output appears here
```

### 1. Ingest commands

**Single file:**
```sh
kore ingest e2e/dataset/tokyo-ramen.md --source "e2e/tokyo-ramen"
```

**All dataset files at once:**
```sh
kore ingest e2e/dataset/*.md
```

The CLI blocks and polls until LLM extraction completes, then prints a confirmation. 

### 2. Validation commands

**List all memories** — confirm each source label appears:
```sh
kore list
```

**Show full detail** (LLM-extracted title, tags, category, content):
```sh
kore show <id>
```

**Search queries to validate recall and precision:**
```sh
# Exact match
kore search "XYZZY_TEST_KEYWORD"

# Semantic — should return sydney-degustation + surry-hills-wine-bar, NOT japanese-learning
kore search "anniversary dinner ideas in Sydney"

# Contextual — should return japanese-learning, NOT sydney results
kore search "I want to start learning Japanese"

# Cross-domain — should return docker-deployment + react-performance, NOT food results
kore search "tech deployment strategies"

# Intent flag
kore search "where should I eat in Tokyo" --intent "personal travel and food bookmarks"
```

### 3. Cleanup

Delete a specific memory:
```sh
kore delete <id> --force
```

Stop the server:
```sh
# Press Ctrl+C in the terminal running `bun run start`
```

---

## Dataset Strategy (`e2e/dataset/`)

Testing search in Kore is fundamentally different from testing a standalone search engine like Elasticsearch or QMD. Kore's memory pipeline consists of two distinct phases:

1. **LLM Enrichment (Ingestion):** Raw documents are passed through an LLM to extract structured metadata, categories, tags, and a "distilled" summary of key facts.
2. **Hybrid Retrieval (Search):** The QMD engine (BM25 + Vector + Re-ranking) indexes *both* the raw text and the LLM-enriched facts.

Therefore, our test dataset is designed to evaluate **the synergy between LLM extraction and semantic retrieval**. We want to test whether the LLM successfully pulls out hidden signals, and whether the retrieval engine correctly ranks those signals.

### Test Dimensions & Challenge Data

We construct our test dataset around the following dimensions to challenge both the extraction and retrieval layers:

#### 1. Implicit Knowledge & Concept Abstraction
**Goal:** Test if the LLM correctly deduces overarching concepts from specific details.
* **Example (`implicit-bakery.md`):** A document raving about "croissants, baguettes, and pain au chocolat" but never using the words "French Bakery" or "Cafe".
* **Success Criteria:** Searching for "French Bakery" should highly rank this document because the ingestion LLM extracted the implicit concept.

#### 2. Signal Extraction in High Noise (The Haystack)
**Goal:** Test if the LLM can extract a single, critical fact from a rambling, low-density document, and if QMD's smart chunking preserves it.
* **Example (`noisy-meeting-notes.md`):** A massive, rambling meeting transcript where 95% of the text is conversational filler, but one paragraph mentions "We need to upgrade the Postgres database to version 15".
* **Success Criteria:** A search for "Postgres upgrade" should immediately retrieve this document, proving the LLM distilled the action item and QMD indexed it effectively.

#### 3. Lexical Ambiguity & Polysemy
**Goal:** Test if the system understands context and differentiates between words that look identical but mean different things.
* **Example (`apple-pie-recipe.md`):** Differentiating between "Apple Note" (software/tech) and an "Apple Pie Recipe" (food).
* **Success Criteria:** Searching for "apple tech company" or "baking apples" should cleanly separate the two without cross-contamination.

#### 4. Intersections & Distractors
**Goal:** Test how the engine handles overlapping concepts across different entities.
* **Example (`sydney-ramen-gumshara.md`):** The dataset contains "Tokyo Ramen" and "Sydney Fine Dining". We add "Sydney Ramen".
* **Success Criteria:** Searching for "Ramen in Tokyo" should rank "Tokyo Ramen" first, not "Sydney Ramen". The Re-ranker must respect the intersection of location + food, not just add up individual term scores.

#### 5. Semantic Synonymy (Vocabulary Mismatch)
**Goal:** Test the vector engine's ability to bridge vocabulary gaps where exact keywords are completely missing.
* **Example (`car-maintenance.md`):** A note about "automobile maintenance, engine tuning, and changing tires" that never uses the word "car".
* **Success Criteria:** Searching for "fixing my car" should retrieve the document via semantic vector matching, even if BM25 fails completely.

#### 6. Negation & Anti-Patterns
**Goal:** Test if the ingestion LLM captures the negative sentiment and if the retrieval engine (specifically the Cross-Encoder) down-ranks it appropriately.
* **Example (`react-migration-away.md`):** A document titled "Moving away from React" that explicitly details dropping the framework.
* **Success Criteria:** A search for "React best practices" should rank actual React tutorials higher than the migration-away document.

#### 7. Control Documents (Exact Match)
**Goal:** Provide a strict baseline for deterministic retrieval.
* **Example (`exact-match-control.md`):** A file containing a unique, nonsensical string (`XYZZY_TEST_KEYWORD`).
* **Success Criteria:** Verifies that BM25 full-text indexing is functioning perfectly without LLM interference.

### Baseline Data Manifest
In addition to the challenge data listed above, the dataset includes standard baseline documents:
* `book-recommendations.md`
* `docker-deployment.md`
* `home-measurements.md`
* `japanese-learning.md`
* `react-performance.md`
* `surry-hills-wine-bar.md`
* `sydney-degustation.md`
* `tokyo-ramen.md`

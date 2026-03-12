# Manual Testing Guide

Use this guide to validate the Kore ingestion and search pipeline step by step before running the automated E2E suite.

## Prerequisites

Start the API natively:
```sh
bun run start
# Watch logs directly in this terminal — worker and watcher output appears here
```

---

## Ingest commands

**Single file:**
```sh
bun run apps/cli/src/index.ts ingest e2e/dataset/tokyo-ramen.md --source "e2e/tokyo-ramen"
```

**All dataset files at once:**
```sh
bun run apps/cli/src/index.ts ingest e2e/dataset/*.md
```

The CLI blocks and polls until LLM extraction completes, then prints a confirmation. Recommended order for step-by-step validation:

| File | What to observe |
|---|---|
| `tokyo-ramen.md` | LLM extraction + tags + category |
| `sydney-degustation.md` | Travel/food categorisation |
| `surry-hills-wine-bar.md` | Note type, no collection |
| `japanese-learning.md` | Hobby/language tags |
| `react-performance.md` | Tech category |
| `docker-deployment.md` | Tech/devops |
| `book-recommendations.md` | Media type |
| `home-measurements.md` | Admin/household |
| `exact-match-control.md` | Exact keyword retrieval |

---

## Validation commands

**List all memories** — confirm each source label appears:
```sh
bun run apps/cli/src/index.ts list
```

**Show full detail** (LLM-extracted title, tags, category, content):
```sh
bun run apps/cli/src/index.ts show <id>
```

**Search queries to validate recall and precision:**
```sh
# Exact match
bun run apps/cli/src/index.ts search "XYZZY_TEST_KEYWORD"

# Semantic — should return sydney-degustation + surry-hills-wine-bar, NOT japanese-learning
bun run apps/cli/src/index.ts search "anniversary dinner ideas in Sydney"

# Contextual — should return japanese-learning, NOT sydney results
bun run apps/cli/src/index.ts search "I want to start learning Japanese"

# Cross-domain — should return docker-deployment + react-performance, NOT food results
bun run apps/cli/src/index.ts search "tech deployment strategies"

# Intent flag
bun run apps/cli/src/index.ts search "where should I eat in Tokyo" --intent "personal travel and food bookmarks"
```

---

## Cleanup

Delete a specific memory:
```sh
bun run apps/cli/src/index.ts delete <id> --force
```

Stop the server:
```sh
# Press Ctrl+C in the terminal running `bun run start`
```

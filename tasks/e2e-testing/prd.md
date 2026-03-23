# PRD: Kore End-to-End Test Suite

## 1. Introduction

Kore is a personal memory bank that ingests saved content (bookmarks, notes, social media saves) and makes it retrievable via semantic search. This PRD covers the implementation of a comprehensive automated E2E test suite that validates the full ingestion → indexing → search pipeline using the Kore CLI.

The tests serve two purposes: (1) confirm the pipeline works correctly, and (2) measure how well the memory system performs at contextual recall — the core product promise described in the [vision document](../../docs/vision/vision.md).

The full testing strategy is documented in [`tasks/e2e-testing/plan.md`](./plan.md). This PRD translates that plan into independently implementable user stories.

**Implementation target:** `e2e/e2e.test.ts` using `bun:test`.

**Runtime environment:** Local Docker instance (`docker-compose up`). Required env vars: `KORE_API_KEY`, `KORE_BASE_URL` (default `http://localhost:3000`).

---

## 2. Goals

- Validate that diverse content types can be ingested and indexed without errors.
- Validate that the Kore memory system surfaces the correct memories for semantic, contextual, and exact-match queries.
- Validate that irrelevant memories are NOT returned for queries where they don't belong (precision).
- Validate that the LLM extraction pipeline correctly tags and categorises memories.
- Ensure tests are deterministic and isolated — safe to run repeatedly against a shared Docker instance.
- Provide a regression harness for future CLI and API changes.

---

## 3. User Stories

---

### E2E-001: Test Infrastructure & Setup

**Description:** As an AI agent implementing the test suite, I need a `bun:test` file with lifecycle hooks, a realistic dataset, and a complete `beforeAll` ingestion routine so that all subsequent test stories have a working foundation to build on.

**This story covers:**
- The `bun:test` file skeleton with `beforeAll`/`afterAll` hooks.
- A `buildDataset()` function that generates fixture files.
- The `beforeAll` routine: health check, dataset generation, ingesting all fixtures, and building an ID lookup map.
- The `afterAll` teardown: deleting all ingested memories and removing the temp directory.

**Acceptance Criteria:**

*File & constants:*
- [ ] File created at `e2e/e2e.test.ts` using `import { describe, test, expect, beforeAll, afterAll } from "bun:test"`.
- [ ] A `RUN_ID` constant is generated at module load time: `const RUN_ID = \`e2e-${Date.now()}\``. Used as a prefix for all ingested memory `source` labels (e.g. `e2e-run-<RUN_ID>/tokyo-ramen`).
- [ ] A `MIN_SCORE = 0.5` constant is defined at the top of the file. All semantic search score assertions reference this constant.
- [ ] A `runCli(args: string[]): { stdout: string; stderr: string; exitCode: number }` helper is defined. It calls `Bun.spawnSync(["bun", "run", "apps/cli/src/index.ts", ...args], { env: { ...process.env } })` and returns decoded stdout/stderr and the exit code.

*Dataset (`buildDataset(dir: string): DatasetFile[]`):*
- [ ] `DatasetFile` type is defined: `{ filePath: string; label: string; collection?: string }`.
- [ ] Creates the target directory if it doesn't exist.
- [ ] Writes the following fixture files with realistic prose content (not placeholder text):

  | Label | Filename | Content Summary | Collection |
  |---|---|---|---|
  | `tokyo-ramen` | `tokyo-ramen.md` | X bookmark: hidden ramen shop in Ikebukuro, Tokyo. Mentions "Mutekiya", tsukemen, cash only, 30-min wait. | `travel` |
  | `sydney-degustation` | `sydney-degustation.md` | Safari bookmark: article "Sydney's Best Degustation Menus". Mentions "Sixpenny" in Stanmore. | `travel` |
  | `surry-hills-wine-bar` | `surry-hills-wine-bar.md` | Apple Note: wine bar recommendation in Surry Hills, Sydney. Good for special occasions. | *(none)* |
  | `japanese-learning` | `japanese-learning.md` | Reddit save: "Optimal 30-Day Framework for Learning Japanese". Mentions Tofugu, Hiragana, WaniKani. | *(none)* |
  | `react-performance` | `react-performance.md` | Notion note: React performance tuning tips. Mentions memoization, useCallback, React DevTools. | *(none)* |
  | `docker-deployment` | `docker-deployment.md` | Pocket bookmark: Docker deployment strategy blog post. Mentions multi-stage builds, docker-compose. | *(none)* |
  | `book-recommendations` | `book-recommendations.md` | Apple Note: list of fiction and non-fiction book recommendations. | *(none)* |
  | `home-measurements` | `home-measurements.md` | Apple Note: home improvement measurements, room dimensions, paint colours. | *(none)* |
  | `exact-match-control` | `exact-match-control.md` | Any content containing the string `XYZZY_TEST_KEYWORD` verbatim. | *(none)* |

- [ ] Returns the array of `DatasetFile` objects. `tokyo-ramen` and `sydney-degustation` have `collection: "travel"`; the rest have no `collection`.

*`beforeAll`:*
- [ ] Calls `runCli(["health", "--json"])`. If exit code is non-zero or parsed `status !== "ok"`, throws: `"Kore API is not reachable. Start the Docker stack before running E2E tests."` — aborting all tests.
- [ ] Calls `buildDataset(\`/tmp/kore-e2e-${RUN_ID}\`)` and stores the result.
- [ ] Iterates over the dataset. For each file, runs: `runCli(["ingest", filePath, "--source", \`e2e-run-${RUN_ID}/${label}\`, "--json"])`. Appends `--collection <collection>` if the file has one. Asserts exit code `0` for each.
- [ ] After all files are ingested, waits 3 seconds (`await Bun.sleep(3000)`) to allow the QMD file watcher to re-index.
- [ ] Runs `runCli(["list", "--json"])`, parses the result, and builds a `labelToId: Map<string, string>` by filtering results whose `source` starts with `e2e-run-${RUN_ID}` and matching the label suffix. This map is used by later test stories to look up memory IDs.
- [ ] Populates an `ingestedIds: string[]` array from the map values.

*`afterAll`:*
- [ ] Wrapped in `try/finally` so it runs even if tests fail.
- [ ] Iterates `ingestedIds` and calls `runCli(["delete", id, "--force"])` for each.
- [ ] Removes the temp dataset directory (`/tmp/kore-e2e-${RUN_ID}`).

*Quality:*
- [ ] Typecheck passes (`bunx tsc --noEmit`).
- [ ] Running `bun test e2e/e2e.test.ts` against a healthy stack exits with code `0` (no tests yet, but hooks run without error).

---

### E2E-002: Ingestion Tests

**Description:** As an AI agent implementing the test suite, I need tests that verify the ingestion workflow — list verification, the async `--no-wait` path, and edge case error handling — so that the CLI's ingestion commands are fully covered.

**Depends on:** E2E-001 (test file, `runCli`, `RUN_ID`, `labelToId` map, `ingestedIds` array).

**Acceptance Criteria:**

*Test 1 — `test("kore list shows all ingested memories")`:*
- [ ] Runs `runCli(["list", "--json"])`.
- [ ] Asserts exit code `0`.
- [ ] Filters results to those whose `source` starts with `e2e-run-${RUN_ID}`.
- [ ] Asserts the filtered count equals `9` (the number of dataset fixtures).
- [ ] Asserts each of the 9 labels (e.g. `tokyo-ramen`, `japanese-learning`) appears in at least one result's `source`.

*Test 2 — `test("async ingest --no-wait completes via kore status polling")`:*
- [ ] Writes a small temp file: `await Bun.write(\`/tmp/kore-e2e-${RUN_ID}/async-test.md\`, "Async ingestion test content.")`.
- [ ] Runs `runCli(["ingest", filePath, "--source", \`e2e-run-${RUN_ID}/async-test\`, "--no-wait", "--json"])`. Asserts exit code `0`.
- [ ] Parses the JSON response and extracts `task_id`.
- [ ] Polls `runCli(["status", taskId, "--json"])` in a loop (max 30 iterations, 2-second delay between each using `await Bun.sleep(2000)`) until `status` is `"completed"` or `"failed"`.
- [ ] Asserts final `status` is `"completed"`.
- [ ] Looks up the resulting memory ID via `kore list --json` by source and adds it to `ingestedIds`.

*Test 3 — `test("ingest empty file exits with error")`:*
- [ ] Writes a zero-byte file to the temp dir.
- [ ] Runs `runCli(["ingest", filePath, "--json"])`.
- [ ] Asserts exit code is non-zero.
- [ ] Asserts stdout or stderr contains a human-readable error message (not a raw JS stack trace — asserts it does NOT contain `"TypeError"` or `"undefined"`).

*Test 4 — `test("ingest whitespace-only file exits with error")`:*
- [ ] Writes a file containing only `"   \n\n   "`.
- [ ] Runs `runCli(["ingest", filePath, "--json"])`.
- [ ] Asserts exit code is non-zero.
- [ ] Asserts error output does not contain `"TypeError"` or `"undefined"`.

*Test 5 — `test("ingest duplicate source is handled gracefully")`:*
- [ ] Re-runs `runCli(["ingest", tokyoRamenFilePath, "--source", \`e2e-run-${RUN_ID}/tokyo-ramen\`, "--json"])` (same source label as the original ingest in `beforeAll`).
- [ ] Asserts the CLI does not crash (exit may be `0` or non-zero — either is acceptable).
- [ ] If exit code is `0` and a new memory ID is returned, adds it to `ingestedIds` for teardown.

*Quality:*
- [ ] Typecheck passes.

---

### E2E-003: Core Search Tests

**Description:** As an AI agent implementing the test suite, I need four search tests — exact match, semantic/thematic, contextual recall, and cross-domain — each asserting both recall and precision, so that the core retrieval quality of the memory system is validated.

**Depends on:** E2E-001 (dataset ingested, `runCli`, `MIN_SCORE`).

**Acceptance Criteria:**

*Test 1 — `test("exact match: XYZZY_TEST_KEYWORD")`:*
- [ ] Runs `runCli(["search", "XYZZY_TEST_KEYWORD", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** At least one result's `title` or `snippet` contains `"XYZZY_TEST_KEYWORD"`, or the result's source corresponds to the `exact-match-control` fixture.
- [ ] **Precision:** No result's `title` or `snippet` contains `"docker"` or `"react"` (case-insensitive).

*Test 2 — `test("semantic search: anniversary dinner ideas in Sydney")`:*
- [ ] Runs `runCli(["search", "anniversary dinner ideas in Sydney", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** The `sydney-degustation` memory appears (snippet or title contains `"Sydney"` or `"Degustation"` or `"Sixpenny"`).
- [ ] **Recall:** The `surry-hills-wine-bar` memory appears (snippet or title contains `"Surry Hills"` or `"wine"`).
- [ ] **Score:** Top result's `score >= MIN_SCORE`.
- [ ] **Precision:** No result's `title` or `snippet` contains `"Japanese"` or `"Tofugu"`.

*Test 3 — `test("contextual recall: I want to start learning Japanese")`:*
- [ ] Runs `runCli(["search", "I want to start learning Japanese", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** The `japanese-learning` memory appears (snippet or title contains `"Japanese"`, `"Tofugu"`, or `"Hiragana"`).
- [ ] **Score:** Top result's `score >= MIN_SCORE`.
- [ ] **Precision:** No result's `title` or `snippet` contains `"Sydney"` or `"Sixpenny"`.

*Test 4 — `test("cross-domain search: tech deployment strategies")`:*
- [ ] Runs `runCli(["search", "tech deployment strategies", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** `docker-deployment` memory appears (snippet contains `"Docker"` or `"deployment"`).
- [ ] **Recall:** `react-performance` memory appears (snippet contains `"React"` or `"performance"`).
- [ ] **Precision:** No result's `title` or `snippet` contains `"ramen"` or `"Japanese"` (case-insensitive).

*Quality:*
- [ ] Typecheck passes.

---

### E2E-004: Advanced Search Tests

**Description:** As an AI agent implementing the test suite, I need tests for the `--intent` and `--collection` search flags so that these CLI options are validated and confirmed to not degrade or incorrectly scope retrieval.

**Depends on:** E2E-001 (dataset ingested, `runCli`).

**Acceptance Criteria:**

*Test 1 — `test("intent search: where should I eat in Tokyo")`:*
- [ ] Runs `runCli(["search", "where should I eat in Tokyo", "--intent", "personal travel and food bookmarks", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** The `tokyo-ramen` memory appears (snippet or title contains `"Tokyo"`, `"ramen"`, or `"Mutekiya"`).
- [ ] **Non-regression:** Also runs the same query *without* `--intent`. Asserts `tokyo-ramen` still appears in that result set too, confirming `--intent` doesn't degrade results.

*Test 2 — `test("collection filter: travel collection scopes results")`:*
- [ ] Runs `runCli(["search", "restaurant", "--collection", "travel", "--json"])`. Asserts exit code `0`.
- [ ] **Recall:** At least one result has `collection === "travel"`.
- [ ] **Precision:** All results have `collection === "travel"` — no cross-collection leakage.
- [ ] **Precision:** No result source corresponds to `book-recommendations` or `home-measurements` (default collection fixtures).

*Quality:*
- [ ] Typecheck passes.

---

### E2E-005: Deep Validation (Metadata Extraction & Full Chain)

**Description:** As an AI agent implementing the test suite, I need tests that call `kore show <id>` to validate LLM-extracted metadata and full content integrity so that the intelligence layer — not just retrieval — is verified end-to-end.

**Background:** The `id` field is now included in search results via `MemoryIndex.getIdByPath` (implemented in `apps/core-api/src/app.ts`). The `kore show <id> --json` response returns a `MemoryFull` object: `{ id, title, type, category, source, tags, url?, content }` where `content` is the full markdown including frontmatter.

**Depends on:** E2E-001 (`labelToId` map, `runCli`).

**Acceptance Criteria:**

*Test 1 — `test("LLM extraction: tokyo-ramen has travel/food metadata")`:*
- [ ] Looks up the `tokyo-ramen` ID from `labelToId`.
- [ ] Runs `runCli(["show", id, "--json"])`. Asserts exit code `0`.
- [ ] Asserts `tags` array contains at least one of: `"travel"`, `"food"`, `"ramen"`, `"tokyo"` (case-insensitive comparison).
- [ ] Asserts `category` contains `"travel"` or `"food"` (e.g. `"qmd://travel/food/japan"`).

*Test 2 — `test("LLM extraction: japanese-learning has hobby/language metadata")`:*
- [ ] Looks up the `japanese-learning` ID from `labelToId`.
- [ ] Runs `runCli(["show", id, "--json"])`. Asserts exit code `0`.
- [ ] Asserts `tags` contains at least one of: `"japanese"`, `"language"`, `"learning"`, `"hobby"` (case-insensitive).
- [ ] Asserts `category` contains `"hobby"` or `"language"`.

*Test 3 — `test("LLM extraction: sydney-degustation has Sydney location context")`:*
- [ ] Looks up the `sydney-degustation` ID from `labelToId`.
- [ ] Runs `runCli(["show", id, "--json"])`. Asserts exit code `0`.
- [ ] Asserts the `content` field contains `"Sydney"`.
- [ ] Asserts `category` contains `"travel"` or `"food"`.

*Test 4 — `test("full chain: search → extract id → kore show")`:*
- [ ] Runs `runCli(["search", "hidden ramen shop in Tokyo", "--json"])`. Asserts exit code `0` and at least one result.
- [ ] Extracts `id` from `results[0]`. Asserts `id` is a non-null, non-empty string.
- [ ] Runs `runCli(["show", id, "--json"])`. Asserts exit code `0`.
- [ ] Asserts the response contains all required fields: `id`, `title`, `type`, `category`, `source`, `tags`, `content`.
- [ ] Asserts `content` contains a substring from the original fixture (e.g. `"Mutekiya"` or `"Ikebukuro"`).
- [ ] Asserts the `id` in the `kore show` response matches the `id` extracted from the search result.

*Quality:*
- [ ] Typecheck passes.

---

## 4. Functional Requirements

- **FR-1:** The test file must use `bun:test` and be runnable with `bun test e2e/e2e.test.ts`.
- **FR-2:** All CLI invocations must use `Bun.spawnSync` targeting `apps/cli/src/index.ts` (not a globally installed `kore` binary) so tests work in a fresh repo checkout.
- **FR-3:** All memories ingested during a test run must be cleaned up in `afterAll`, even if tests fail.
- **FR-4:** `MIN_SCORE = 0.5` must be defined once and referenced in all score assertions.
- **FR-5:** `RUN_ID` must namespace all ingested memory `source` labels to prevent cross-run pollution.
- **FR-6:** Dataset files must be written to `/tmp/kore-e2e-<RUN_ID>/` and removed in `afterAll`.
- **FR-7:** The `beforeAll` health check must abort all tests with a clear message if `kore health` fails.
- **FR-8:** Search tests must assert both recall (expected document appears) AND precision (unrelated documents do not appear).
- **FR-9:** All ingested memory IDs must be tracked in `ingestedIds: string[]` and cleaned up in `afterAll`.
- **FR-10:** `kore show` responses must be parsed as `MemoryFull`: `{ id, title, type, category, source, tags, url?, content }`.

---

## 5. Non-Goals

- No MCP connectivity or agentic retrieval testing (next phase).
- No CI/CD pipeline integration (next phase).
- No performance or load testing.
- No testing against a remote or cloud-hosted Kore instance.
- No UI or frontend testing.
- No testing of the notification worker or push-channel features.

---

## 6. Technical Considerations

- **CLI invocation:** `Bun.spawnSync` returns `{ stdout: Uint8Array, stderr: Uint8Array, exitCode: number }`. Decode with `new TextDecoder().decode(result.stdout)`.
- **ID resolution:** The synchronous ingest response returns `task_id`, not the memory `id`. Build the `labelToId` map after ingestion by calling `kore list --json` and matching `source` fields. The `labelToId` map is shared state used by E2E-002, E2E-005.
- **Collection ingestion:** Confirm whether `kore ingest` supports a `--collection` flag by checking `apps/cli/src/commands/ingest.ts`. If not supported, ingest without it and mark E2E-004 Test 2 as blocked with a descriptive `test.skip`.
- **QMD indexing delay:** `--wait` blocks until the task is `completed`, but QMD re-indexing has a 2-second file-watcher debounce. The `Bun.sleep(3000)` at the end of `beforeAll` ingestion accounts for this. If search tests still return stale results, increase to `5000`.
- **Teardown:** Always use `--force` with `kore delete` to skip the confirmation prompt.

---

## 7. Success Metrics

- All 5 stories implemented, all tests pass with `0 failures` against a healthy local Docker stack with Ollama running `qwen2.5:7b`.
- Semantic search tests (US-003 Tests 2 & 3) achieve top-result scores `>= 0.5`.
- LLM extraction tests (E2E-005 Tests 1–3) confirm at least 2 of 3 memories have correctly extracted tags and category.
- Test suite completes in under 5 minutes (dominated by LLM extraction time in `beforeAll`).
- Running the suite twice in a row produces identical results (no cross-run pollution).

---

## 8. Open Questions

- **Collection flag:** Does `kore ingest` support a `--collection` flag? Check `apps/cli/src/commands/ingest.ts`. If not, E2E-004 Test 2 must be skipped or the ingestion strategy revised.
- **Ingest response shape:** Does the synchronous (`--wait`) ingest JSON response include the memory `id` directly, or only `task_id`? The `labelToId` map strategy depends on this — if `id` is returned directly, the `kore list` correlation step can be skipped.
- **Score sensitivity:** `MIN_SCORE = 0.5` is an initial estimate. After a first run, observe actual scores and adjust the constant if needed to be meaningful without being brittle.

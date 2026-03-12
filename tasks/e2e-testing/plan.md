# End-to-End Testing Plan: Ingestion and Search

## 1. Objective
Perform a comprehensive end-to-end (E2E) test of the Kore ingestion and search workflows using the Kore CLI. The test will validate that various types of personal data can be successfully ingested, properly indexed, and accurately retrieved. Crucially, the tests will verify that Kore acts as a personal memory system capable of connecting "disconnected" memories via semantic and contextual search, aligning with the project's vision while accommodating a broad range of use cases.

**Out of Scope (Next Phase):**
- MCP connectivity and agentic retrieval via AI assistants — to be validated once the memory system quality is established.
- CI/CD pipeline integration.

## 2. Test Isolation & Teardown
All E2E tests run against a live local Docker instance and must be deterministic across repeated runs. Without isolation, stale memories from prior runs pollute relevance scores and can cause false positives or negatives.

- **Namespacing:** Every memory ingested during a test run must be tagged with a unique run ID (e.g., `e2e-run-<timestamp>`) via the `source` field so it can be identified and cleaned up.
- **Teardown:** After each run, the script calls `kore delete` for every memory ingested during that run. This must execute even if tests fail (i.e., use a `try/finally` block).
- **Pre-condition Check:** Before running any tests, assert `kore health` returns a healthy status. Fail immediately with a clear error message if the API is unreachable.

## 3. Test Dataset Generation
To reflect real-world usage and the "Recall Disconnect" problem, the dataset must include diverse formats and cover both specific vision-aligned scenarios and broader, everyday use cases.

- **Location:** Generate files programmatically in a temporary directory at test runtime (not checked in). Clean up the directory on teardown.
- **Content Types to Generate:**
  - **Markdown/Plaintext Notes:** Simulating Apple Notes or Obsidian entries (e.g., raw text, lists).
  - **Web Bookmarks:** Simulating Safari/Chrome or Pocket saves (URLs with titles and short text excerpts).
  - **Social Media Saves:** Simulating X (Twitter) or Reddit bookmarks (short-form text, threads, or URLs).
  - *Known Shortcoming - Closed Ecosystems:* We will include mock Instagram/TikTok URLs. Currently, Kore may only ingest the raw URL or basic text without extracting rich video/image media, reflecting the technical boundaries in the vision document.
- **Thematic Scenarios (Vision & Beyond):**
  - *Vision Scenarios:*
    - Travel & Food: A review of a hidden ramen shop in Tokyo (with address/neighborhood detail); a list of Sydney degustation menus; a wine bar recommendation in Surry Hills.
    - Hobbies: A detailed Reddit framework for learning Japanese (multi-step plan mentioning Tofugu, Hiragana, vocabulary).
  - *Broader Scenarios:*
    - Technical: A disconnected note about "React performance tuning" and a separate bookmark for a "Docker deployment strategy" blog post. These are thematically unrelated to the vision scenarios and serve as noise/negative controls.
    - Everyday Life: A random list of book recommendations; a note about home improvement measurements.
  - *Collection Segregation:* Ingest at least two memories into a named collection (e.g., `travel`) and the rest into the default collection, to enable collection-filter tests.
- **Identifiable Anchors:** Inject specific, unique keywords (e.g., `XYZZY_TEST_KEYWORD`) into a few files to serve as baseline exact-match controls.

## 4. Ingestion Workflow
We will use the Kore CLI to ingest the diverse dataset into the system.

- **CLI Execution:**
  `--wait` is the default behavior for `kore ingest` (blocks until the backend task completes). We ingest each file individually so we can capture the returned `task_id` and associate it with the memory for later teardown:
  ```
  kore ingest <file> --source "e2e-run-<id>/<label>" --json
  ```
- **Async Workflow Test:** Separately, test the `--no-wait` path:
  1. Run `kore ingest <file> --no-wait --json` and capture the `task_id`.
  2. Poll `kore status <task_id>` until the task reaches `completed` or `failed`.
  3. Assert final status is `completed`. This validates the status command and the async ingestion path.
- **Post-Ingest Verification:** After all files are ingested, run `kore list --json` and assert that all expected memories appear. This is a basic sanity check before executing search tests.
- **Edge Case Ingestion:** Include the following error/boundary cases and assert graceful handling (non-zero exit code with a clear error, no crash):
  - An empty file.
  - A file containing only whitespace.
  - A duplicate `source` value (re-ingesting an already-ingested path).

## 5. Search and Retrieval Workflow
Kore is a contextual memory engine, not just a keyword database. The retrieval tests must validate both its ability to surface the right results (recall) and its ability to exclude irrelevant results (precision).

All search tests use `kore search <query> --json` and assert on the parsed JSON response.

### 5.1 Search Test Cases

1. **Baseline Exact Match**
   - Command: `kore search "XYZZY_TEST_KEYWORD" --json`
   - Assert (recall): The exact control document appears in results.
   - Assert (precision): The Docker/React notes do NOT appear in results.

2. **Semantic / Thematic Search**
   - Command: `kore search "anniversary dinner ideas in Sydney" --json`
   - Assert (recall): The "Sydney degustation menus" bookmark and "wine bar" note appear, even though neither contains the word "anniversary".
   - Assert (precision): The Japanese learning framework does NOT appear.
   - Assert (score): Top result has a relevance score above a defined minimum threshold (e.g., `>= 0.5`).

3. **Hobby / Contextual Recall**
   - Command: `kore search "I want to start learning Japanese" --json`
   - Assert (recall): The Reddit Japanese learning framework appears.
   - Assert (precision): The Sydney restaurant memories do NOT appear.
   - Assert (score): Top result score is above threshold.

4. **Cross-Domain Search**
   - Command: `kore search "tech deployment strategies" --json`
   - Assert (recall): The Docker deployment bookmark and React performance note appear.
   - Assert (precision): The Tokyo ramen or Japanese learning memories do NOT appear.

5. **Natural Language Intent Search**
   - Command: `kore search "where should I eat in Tokyo" --intent --json`
   - Assert (recall): The Tokyo ramen review appears.
   - Assert: Results are not degraded compared to a plain query (validates the `--intent` flag doesn't break retrieval).

6. **Collection-Scoped Search**
   - Command: `kore search "restaurant" --collection travel --json`
   - Assert: Only memories from the `travel` collection appear; the book recommendations note (in default collection) does NOT appear.

### 5.2 Score Threshold
Define a minimum acceptable relevance score constant (e.g., `MIN_SCORE = 0.5`) at the top of the test file. All "recall" assertions on semantic/contextual queries must also assert the matched result's score meets this threshold. If the system retrieves the right document but with a very low score, the test should still fail — it indicates the memory system is not working correctly.

## 6. Metadata & LLM Extraction Validation
The vision depends on LLMs extracting structured metadata from raw content (tags, categories, geographic context, intent). This must be explicitly validated, not assumed.

- **After ingesting, use `kore show <id> --json` to assert:**
  - The Tokyo ramen memory has a tag or category matching `Travel` or `Food`.
  - The Japanese learning memory has a tag or category matching `Hobby` or `Language`.
  - The Sydney restaurant memories contain location context (city: Sydney).
- **Prerequisite:** This section depends on the `id` fix described in Section 7 (Limitation 2). Until that is resolved, metadata validation is blocked and tracked as a known gap.

## 7. Addressing CLI Limitations

### Limitation 1: Truncated Snippets in Standard Output
- **Issue:** `kore search` truncates snippets to 200 characters in standard formatted output.
- **Workaround:** Use `--json` flag for all test assertions. Note that even the JSON response returns a `snippet`, not the full content — full content requires `kore show`.

### Limitation 2: Missing `id` in Search Results
- **Issue:** `kore search` returns `SearchResult` objects with `path`, `title`, `snippet`, `score`, and `collection` — but **no memory `id`**.
- **Impact:** Cannot chain to `kore show <id>` for full content and metadata validation. Blocks Section 6.
- **Investigation First:** Before implementing a fix, verify whether the `id` is already encoded in the `path` field returned by the API (the backend parses `collection` from `displayPath`, suggesting the path may be structured). If extractable, no API change is needed.
- **Proposed Fix (if `id` is not in `path`):** Modify `POST /api/v1/search` to include `id` in the response body, and update the `SearchResult` interface in `apps/cli/src/commands/search.ts` to expose it.
- **E2E Chain (once resolved):** `kore search "query" --json` → extract `id` → `kore show <id> --json` → assert full content and metadata.

### Limitation 3: Directory Ingestion
- **Issue:** `kore ingest` expects explicit file paths, not directories.
- **Workaround:** The test script programmatically reads the temp dataset directory and passes the full array of file paths to the CLI. No shell expansion.

## 8. Execution Strategy
- **Test Framework:** Implement as a `tasks/e2e-testing/e2e.test.ts` file using `bun:test`. This integrates with the project's existing `bun test` infrastructure, gives structured pass/fail output, and allows running with `bun test tasks/e2e-testing/`.
- **Script Structure:**
  1. `beforeAll`: Assert `kore health`. Generate the temp dataset directory. Ingest all files (synchronous, capturing `task_id`s and memory paths). Run `kore list` sanity check.
  2. Test cases: Each search test is a `test()` block that parses JSON output and runs assertions.
  3. `afterAll`: Delete all memories ingested in this run. Remove the temp dataset directory.
- **Environment:** Run against the local Docker instance of Kore (`docker-compose up`). Required environment variables: `KORE_API_KEY`, `KORE_BASE_URL` (default: `http://localhost:3000`), `OLLAMA_BASE_URL`.

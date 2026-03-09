# Manual End-to-End Testing Guide

This guide walks through every layer of the Kore pipeline with exact commands you can run to validate the system is working correctly. Work through the scenarios in order — each builds on the previous.

---

## Prerequisites

Before starting, ensure all of the following are true:

```sh
# 1. Bun is installed
bun --version

# 2. Ollama is running and the model is available
ollama list           # should show qwen2.5:7b (or your configured model)
curl http://localhost:11434/api/tags   # should return JSON with models

# 3. QMD is installed
qmd --version

# 4. .env is configured at the monorepo root
cat .env
# Expected keys: KORE_DATA_PATH, KORE_API_KEY, OLLAMA_BASE_URL, OLLAMA_MODEL

# 5. The API is running (in a separate terminal)
cd apps/core-api
bun run start
# Expected output:
#   Memory index built: N files indexed
#   Kore Core API running on http://localhost:3000
#   Kore extraction worker started (polling every 5s)
#   Kore file watcher started (watching for .md changes)
```

Set your API key as an environment variable for the commands below:

```sh
export KORE_API_KEY="your-secret-key-here"
export KORE_URL="http://localhost:3000"
```

---

## Scenario 1 — Health Check

**Goal:** Confirm the API is up, QMD is reachable, and the queue starts empty.

```sh
curl -s $KORE_URL/api/v1/health | jq .
```

**Expected response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "qmd_status": "online",
  "queue_length": 0
}
```

**What to validate:**
- `status` is `"ok"`
- `qmd_status` is `"online"` (if `"unavailable"`, check `qmd status` in your terminal)
- `queue_length` is `0` (if non-zero, prior tasks may be stuck)
- No `Authorization` header is required for this endpoint

---

## Scenario 2 — Raw Ingest & Queue Validation

**Goal:** Send raw text, confirm it lands in the queue with `queued` status, watch it transition to `completed`.

### Step 1: Send a raw ingest request

```sh
TASK=$(curl -s -X POST $KORE_URL/api/v1/ingest/raw \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual-test",
    "content": "John recommended Mutekiya in Ikebukuro for solo dining. Cash only, get the tsukemen. Usually a 30 min wait.",
    "priority": "normal"
  }' | jq -r '.task_id')

echo "Task ID: $TASK"
```

**Expected response body:**
```json
{
  "status": "queued",
  "task_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "message": "Enrichment added to queue."
}
```

### Step 2: Poll task status

```sh
curl -s $KORE_URL/api/v1/task/$TASK \
  -H "Authorization: Bearer $KORE_API_KEY" | jq .
```

Poll a few times (the worker picks it up within 5 seconds):

```sh
# Watch it transition: queued → processing → completed
watch -n 2 "curl -s $KORE_URL/api/v1/task/$TASK \
  -H 'Authorization: Bearer $KORE_API_KEY' | jq ."
```

**What to validate:**
- Initial status is `"queued"`
- Status transitions to `"processing"` (briefly, may be hard to catch)
- Final status is `"completed"`
- `error_log` is `null` on success

### Step 3: Inspect the SQLite queue directly

```sh
# From apps/core-api/ directory (where kore-queue.db lives)
sqlite3 apps/core-api/kore-queue.db \
  "SELECT id, status, priority, retries, created_at FROM tasks ORDER BY created_at DESC LIMIT 10;"
```

**What to validate:**
- Your task row shows `status = 'completed'`
- `retries = 0` on a successful first attempt

### Bonus: Try all three priorities

```sh
for PRIORITY in low normal high; do
  curl -s -X POST $KORE_URL/api/v1/ingest/raw \
    -H "Authorization: Bearer $KORE_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"source\": \"priority-test\", \"content\": \"Test content for $PRIORITY priority.\", \"priority\": \"$PRIORITY\"}" | jq .
done
```

Check the SQLite table — `high` priority tasks should complete before `low`.

---

## Scenario 3 — Verify Markdown File Generation

**Goal:** Confirm the worker wrote a properly structured `.md` file to disk.

```sh
# List all memory files (replace ~/kore-data with your KORE_DATA_PATH if different)
find ~/kore-data -name "*.md" | sort

# List just the places directory (where the ramen memory should land)
ls -la ~/kore-data/places/
```

```sh
# Read the generated file
cat ~/kore-data/places/mutekiya-ramen.md
```

**Expected file structure:**
```markdown
---
id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
type: place
category: qmd://travel/food/japan
date_saved: 2026-03-09T...
source: manual-test
tags: ["ramen", "ikebukuro", "cash-only", "solo-dining"]
---

# Mutekiya Ramen

## Distilled Memory Items
- **Mutekiya is a ramen shop in Ikebukuro, Tokyo.**
- **Cash only.**
- **The tsukemen is the recommended order.**
- **Expect approximately a 30 minute wait.**

---
## Raw Source
John recommended Mutekiya in Ikebukuro for solo dining. Cash only, get the tsukemen. Usually a 30 min wait.
```

**What to validate:**
- File exists in the correct subdirectory (`places/`, `media/`, `notes/`, or `people/`)
- YAML frontmatter block is present (`---` ... `---`)
- `id` field is a valid UUID
- `category` starts with `qmd://`
- `tags` array has ≤ 5 entries
- `## Distilled Memory Items` section has 1–7 bullet points
- `## Raw Source` section contains the original unmodified text

### Test file collision handling

Ingest the same content twice. The second file should get a hash suffix:

```sh
for i in 1 2; do
  curl -s -X POST $KORE_URL/api/v1/ingest/raw \
    -H "Authorization: Bearer $KORE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"source": "collision-test", "content": "Spirited Away is a 2001 Miyazaki animated film."}'
done

# Wait for both to complete, then check for the hash-suffixed file:
ls ~/kore-data/media/
# Expected: spirited-away.md AND spirited-away_a1b2.md (4-char hash varies)
```

---

## Scenario 4 — Structured Ingest (No LLM)

**Goal:** Bypass LLM extraction with a fully-formed payload. Useful when Ollama is unavailable or you have structured data already.

```sh
RESULT=$(curl -s -X POST $KORE_URL/api/v1/ingest/structured \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": {
      "title": "Spirited Away",
      "markdown_body": "A 2001 animated film by Studio Ghibli. One of the highest-grossing films in Japanese history.",
      "frontmatter": {
        "type": "media",
        "category": "qmd://media/film/animation",
        "date_saved": "2026-03-09T00:00:00.000Z",
        "source": "manual-test",
        "tags": ["miyazaki", "anime", "studio-ghibli", "film"]
      }
    }
  }')

echo $RESULT | jq .
FILE_PATH=$(echo $RESULT | jq -r '.file_path')
echo "Written to: $FILE_PATH"
```

**Expected response:**
```json
{
  "status": "indexed",
  "file_path": "/Users/you/kore-data/media/spirited-away.md"
}
```

**What to validate:**
- Status code is `200` (not `202` — this is synchronous)
- `file_path` is an absolute path to an existing file
- File exists on disk: `cat "$FILE_PATH"`
- No `## Distilled Memory Items` section (structured ingest doesn't run LLM)

---

## Scenario 5 — Memory Management (DELETE and PUT)

**Goal:** Verify the CRUD endpoints work and the in-memory index stays in sync.

### Step 1: Get a memory's ID

```sh
# Extract the ID from the frontmatter of the structured ingest file
MEMORY_ID=$(grep "^id:" "$FILE_PATH" | awk '{print $2}')
echo "Memory ID: $MEMORY_ID"
```

Or use this one-liner to list all IDs and paths:

```sh
grep -r "^id:" ~/kore-data --include="*.md" -h | awk '{print $2}'
```

### Step 2: Update the memory (PUT)

```sh
curl -s -X PUT $KORE_URL/api/v1/memory/$MEMORY_ID \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": {
      "title": "Spirited Away (Updated)",
      "markdown_body": "Updated notes: Won the Academy Award for Best Animated Feature in 2003.",
      "frontmatter": {
        "type": "media",
        "category": "qmd://media/film/animation",
        "date_saved": "2026-03-09T00:00:00.000Z",
        "source": "manual-test",
        "tags": ["miyazaki", "oscar-winner", "studio-ghibli"]
      }
    }
  }' | jq .
```

**Expected response:**
```json
{
  "status": "updated",
  "id": "xxxxxxxx-...",
  "file_path": "/Users/you/kore-data/media/spirited-away-updated.md"
}
```

**What to validate:**
- The new file exists with the updated content
- If the title changed, the old file is gone and a new file was created
- The memory is findable by the same `id` in the new file's frontmatter

### Step 3: Delete the memory (DELETE)

```sh
curl -s -X DELETE $KORE_URL/api/v1/memory/$MEMORY_ID \
  -H "Authorization: Bearer $KORE_API_KEY" | jq .
```

**Expected response:**
```json
{
  "status": "deleted",
  "id": "xxxxxxxx-..."
}
```

**What to validate:**
- `200 OK` response
- File is gone from disk: `ls ~/kore-data/media/`
- A second DELETE of the same ID returns `404`:
  ```sh
  curl -s -X DELETE $KORE_URL/api/v1/memory/$MEMORY_ID \
    -H "Authorization: Bearer $KORE_API_KEY" | jq .
  # Expected: {"error": "Memory not found", "code": "NOT_FOUND"}
  ```

---

## Scenario 6 — QMD Indexing Validation

**Goal:** Confirm QMD has indexed the generated memory files and can serve them for retrieval.

### Step 1: Check QMD status and collections

```sh
qmd status
qmd collection list
```

**What to validate:**
- `qmd status` exits cleanly (no error)
- `qmd collection list` shows your `kore-memory` collection pointing to `~/kore-data`

### Step 2: Force an update and verify

The file watcher triggers `qmd update` automatically after a 2-second debounce. You can also trigger it manually:

```sh
qmd update
```

### Step 3: Query a known memory

After generating the Mutekiya memory from Scenario 2:

```sh
qmd query "ramen ikebukuro"
qmd query "tsukemen cash only"
qmd query "solo dining tokyo"
```

**What to validate:**
- Results reference the correct file (`mutekiya-ramen.md`)
- The distilled facts appear in the query results
- Queries about content NOT in your memories return no results (negative test)

### Step 4: Verify watcher triggers automatically

In one terminal, watch the API logs. In another, ingest a new memory:

```sh
curl -s -X POST $KORE_URL/api/v1/ingest/structured \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": {
      "title": "Watcher Test Memory",
      "markdown_body": "This tests the automatic QMD re-index trigger.",
      "frontmatter": {
        "type": "note",
        "category": "qmd://admin/testing",
        "date_saved": "2026-03-09T00:00:00.000Z",
        "source": "watcher-test",
        "tags": ["test"]
      }
    }
  }' | jq .
```

**What to validate (in API logs):**
- Within 2–3 seconds of the file being written, you should see no errors from the watcher
- `qmd query "watcher test"` returns the new memory

---

## Scenario 7 — Queue Resilience (Offline Ollama)

**Goal:** Confirm the worker handles extraction failures gracefully — retrying up to 3 times before permanently marking the task as `failed`.

### Step 1: Stop Ollama

```sh
# macOS: if running as a process
pkill ollama
# Or if using the Ollama.app, quit it from the menu bar
```

### Step 2: Ingest while Ollama is offline

```sh
TASK=$(curl -s -X POST $KORE_URL/api/v1/ingest/raw \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "resilience-test",
    "content": "This task should fail gracefully when Ollama is offline.",
    "priority": "high"
  }' | jq -r '.task_id')

echo "Task ID: $TASK"
```

### Step 3: Watch the retries accumulate

The worker polls every 5 seconds and will retry up to 3 times. Watch the task evolve:

```sh
# Poll every 6 seconds for up to a minute
for i in $(seq 1 10); do
  curl -s $KORE_URL/api/v1/task/$TASK \
    -H "Authorization: Bearer $KORE_API_KEY" | jq '{status, error_log: .error_log}'
  sleep 6
done
```

Alternatively, inspect SQLite directly:

```sh
# Run from monorepo root
watch -n 5 "sqlite3 apps/core-api/kore-queue.db \
  \"SELECT id, status, retries, error_log FROM tasks WHERE id='$TASK';\""
```

**What to validate:**
- Task starts as `"queued"`
- After each failed attempt, `retries` increments (1 → 2 → 3)
- Between retries, status briefly shows `"processing"` then returns to `"queued"`
- After `retries = 3`, status permanently becomes `"failed"`
- `error_log` is populated with the connection error message
- The API does NOT crash — health check still returns `200`

```sh
# Confirm API is still alive
curl -s $KORE_URL/api/v1/health | jq .status
# Expected: "ok"
```

### Step 4: Restart Ollama and confirm recovery

```sh
ollama serve &
```

New tasks will now succeed. The permanently failed task stays `failed` (no automatic retry after 3 attempts). Submit a new task to confirm recovery:

```sh
curl -s -X POST $KORE_URL/api/v1/ingest/raw \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source": "recovery-test", "content": "Ollama is back online. This should succeed."}' | jq .
```

---

## Quick Reference: Useful SQLite Queries

Run these from the monorepo root against `apps/core-api/kore-queue.db`:

```sh
# All tasks with their current status
sqlite3 apps/core-api/kore-queue.db \
  "SELECT id, status, priority, retries, substr(created_at,1,19) as created FROM tasks ORDER BY created_at DESC LIMIT 20;"

# Count by status
sqlite3 apps/core-api/kore-queue.db \
  "SELECT status, COUNT(*) as count FROM tasks GROUP BY status;"

# Failed tasks with error details
sqlite3 apps/core-api/kore-queue.db \
  "SELECT id, retries, error_log FROM tasks WHERE status='failed';"

# Clear all tasks (reset for a fresh test run)
sqlite3 apps/core-api/kore-queue.db "DELETE FROM tasks;"
```

## Quick Reference: File System Checks

```sh
# Count all memory files
find ~/kore-data -name "*.md" | wc -l

# List files by type directory
find ~/kore-data -name "*.md" | sort

# Extract all IDs currently on disk
grep -r "^id:" ~/kore-data --include="*.md" | awk -F': ' '{print $2}'

# Check a specific file's frontmatter
head -10 ~/kore-data/places/mutekiya-ramen.md
```

## Quick Reference: Auth Errors

If you get `401 Unauthorized`, check:

```sh
# Confirm the key matches
echo $KORE_API_KEY
grep KORE_API_KEY .env

# Test with the exact key
curl -s $KORE_URL/api/v1/ingest/raw \
  -H "Authorization: Bearer $(grep KORE_API_KEY .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "content": "auth test"}' | jq .
```

#!/usr/bin/env bash
# Kore E2E Smoke Test
# Runs a happy-path validation of the full Kore pipeline.
#
# Usage:
#   KORE_API_KEY=your-key ./scripts/e2e-smoke.sh
#   KORE_API_KEY=your-key KORE_API_URL=http://localhost:3000 ./scripts/e2e-smoke.sh
#
# Prerequisites: API running, Ollama running with model pulled, jq installed.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

KORE_API_URL="${KORE_API_URL:-http://localhost:3000}"
KORE_API_KEY="${KORE_API_KEY:-}"
KORE_DATA_PATH="${KORE_DATA_PATH:-$HOME/kore-data}"
POLL_TIMEOUT="${POLL_TIMEOUT:-60}"  # seconds to wait for task completion
POLL_INTERVAL=3

# ─── Colours ─────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────────────────

pass() { echo -e "${GREEN}  ✓ $1${RESET}"; }
fail() { echo -e "${RED}  ✗ $1${RESET}"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${BLUE}  → $1${RESET}"; }
step() { echo -e "\n${YELLOW}[$STEP/$TOTAL_STEPS] $1${RESET}"; STEP=$((STEP + 1)); }

FAILURES=0
STEP=1
TOTAL_STEPS=6

# Cleanup tracker for files created during the test
CREATED_FILES=()
CREATED_IDS=()

cleanup() {
  if [ ${#CREATED_IDS[@]} -gt 0 ]; then
    echo -e "\n${YELLOW}Cleaning up test memories...${RESET}"
    for ID in "${CREATED_IDS[@]}"; do
      curl -s -X DELETE "$KORE_API_URL/api/v1/memory/$ID" \
        -H "Authorization: Bearer $KORE_API_KEY" > /dev/null 2>&1 || true
    done
  fi
}

trap cleanup EXIT

# ─── Guards ──────────────────────────────────────────────────────────────────

if [ -z "$KORE_API_KEY" ]; then
  echo -e "${RED}Error: KORE_API_KEY is not set.${RESET}"
  echo "Usage: KORE_API_KEY=your-key ./scripts/e2e-smoke.sh"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error: jq is required. Install with: brew install jq${RESET}"
  exit 1
fi

echo -e "${BLUE}Kore E2E Smoke Test${RESET}"
echo "  API:  $KORE_API_URL"
echo "  Data: $KORE_DATA_PATH"

# ─── Step 1: Health Check ─────────────────────────────────────────────────────

step "Health check"

HEALTH=$(curl -sf "$KORE_API_URL/api/v1/health" 2>/dev/null || echo "{}")
STATUS=$(echo "$HEALTH" | jq -r '.status // "error"')
QMD_STATUS=$(echo "$HEALTH" | jq -r '.qmd_status // "unknown"')
QUEUE_LEN=$(echo "$HEALTH" | jq -r '.queue_length // -1')

if [ "$STATUS" = "ok" ]; then
  pass "API is up (status: ok)"
else
  fail "API health check failed (got: $STATUS)"
fi

if [ "$QMD_STATUS" = "online" ]; then
  pass "QMD is online"
else
  info "QMD status: $QMD_STATUS (continuing — watcher will log errors if QMD is down)"
fi

info "Queue length: $QUEUE_LEN"

# ─── Step 2: Raw Ingest ───────────────────────────────────────────────────────

step "Raw ingest → queue"

RAW_RESPONSE=$(curl -sf -X POST "$KORE_API_URL/api/v1/ingest/raw" \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "e2e-smoke-test",
    "content": "Kore smoke test: Akihabara is the electronics district in Tokyo. Famous for anime, manga, and retro video games. Best visited on weekends when the main street is closed to traffic.",
    "priority": "high"
  }' 2>/dev/null || echo "{}")

TASK_ID=$(echo "$RAW_RESPONSE" | jq -r '.task_id // ""')
INGEST_STATUS=$(echo "$RAW_RESPONSE" | jq -r '.status // "error"')

if [ "$INGEST_STATUS" = "queued" ] && [ -n "$TASK_ID" ]; then
  pass "Raw ingest accepted (task_id: ${TASK_ID:0:8}...)"
else
  fail "Raw ingest failed: $RAW_RESPONSE"
fi

# ─── Step 3: Poll for task completion ────────────────────────────────────────

step "Wait for extraction worker to complete task (timeout: ${POLL_TIMEOUT}s)"

ELAPSED=0
TASK_STATUS=""
FILE_PATH=""

while [ $ELAPSED -lt $POLL_TIMEOUT ]; do
  TASK_RESPONSE=$(curl -sf "$KORE_API_URL/api/v1/task/$TASK_ID" \
    -H "Authorization: Bearer $KORE_API_KEY" 2>/dev/null || echo "{}")
  TASK_STATUS=$(echo "$TASK_RESPONSE" | jq -r '.status // "unknown"')

  if [ "$TASK_STATUS" = "completed" ]; then
    pass "Task completed (elapsed: ${ELAPSED}s)"
    break
  elif [ "$TASK_STATUS" = "failed" ]; then
    ERROR_LOG=$(echo "$TASK_RESPONSE" | jq -r '.error_log // "unknown error"')
    fail "Task failed permanently: $ERROR_LOG"
    break
  fi

  info "Status: $TASK_STATUS — waiting ${POLL_INTERVAL}s..."
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [ $ELAPSED -ge $POLL_TIMEOUT ] && [ "$TASK_STATUS" != "completed" ]; then
  fail "Task did not complete within ${POLL_TIMEOUT}s (last status: $TASK_STATUS)"
fi

# ─── Step 4: Verify file on disk ─────────────────────────────────────────────

step "Verify markdown file written to disk"

# Find the smoke test file (look for the source tag in any .md file)
SMOKE_FILE=$(grep -r "source: e2e-smoke-test" "$KORE_DATA_PATH" --include="*.md" -l 2>/dev/null | head -1 || echo "")

if [ -n "$SMOKE_FILE" ]; then
  pass "Markdown file found: $SMOKE_FILE"

  # Validate frontmatter
  ID_LINE=$(grep "^id:" "$SMOKE_FILE" 2>/dev/null || echo "")
  CATEGORY_LINE=$(grep "^category: qmd://" "$SMOKE_FILE" 2>/dev/null || echo "")
  HAS_DISTILLED=$(grep -c "## Distilled Memory Items" "$SMOKE_FILE" 2>/dev/null || echo "0")
  HAS_RAW=$(grep -c "## Raw Source" "$SMOKE_FILE" 2>/dev/null || echo "0")

  [ -n "$ID_LINE" ] && pass "Frontmatter has id field" || fail "Missing id in frontmatter"
  [ -n "$CATEGORY_LINE" ] && pass "Category starts with qmd://" || fail "Category missing or invalid"
  [ "$HAS_DISTILLED" -gt 0 ] && pass "Distilled Memory Items section present" || fail "Missing Distilled Memory Items section"
  [ "$HAS_RAW" -gt 0 ] && pass "Raw Source section present" || fail "Missing Raw Source section"

  # Extract ID for cleanup
  SMOKE_ID=$(echo "$ID_LINE" | awk '{print $2}')
  CREATED_IDS+=("$SMOKE_ID")
else
  fail "No markdown file found with source 'e2e-smoke-test' in $KORE_DATA_PATH"
fi

# ─── Step 5: Structured Ingest ───────────────────────────────────────────────

step "Structured ingest (bypass LLM)"

STRUCT_RESPONSE=$(curl -sf -X POST "$KORE_API_URL/api/v1/ingest/structured" \
  -H "Authorization: Bearer $KORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": {
      "title": "Kore Smoke Test Note",
      "markdown_body": "This note was created by the e2e smoke test script.",
      "frontmatter": {
        "type": "note",
        "category": "qmd://admin/testing",
        "date_saved": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
        "source": "e2e-smoke-test-structured",
        "tags": ["smoke-test", "automated"]
      }
    }
  }' 2>/dev/null || echo "{}")

STRUCT_STATUS=$(echo "$STRUCT_RESPONSE" | jq -r '.status // "error"')
STRUCT_PATH=$(echo "$STRUCT_RESPONSE" | jq -r '.file_path // ""')

if [ "$STRUCT_STATUS" = "indexed" ] && [ -n "$STRUCT_PATH" ]; then
  pass "Structured ingest succeeded"
  info "File: $STRUCT_PATH"

  if [ -f "$STRUCT_PATH" ]; then
    pass "File exists on disk"
    STRUCT_ID=$(grep "^id:" "$STRUCT_PATH" | awk '{print $2}')
    CREATED_IDS+=("$STRUCT_ID")
  else
    fail "File path returned but file not found on disk: $STRUCT_PATH"
  fi
else
  fail "Structured ingest failed: $STRUCT_RESPONSE"
fi

# ─── Step 6: Delete the structured memory ────────────────────────────────────

step "Delete structured memory via API"

if [ -n "${STRUCT_ID:-}" ]; then
  DELETE_RESPONSE=$(curl -sf -X DELETE "$KORE_API_URL/api/v1/memory/$STRUCT_ID" \
    -H "Authorization: Bearer $KORE_API_KEY" 2>/dev/null || echo "{}")
  DELETE_STATUS=$(echo "$DELETE_RESPONSE" | jq -r '.status // "error"')

  if [ "$DELETE_STATUS" = "deleted" ]; then
    pass "Memory deleted via API"
    # Remove from cleanup list (already deleted)
    CREATED_IDS=("${CREATED_IDS[@]/$STRUCT_ID}")

    if [ ! -f "$STRUCT_PATH" ]; then
      pass "File confirmed removed from disk"
    else
      fail "File still exists on disk after DELETE: $STRUCT_PATH"
    fi

    # Confirm 404 on second delete
    SECOND_DELETE=$(curl -sf -X DELETE "$KORE_API_URL/api/v1/memory/$STRUCT_ID" \
      -H "Authorization: Bearer $KORE_API_KEY" 2>/dev/null || echo "{}")
    SECOND_CODE=$(echo "$SECOND_DELETE" | jq -r '.code // ""')
    [ "$SECOND_CODE" = "NOT_FOUND" ] && pass "Second DELETE correctly returns 404" || fail "Second DELETE did not return NOT_FOUND"
  else
    fail "Delete failed: $DELETE_RESPONSE"
  fi
else
  info "Skipping delete step — no structured ingest ID available"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo -e "\n${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ $FAILURES -eq 0 ]; then
  echo -e "${GREEN}All checks passed.${RESET}"
else
  echo -e "${RED}$FAILURES check(s) failed.${RESET}"
  echo "Run with more detail: see docs/manual-e2e-testing.md"
fi
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

exit $FAILURES

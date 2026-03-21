# Core API Design & Endpoints

The Kore Core Engine exposes an ElysiaJS REST API. This API is the gatekeeper for ingestion pipelines (like `an-export` or web clippers). It validates incoming raw data using Zod, places extraction tasks onto the local queue, and coordinates the plugin hooks.

This document defines the primary external-facing routes for the MVP.

## 1. Authentication & Security

Kore is designed as a "Local First" or "Self Hosted" application.

*   By default, the server runs locally (`localhost:3000`) and the `CORS` policy restricts access to the local machine.
*   **Security Measure:** Ingestion routes expect an `Authorization: Bearer <token>` header to prevent unauthorized logging if exposed on a wider network.

---

## 2. Base Endpoints

### 2.1 Health Check
**`GET /api/v1/health`**
Verifies the Elysia server, QMD bridge, and Core SQLite queue are responsive.

```typescript
// Response (200 OK)
{
  "version": "1.0.0",
  "memories": { "total": 42, "by_type": { "note": 20, "place": 10 } },
  "queue": { "pending": 0, "processing": 0, "failed": 0 },
  "index": { "documents": 42, "embedded": 42, "status": "ok" },
  "sync": { "apple_notes": { "enabled": true, "total_tracked": 100 } }  // only if KORE_APPLE_NOTES_ENABLED=true
}
```

---

## 3. Ingestion Endpoints

### 3.1 Unstructured Data Ingestion (Default)

**`POST /api/v1/remember`**
The primary entry point for raw, messy data like scraped HTML, clipboard dumps, or Apple Notes content. The API adds this to the Queue for full LLM semantic extraction. (Supersedes the removed `POST /api/v1/ingest/raw`.)

**Request Payload:**
```typescript
{
  "content": "John recommended Mutekiya in Ikebukuro for solo dining...",
  "source": "apple_notes",              // optional: originating source
  "url": "optional_string",             // optional: source URL
  "priority": "normal",                 // enum: [low, normal, high] - queue placement
  "suggested_tags": ["ramen", "tokyo"], // optional: hints for LLM extraction
  "suggested_category": "qmd://travel/food/japan"  // optional: category hint
}
```

**Response (202 Accepted):**
Because ingestion requires LLM extraction and plugin hooked validation, this endpoint is asynchronous. It returns a Task ID for tracking.
```typescript
{
  "status": "queued",
  "task_id": "a93bc-118-28bd",
  "message": "Enrichment added to queue."
}
```

### 3.2 Structured Ingestion (Bypass Extraction)

**`POST /api/v1/ingest/structured`**
Used by advanced scrapers that have already formatted the data to match the explicit Zod `BaseFrontmatterSchema` (e.g. an importer migrating thousands of pre-tagged Obsidian notes). This bypasses the LLM extraction step but still triggers plugins and QMD indexing.

**Request Payload:**
```typescript
{
  "content": {
    "title": "A pre-formatted note",
    "markdown_body": "The raw text of the note goes here.",
    "frontmatter": {
        "category": "qmd://tech/programming",
        "type": "note",
        "date_saved": "2026-03-07T12:00:00Z",
        "source": "obsidian_import",
        "tags": ["migration"]
    }
  }
}
```

**Response (200 OK):**
```typescript
{
  "status": "indexed",
  "file_path": "/home/user/kore-data/notes/a_pre_formatted_note.md"
}
```

### 3.3 Task Status

**`GET /api/v1/task/:id`**
Returns the current status of an ingestion task created by `POST /ingest/raw`.

**Response (200 OK):**
```typescript
{
  "id": "a93bc-118-28bd",
  "status": "completed",        // enum: queued | processing | completed | failed
  "created_at": "2026-03-07T12:00:00Z",
  "updated_at": "2026-03-07T12:00:05Z",
  "error_log": null              // populated on failure
}
```

**Response (404 Not Found):**
```typescript
{
  "error": "Task not found",
  "code": "NOT_FOUND"
}
```

---

## 4. Recall / Search Endpoint

### 4.1 Recall (Search & List)
**`POST /api/v1/recall`**
Performs a hybrid BM25 + vector search over indexed memories with filter support and pagination. With no `query` field, returns all memories (paginated). Supersedes the removed `POST /api/v1/search` and `GET /api/v1/memories` endpoints.

**Request Payload:**
```typescript
{
  "query": "anniversary dinner ideas in Sydney",  // optional: semantic search query
  "type": "place",                                 // optional: filter by memory type
  "intent": "recommendation",                      // optional: filter by intent
  "tags": ["sydney", "restaurant"],                // optional: filter by tags
  "limit": 10,                                     // optional: page size (default 10)
  "offset": 0,                                     // optional: pagination offset
  "min_score": 0.5,                                // optional: minimum relevance score
  "include_insights": false                        // optional: include insight memories
}
```

**Response (200 OK):**
```typescript
{
  "results": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "title": "Sixpenny Restaurant",
      "type": "place",
      "category": "qmd://travel/food/australia",
      "tags": ["sydney", "restaurant", "degustation"],
      "date_saved": "2026-03-07T12:00:00Z",
      "source": "manual",
      "distilled_items": ["Degustation menu restaurant in Stanmore"],
      "score": 0.92
    }
  ],
  "query": "anniversary dinner ideas in Sydney",
  "total": 1,
  "offset": 0,
  "has_more": false
}
```

**Response (503 Service Unavailable):** QMD search index is not available.

---

## 5. Memory Management Endpoints

While QMD manages the semantic *search* of memories natively via MCP, the Core API manages the actual filesystem mutations to ensure state synchronization (specifically so `memory.deleted` and `memory.updated` lifecycle events fire to notify plugins like Spatialite).

### 5.1 Delete Memory
**`DELETE /api/v1/memory/:id`**

Deletes the underlying `.md` file, updates the QMD index, and fires `onMemoryDeleted` to plugins.
*(Agents must call this API rather than deleting the `.md` file directly if they want state-synced plugins to update).*

**Response (200 OK):**
```typescript
{
  "status": "deleted",
  "id": "uuid-here"
}
```

### 5.2 Update Memory Content
**`PUT /api/v1/memory/:id`**

Used to mutate the body text or append new distracted facts to an existing memory. Overwrites the file and fires `onMemoryUpdated`.

**Request Payload:**
```typescript
{
  "content": {
    "title": "Updated title",
    "markdown_body": "Updated body text.",
    "frontmatter": {
        "category": "qmd://tech/programming",
        "type": "note",
        "date_saved": "2026-03-07T12:00:00Z",
        "source": "manual_edit",
        "tags": ["updated"]
    }
  }
}
```
The `id` is taken from the route parameter `:id`, not the payload.

**Response (200 OK):**
```typescript
{
  "status": "updated",
  "id": "uuid-here",
  "file_path": "/home/user/kore-data/notes/updated_title.md"
}
```

---

## 6. Plugin Route Mounting

As defined in `plugin_system.md`, plugins can mount their own routes to the core API context.
If a plugin `kore-plugin-spatialite` mounts a route, it is accessible on the root server:

**`POST /plugins/spatialite/ping`**
*(Delegated to plugin entirely)*

---

## 7. Error Response Format

All error responses from the API follow a standardized shape:

```typescript
{
  "error": "<Human-readable error message>",
  "code": "<ERROR_CODE>"
}
```

**Standard Error Codes:**

| HTTP Status | Code | Description |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request payload failed Zod validation |
| 401 | `UNAUTHORIZED` | Missing or invalid Bearer token |
| 404 | `NOT_FOUND` | Resource (memory or task) not found |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

For `VALIDATION_ERROR`, the `error` field should include the Zod validation issue summary (e.g., `"tags: Array must contain at most 5 element(s)"`).

# Core API Design & Endpoints

The Kore Core Engine exposes an ElysiaJS REST API. This API is the gatekeeper for ingestion pipelines (like `an-export` or web clippers). It validates incoming raw data using Zod, places extraction tasks onto the local queue, and coordinates the plugin hooks.

This document defines the primary external-facing routes for the MVP.

## 1. Authentication & Security

Kore is designed as a "Local First" or "Self Hosted" application.

*   By default, the Elysia server runs locally (`localhost:3000`) and the `CORS` policy restricts access to the local machine or Docker network.
*   **Security Measure:** Ingestion routes expect an `Authorization: Bearer <token>` header to prevent unauthorized logging if exposed on a wider network.

---

## 2. Base Endpoints

### 2.1 Health Check
**`GET /api/v1/health`**
Verifies the Elysia server, QMD bridge, and Core SQLite queue are responsive.

```typescript
// Response (200 OK)
{
  "status": "ok",
  "version": "1.0.0",
  "qmd_status": "online",
  "queue_length": 0
}
```

---

## 3. Ingestion Endpoints

### 3.1 Unstructured Data Ingestion (Default)

**`POST /api/v1/ingest/raw`**
The primary entry point for raw, messy data like scraped HTML, clipboard dumps, or Apple Notes content. The API adds this to the Queue for full LLM semantic extraction.

**Request Payload:**
```typescript
{
  "source": "apple_notes",              // Originating ingestor UUID or string
  "content": "John recommended Mutekiya in Ikebukuro for solo dining...",
  "original_url": "optional_string",    // The source URL if applicable
  "priority": "normal"                  // enum: [low, normal, high] - determines queue placement
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

---

## 4. Memory Management Endpoints

While QMD manages the semantic *search* of memories natively via MCP, the Core API manages the actual filesystem mutations to ensure state synchronization (specifically so `memory.deleted` and `memory.updated` lifecycle events fire to notify plugins like Spatialite).

### 4.1 Delete Memory
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

### 4.2 Update Memory Content
**`PUT /api/v1/memory/:id`**

Used to mutate the body text or append new distracted facts to an existing memory. Overwrites the file and fires `onMemoryUpdated`.

---

## 5. Plugin Route Mounting

As defined in `plugin_system.md`, plugins can mount their own routes to the core API context.
If a plugin `kore-plugin-spatialite` mounts a route, it is accessible on the root server:

**`POST /plugins/spatialite/ping`**
*(Delegated to plugin entirely)*

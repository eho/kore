# Apple Notes Integration: Detailed Architecture & Design

_2026-03-14_

This document specifies how `@kore/an-export` should be integrated into Kore's ingestion pipeline to deliver true passive ingestion of Apple Notes — the first fully automated, end-to-end source integration.

---

## 1. Goals

- **Passive ingestion.** New or modified Apple Notes are automatically ingested into Kore without any user action.
- **Incremental.** Only new/modified notes trigger LLM extraction. Unchanged notes are skipped.
- **Bidirectional lifecycle.** Notes deleted in Apple Notes are also removed from Kore's memory store.
- **Folder-aware.** Apple Notes folder hierarchy is passed as context to the LLM extractor to improve categorization accuracy.
- **Non-destructive.** The Apple Notes database is never written to. The integration is strictly read-only.
- **Resilient.** Full Disk Access revocation, iCloud sync lag, locked notes, and Ollama downtime are handled gracefully without crashing the core engine.

---

## 2. Integration Strategy

### Options Considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A. Inline in core-api | Add sync loop next to worker/watcher/embedder | Couples macOS-specific code into core engine. Fails on Linux/Docker. |
| B. Standalone daemon | Separate process that POSTs to `/api/v1/ingest/raw` | Extra process to manage, requires API to be running, adds network hop. |
| C. Plugin with hooks only | Use existing `onMemoryIndexed` etc. hooks | Plugin system has no mechanism to start background loops. |
| **D. Plugin with lifecycle methods** | Extend `KorePlugin` interface with `start()`/`stop()` | Correct separation: macOS code in a macOS-aware plugin, zero change to core engine logic. |

**Decision: Option D.** The `KorePlugin` interface is extended with optional `start()` and `stop()` lifecycle methods. This allows the Apple Notes plugin to run its own background sync interval inside the plugin's own code, while still using Kore's queue for task submission and the event system for deletions and updates.

---

## 3. Plugin Interface Extension

The `KorePlugin` interface in `packages/shared-types/index.ts` already has `start()`/`stop()` lifecycle methods and the `PluginStartDeps` interface. These were implemented as part of the plugin infrastructure track (C1–C4). The current interface:

```typescript
export interface KorePlugin {
  name: string;
  start?: (deps: PluginStartDeps) => Promise<void>;
  stop?: () => Promise<void>;
  routes?: (app: Elysia) => Elysia;
  onIngestEnrichment?: (context: IngestionContext) => Promise<EnrichmentResult | void>;
  onMemoryIndexed?: (event: MemoryEvent) => Promise<void>;
  onMemoryDeleted?: (event: MemoryEvent) => Promise<void>;
  onMemoryUpdated?: (event: MemoryEvent) => Promise<void>;
}

export interface PluginStartDeps {
  /** Enqueue raw content for LLM extraction. Returns task ID. */
  enqueue: (payload: { source: string; content: string; original_url?: string }, priority?: "low" | "normal" | "high") => string;

  /** Delete a memory by ID. Used when source content is deleted. */
  deleteMemory: (id: string) => Promise<boolean>;

  /** Look up a Kore memory ID by an arbitrary external key (plugin-scoped). */
  getMemoryIdByExternalKey: (externalKey: string) => string | undefined;

  /** Register a mapping from external key → Kore memory ID. */
  setExternalKeyMapping: (externalKey: string, memoryId: string) => void;

  /** Remove an external key mapping. */
  removeExternalKeyMapping: (externalKey: string) => void;

  /** Remove all external key mappings for this plugin. */
  clearRegistry: () => void;
}
```

> **Note:** Registry methods are **plugin-scoped** — the `pluginName` is captured in a closure by `core-api/src/index.ts` when constructing `PluginStartDeps` for each plugin. Plugins never pass their own name.

> **Gap: `listExternalKeys` is not yet exposed.** `PluginRegistryRepository.listByPlugin()` exists in `core-api/src/plugin-registry.ts` but is not wired into `PluginStartDeps`. The Apple Notes plugin requires this for delete detection and pending-key resolution in `onMemoryIndexed`. **This must be added before implementing the plugin.**

The `PluginStartDeps.enqueue` is a thin wrapper over `QueueRepository.enqueue()`, giving plugins access to the task queue without depending directly on the queue implementation.

The `getMemoryIdByExternalKey` / `setExternalKeyMapping` / `removeExternalKeyMapping` trio gives plugins a way to maintain their own `externalId → koreMemoryId` mappings, stored in a plugin registry managed by the core engine (see §7).

---

## 4. New Package: `packages/plugin-apple-notes`

```
packages/plugin-apple-notes/
├── package.json
├── index.ts                 # Plugin entry point
├── sync-loop.ts             # Background sync interval
├── content-builder.ts       # Assembles LLM-ready content from an-export output
└── __tests__/
    └── content-builder.test.ts
```

**`package.json` dependencies:**
```json
{
  "name": "@kore/plugin-apple-notes",
  "dependencies": {
    "@kore/an-export": "workspace:*",
    "@kore/shared-types": "workspace:*"
  }
}
```

---

## 5. The Sync Loop

### 5.1 Overview

The sync loop runs inside the plugin on a configurable interval. Each cycle:

1. Calls `syncNotes()` from `@kore/an-export` targeting a staging directory.
2. Examines the sync result: which notes are new, updated, or deleted.
3. For **new** notes: builds LLM-ready content and enqueues via `deps.enqueue()`.
4. For **updated** notes: deletes the existing Kore memory, then enqueues re-extraction.
5. For **deleted** notes: deletes the corresponding Kore memory.
6. Records `externalKey → memoryId` mappings for updates and deletes to work correctly.

### 5.2 Staging Directory

`an-export` needs a destination directory for its exported Markdown files and attachments. This is **not** `$KORE_DATA_PATH` — it's a separate staging area:

```
$KORE_HOME/
├── data/               # Kore memory files (managed by core engine)
├── db/                 # SQLite databases
├── logs/               # Session logs
└── staging/
    └── apple-notes/    # an-export staging directory
        ├── an-export-manifest.json
        ├── notes/
        │   ├── Work/
        │   │   └── Q1 Planning.md
        │   └── Personal/
        │       └── Trip Ideas.md
        └── attachments/
            └── photo.jpg
```

The staging directory is not indexed by QMD. It serves only as a temporary read target for the sync loop. The content it contains is converted to Kore memory files via the LLM extraction pipeline.

**Why a staging directory rather than reading Apple Notes directly?**
`an-export` copies the Notes database to a temp directory before reading it, handles all protobuf decoding and CRDT parsing, and outputs clean Markdown. This is the right interface boundary — the plugin receives clean Markdown, not raw protobuf.

### 5.3 Sync Loop Implementation

```typescript
// packages/plugin-apple-notes/sync-loop.ts

import { syncNotes } from "@kore/an-export";
import type { PluginStartDeps } from "@kore/shared-types";
import { buildIngestContent } from "./content-builder";
import { join } from "node:path";

const PLUGIN_NAME = "apple-notes";

export interface SyncLoopOptions {
  stagingPath: string;           // $KORE_HOME/staging/apple-notes
  intervalMs: number;            // default: 15 minutes
  includeHandwriting: boolean;   // default: false
  folderAllowlist?: string[];    // optional: ["Work", "Personal"] (all if empty)
  folderBlocklist?: string[];    // optional: ["Archive", "Old Notes"]
}

export function startSyncLoop(
  deps: PluginStartDeps,
  opts: SyncLoopOptions
): { stop: () => void } {
  // Run once immediately on start, then on interval
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running || stopped) return;
    running = true;
    try {
      await syncCycle(deps, opts);
    } catch (err) {
      // Log but never crash — Full Disk Access may be temporarily revoked
      console.error("[apple-notes] Sync cycle error:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }

  // Initial sync after a short delay (let the server fully start)
  const initialDelay = setTimeout(() => runOnce(), 10_000);
  const interval = setInterval(runOnce, opts.intervalMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(initialDelay);
      clearInterval(interval);
    },
  };
}

async function syncCycle(deps: PluginStartDeps, opts: SyncLoopOptions) {
  const result = await syncNotes(
    {
      dest: opts.stagingPath,
      omitFirstLine: false,        // We want the title for the LLM
      includeHandwriting: opts.includeHandwriting,
      includeTrashed: false,
    },
    (msg) => console.log(`[apple-notes] ${msg}`)
  );

  console.log(
    `[apple-notes] Sync complete: ${result.exported} exported, ` +
    `${result.skipped} skipped, ${result.deleted} deleted`
  );

  // an-export's syncNotes returns only aggregate counts, not per-note deltas.
  // We need to diff the manifest ourselves to find what changed.
  // See §5.4 for manifest diffing strategy.
}
```

### 5.4 Manifest Diffing for Delta Detection

`an-export`'s `syncNotes()` returns aggregate counts (`exported`, `deleted`) but does not return a per-note list of what changed. To know *which* notes are new, updated, or deleted, the plugin diffs `an-export`'s manifest file against the Plugin Identity Registry (§7).

The an-export manifest (`an-export-manifest.json`) maps each note's `Z_PK` to its `{ path, mtime }`. The Plugin Identity Registry maps `Z_PK` → `koreId`. By comparing the two, the plugin determines:

- **New**: Z_PK in an-export manifest but not in the registry → queue for extraction
- **Updated**: Z_PK in both, but `mtime` increased → delete existing memory, re-queue
- **Deleted**: Z_PK in registry but no longer in an-export manifest → delete memory
- **Unchanged**: Z_PK in both, `mtime` unchanged → skip

```typescript
async function syncCycle(deps: PluginStartDeps, opts: SyncLoopOptions) {
  const anManifestPath = join(opts.stagingPath, "an-export-manifest.json");

  // 1. Run an-export sync (updates an-export-manifest.json on disk)
  await syncNotes({ dest: opts.stagingPath, omitFirstLine: false }, logProgress);

  // 2. Load the updated an-export manifest
  const anManifest = JSON.parse(await readFile(anManifestPath, "utf-8"));
  const currentKeys = Object.keys(anManifest.notes);

  // 3. Build set of keys currently tracked in the Plugin Identity Registry
  //    (keys previously registered via setExternalKeyMapping)
  //    Note: Object.keys(anManifest.notes) returns string keys even though
  //    SyncManifest.notes is Record<number, ManifestNoteEntry>.
  //    The registry stores these as string external keys consistently.
  const trackedKeys = new Set(
    currentKeys
      .map(k => deps.getMemoryIdByExternalKey(k))
      .filter(Boolean)
      .map((_, i) => currentKeys[i])
  );
  // More precisely: iterate all known external keys for this plugin
  // (requires listExternalKeys — see §3 gap note)

  // 4. Apply folder filters
  const shouldInclude = (notePath: string) => {
    if (opts.folderBlocklist?.some(f => notePath.startsWith(`notes/${f}/`))) return false;
    if (opts.folderAllowlist?.length && !opts.folderAllowlist.some(f => notePath.startsWith(`notes/${f}/`))) return false;
    return true;
  };

  // 5. Handle each note from an-export manifest
  for (const key of currentKeys) {
    const noteEntry = anManifest.notes[key];
    if (!shouldInclude(noteEntry.path)) continue;

    const existingKoreId = deps.getMemoryIdByExternalKey(key);

    if (!existingKoreId) {
      // NEW note — queue for extraction
      const content = await buildIngestContent(
        join(opts.stagingPath, noteEntry.path), noteEntry.path
      );
      if (!content) continue;

      const taskId = deps.enqueue({ source: "apple_notes", content }, "low");
      // koreId will be set by onMemoryIndexed when the worker completes (see §5.5)
      // Store a pending marker so we know this key is in-flight
      deps.setExternalKeyMapping(key, `pending:${taskId}`);

    } else if (existingKoreId.startsWith("pending:")) {
      // Still waiting for worker to process — skip
      continue;

    } else {
      // Known note — check if updated
      // Compare an-export mtime against a stored mtime
      // (requires extending the registry or storing mtime separately)
      // For V1: re-export detection relies on an-export only exporting changed files
      continue;
    }
  }

  // 6. Handle deletions: find registry entries whose keys are no longer in an-export manifest
  //    (requires iterating all external keys for this plugin — see §7 note on listExternalKeys)
}
```

> **Implementation note on update/delete detection**: The sync cycle above handles new notes cleanly. Update and delete detection requires iterating all registry entries for the plugin to find keys absent from the current an-export manifest. The Plugin Identity Registry (§7) should expose a `listExternalKeys(pluginName)` method to support this. For V1, `an-export`'s `syncNotes()` handles the heavy lifting — it only re-exports modified notes and deletes stale files from the staging directory.

### 5.5 Resolving Pending `koreId` Entries

After a task is enqueued, the Kore memory file is created asynchronously by the worker. The plugin needs to learn the resulting `koreId` to update the Plugin Identity Registry. This is done via the `onMemoryIndexed` plugin hook, matching on the `task_id` field in `MemoryEvent`.

**Status**: The worker already includes `taskId` in the `MemoryEvent` payload (see `worker.ts:129`). This prerequisite is satisfied.

```typescript
// packages/plugin-apple-notes/index.ts

export class AppleNotesPlugin implements KorePlugin {
  name = "apple-notes";
  private syncLoop?: { stop: () => void };
  private deps?: PluginStartDeps;

  async start(deps: PluginStartDeps): Promise<void> {
    this.deps = deps;
    const koreHome = process.env.KORE_HOME ?? join(homedir(), ".kore");
    const stagingPath = join(koreHome, "staging", "apple-notes");

    await mkdir(stagingPath, { recursive: true });
    await mkdir(join(stagingPath, "notes"), { recursive: true });
    await mkdir(join(stagingPath, "attachments"), { recursive: true });

    this.syncLoop = startSyncLoop(deps, {
      stagingPath,
      intervalMs: Number(process.env.KORE_AN_SYNC_INTERVAL_MS ?? 15 * 60 * 1000),
      includeHandwriting: process.env.KORE_AN_INCLUDE_HANDWRITING === "true",
      folderAllowlist: process.env.KORE_AN_FOLDER_ALLOWLIST?.split(",").map(s => s.trim()),
      folderBlocklist: process.env.KORE_AN_FOLDER_BLOCKLIST?.split(",").map(s => s.trim()),
    });
  }

  async stop(): Promise<void> {
    this.syncLoop?.stop();
  }

  async onMemoryIndexed(event: MemoryEvent): Promise<void> {
    if (!this.deps) return;
    // Only care about memories from our source
    if (event.frontmatter.source !== "apple_notes") return;
    if (!event.taskId) return;  // Requires task_id in MemoryEvent

    // Find the pending registry entry that matches this task_id
    // The sync loop stored `pending:{taskId}` as the memory_id
    const pendingKey = `pending:${event.taskId}`;

    // Scan registry for the matching pending entry and resolve it
    // (requires listExternalKeys — see §3 gap note)
    const entries = this.deps.listExternalKeys?.() ?? [];
    for (const { externalKey, memoryId } of entries) {
      if (memoryId === pendingKey) {
        this.deps.setExternalKeyMapping(externalKey, event.id);
        console.log(`[apple-notes] Resolved ${externalKey} → ${event.id}`);
        break;
      }
    }
  }
}
```

This approach uses exact `task_id` matching rather than time-window heuristics, eliminating the ambiguity of the earlier manifest-based design.

---

## 6. Content Builder

The content builder is responsible for transforming an exported Apple Notes Markdown file into LLM-ready content for Kore's extraction pipeline.

### 6.1 Input

`an-export` produces files like:

```markdown
# Q1 Planning Notes

Here are the key items for Q1:
- Launch new onboarding flow by March
- Complete the backend migration to Postgres
- Hire two engineers

![](../attachments/q1-board.png)

See also: [[Team OKRs]]
```

The file path in the staging directory encodes the folder hierarchy:
```
staging/apple-notes/notes/Work/Projects/Q1 Planning Notes.md
```

### 6.2 Processing Steps

```typescript
// packages/plugin-apple-notes/content-builder.ts

export async function buildIngestContent(
  absoluteNotePath: string,
  relativeNotePath: string    // e.g. "notes/Work/Projects/Q1 Planning Notes.md"
): Promise<string | null> {
  let markdown: string;
  try {
    markdown = await Bun.file(absoluteNotePath).text();
  } catch {
    return null; // File unreadable, skip
  }

  if (!markdown.trim()) return null;

  // Extract folder hierarchy from the relative path
  // "notes/Work/Projects/Q1 Planning Notes.md" → "Work / Projects"
  const folderPath = extractFolderPath(relativeNotePath);

  // Strip attachment image references (broken relative paths won't survive move to Kore)
  const cleanedMarkdown = stripAttachmentImages(markdown);

  // Extract note title from first # heading (an-export preserves it as first line)
  const title = extractTitle(cleanedMarkdown) ?? "Untitled Note";

  // Assemble the content block sent to the LLM extractor
  // The folder path and title are prepended as context, not part of the body
  const parts = [
    folderPath ? `Apple Notes Folder: ${folderPath}` : null,
    `Title: ${title}`,
    "",
    cleanedMarkdown,
  ].filter(Boolean);

  return parts.join("\n");
}

function extractFolderPath(relativeNotePath: string): string {
  // "notes/Work/Projects/Q1 Planning Notes.md" → "Work / Projects"
  const segments = relativeNotePath.split("/");
  // Remove "notes/" prefix and the filename
  const folderSegments = segments.slice(1, -1);
  return folderSegments.join(" / ");
}

function stripAttachmentImages(markdown: string): string {
  // Remove broken image links: ![alt](../attachments/...)
  // Keep URL-based images intact
  return markdown.replace(/!\[([^\]]*)\]\((?:\.\.?\/)?attachments\/[^)]+\)/g, (_, alt) => {
    return alt ? `[Attachment: ${alt}]` : "[Attachment]";
  });
}

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}
```

### 6.3 Example LLM Input

For a note at `notes/Work/Projects/Q1 Planning Notes.md`:

```
Apple Notes Folder: Work / Projects
Title: Q1 Planning Notes

# Q1 Planning Notes

Here are the key items for Q1:
- Launch new onboarding flow by March
- Complete the backend migration to Postgres
- Hire two engineers

[Attachment: q1-board.png]

See also: [[Team OKRs]]
```

The LLM extractor receives this and produces:
- `title`: "Q1 Planning Notes"
- `type`: "note"
- `category`: "qmd://tech/projects/planning" (informed by the folder prefix "Work / Projects")
- `distilled_items`: ["Launch new onboarding flow by March", "Complete backend migration to Postgres", "Hire two engineers"]
- `tags`: ["q1", "planning", "work"]

The folder path `Work / Projects` is the key signal that pushes the LLM toward a work/tech category rather than `qmd://personal/`.

### 6.4 Content Length Limit

Apple Notes can be very long (extensive journals, large documents). The LLM extractor has an implicit context limit based on the model's context window. The content builder enforces a character cap:

```typescript
const MAX_CONTENT_CHARS = 8_000; // ~2000 tokens, leaves room for system prompt

if (content.length > MAX_CONTENT_CHARS) {
  // Keep the folder/title header, truncate the body
  const header = parts.slice(0, 3).join("\n");
  const body = cleanedMarkdown.slice(0, MAX_CONTENT_CHARS - header.length - 50);
  return `${header}\n\n${body}\n\n[Content truncated for extraction]`;
}
```

---

## 7. External Key Registry (Core Engine Change)

The plugin needs to maintain Apple Notes `Z_PK` → Kore `memoryId` mappings durably. The core engine provides a lightweight **Plugin Identity Registry** backed by a single SQLite table in `kore-queue.db`. This is the **single source of truth** for all external ID → Kore ID mappings. There is no separate manifest file.

```sql
CREATE TABLE IF NOT EXISTS plugin_key_registry (
  plugin_name TEXT NOT NULL,
  external_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_name, external_key)
);

CREATE INDEX idx_plugin_key_memory ON plugin_key_registry(plugin_name, memory_id);
```

**Implementation status:** `PluginRegistryRepository` is implemented in `core-api/src/plugin-registry.ts` with full CRUD plus `listByPlugin()`. The `PluginStartDeps` closure in `core-api/src/index.ts` scopes all calls to `plugin.name` automatically. Plugin-facing methods (no `pluginName` arg):

| Method | Purpose |
|--------|---------|
| `getMemoryIdByExternalKey(key)` | Look up Kore ID by external key |
| `setExternalKeyMapping(key, memoryId)` | Create or update a mapping |
| `removeExternalKeyMapping(key)` | Remove a mapping |
| `clearRegistry()` | Remove all mappings for this plugin |
| `listExternalKeys()` | **Not yet wired** — must be added to `PluginStartDeps` before implementing Apple Notes plugin (maps to `PluginRegistryRepository.listByPlugin()`) |

For the Apple Notes plugin:
- `plugin_name` = `"apple-notes"`
- `external_key` = `Z_PK` as string (e.g., `"12345"`)
- `memory_id` = Kore UUID (e.g., `"abc-123-..."`) or `"pending:{taskId}"` while extraction is in-flight

The lifecycle of a mapping:
1. **Sync loop** enqueues a new note → sets mapping to `"pending:{taskId}"`
2. **Worker** completes extraction, emits `MemoryEvent` with `taskId`
3. **`onMemoryIndexed`** handler matches `taskId`, updates mapping to the real Kore UUID
4. **Future sync** detects note update → reads existing Kore UUID from registry → deletes old memory → re-queues

---

## 8. Attachment Strategy (V1)

V1 treats attachments as best-effort text references. Full attachment processing is deferred.

| Attachment Type | V1 Treatment |
|-----------------|-------------|
| Images (PNG, JPG) | Stripped from content, replaced with `[Attachment: filename]` |
| PDFs | Stripped, replaced with `[Attachment: filename.pdf]` |
| Audio/Video | Stripped, replaced with `[Attachment: filename]` |
| Tables | Preserved as Markdown pipe tables (already converted by an-export) |
| Drawings with OCR | Preserved if `includeHandwriting: true`, else stripped |
| Internal links `[[Note Title]]` | Preserved as-is; the LLM can extract the linked note title as a fact |
| URL cards | Preserved as `[Title](url)` — the LLM extracts these as notable references |

**Rationale:** The majority of Apple Notes value is in text content. Images are typically supplementary. Attempting to run vision models over every image would be slow, expensive (even locally), and often unhelpful for memory extraction.

**V2 upgrade path:** Image attachments that survive into the Kore memory file as `[Attachment: photo.jpg]` references could be re-processed by a future vision enrichment plugin using `onMemoryIndexed`, keeping the upgrade non-breaking.

---

## 9. Configuration

All configuration via environment variables, consistent with Kore's existing pattern:

```bash
# Enable Apple Notes sync (required to activate the plugin)
KORE_APPLE_NOTES_ENABLED=true

# Sync interval in milliseconds (default: 15 minutes)
KORE_AN_SYNC_INTERVAL_MS=900000

# Include handwriting OCR summaries from drawings (default: false)
KORE_AN_INCLUDE_HANDWRITING=false

# Comma-separated list of top-level folder names to include (all if unset)
KORE_AN_FOLDER_ALLOWLIST=Work,Personal,Travel

# Comma-separated list of top-level folder names to exclude (none if unset)
KORE_AN_FOLDER_BLOCKLIST=Archive,Templates,Shared

# Priority for queued extraction tasks (default: low — these are background)
KORE_AN_TASK_PRIORITY=low
```

**Allowlist vs. blocklist:** If both are set, allowlist takes precedence. A typical user would set a blocklist to exclude noise folders (Archive, old reference material). Power users would set an allowlist to include only high-value folders.

---

## 10. API Additions

One new API route surfacing sync status. Mounted by the plugin's `routes` method.

```
GET /api/v1/plugins/apple-notes/status
```

Response:
```json
{
  "enabled": true,
  "last_sync_at": "2026-03-14T14:30:00Z",
  "last_sync_result": {
    "exported": 12,
    "skipped": 3,
    "deleted": 0,
    "failed": []
  },
  "total_tracked_notes": 847,
  "next_sync_in_seconds": 712,
  "staging_path": "/Users/eho/.kore/staging/apple-notes"
}
```

```
POST /api/v1/plugins/apple-notes/sync
```

Triggers an immediate sync cycle. Returns `202` with a status message. Useful for testing and for post-import scenarios (e.g., user just bulk-imported old notes).

---

## 11. CLI Additions

```
kore sync                      # Trigger an immediate Apple Notes sync
kore sync --status             # Show last sync result and next sync time
kore list --source apple_notes # Filter memories to Apple Notes origin (already works)
```

The `kore sync` command POSTs to `/api/v1/plugins/apple-notes/sync` and polls until the cycle completes, printing progress.

---

## 12. Updated Startup Sequence

```
Existing:
  1. initLogger()
  2. ensureKoreDirectories()
  3. qmdClient.initStore()
  4. MemoryIndex.build()
  5. createApp()
  6. app.listen(3000)
  7. [Background] QMD bootstrap if empty
  8. startWorker()
  9. startWatcher()
  10. startEmbedInterval()

New:
  11. plugins.forEach(p => p.start?.(pluginDeps))   ← after all core services running
      └── AppleNotesPlugin.start() → startSyncLoop() (10s initial delay, then interval)

Shutdown order (reversed):
  1. plugins.forEach(p => p.stop?.())    ← plugins first
  2. stopEmbedInterval()
  3. stopWatcher()
  4. stopWorker()
  5. qmdClient.closeStore()
  6. closeLogger()
```

The 10-second initial delay in the sync loop (§5.3) ensures the QMD index is stable and the worker is ready before the first batch of Apple Notes tasks are queued.

---

## 13. Failure Modes & Mitigations

| Failure Mode | Detection | Mitigation |
|-------------|-----------|------------|
| Full Disk Access not granted | `syncNotes()` throws on database copy | Log clear error with user instructions; retry next interval |
| Notes DB locked (Notes app writing) | `syncNotes()` throws on SQLite copy | `an-export` copies the DB first (WAL files too); SQLite WAL mode allows concurrent reads, so this is rare |
| iCloud notes not yet downloaded | Note content is empty or partial | `an-export` exports whatever is locally available; partial notes get partial extraction |
| Password-protected notes | `an-export` silently skips them | Notes are never queued; no error |
| Ollama down during extraction | Worker marks task failed, retries 3x | Standard queue retry; note re-queued on next sync cycle if it appears modified |
| Very long notes (>8000 chars) | Content builder truncates | Extraction operates on truncated content; a future chunking strategy can improve this |
| Staging disk full | `Bun.write()` throws | Log error; skip this sync cycle |
| Plugin manifest corrupted | JSON parse fails | `loadPluginManifest()` returns empty manifest; next sync re-processes all notes (worst case: duplicate memories for unchanged notes — acceptable) |
| Duplicate memories on re-sync | Manifest returns empty | Content hashing (future) prevents exact duplicates; for now, tolerable |

---

## 14. What This Doesn't Cover

### Chunking Long Notes
Notes over ~8000 characters are truncated. A proper solution would split long notes into multiple Kore memories (one per section/heading). This is a meaningful improvement but requires changes to the extraction pipeline itself, not just the plugin.

### Bidirectional Sync (Kore → Apple Notes)
Kore never writes to Apple Notes. This is intentional and permanent — modifying the user's Notes database introduces significant risk (data loss, sync conflicts). Kore is a one-way memory augmentation layer, not a Notes editor.

### Shared Notes
Notes in shared folders appear in the user's database but are authored by others. The plugin treats them identically to personal notes. If this is unwanted, add the shared folder to `KORE_AN_FOLDER_BLOCKLIST`.

### Real-Time Sync (File System Watch on Notes DB)
Instead of a polling interval, the Notes database could be watched for changes. This would give near-instant ingestion of new notes. It's not implemented in V1 because:
1. The Notes DB path is inside a sandboxed Group Container — watching it may require additional entitlements
2. The WAL files change constantly even with no note modifications, making naive watching inefficient
3. 15-minute polling is acceptable for a background memory system

---

## 15. Implementation Phases

### Phase 1: Core Infrastructure ✅ (Complete)
1. ~~Add `start()`/`stop()` lifecycle methods to `KorePlugin` interface in `shared-types`~~ — done
2. ~~Add `PluginStartDeps` interface with `enqueue`, `deleteMemory`, registry methods~~ — done
3. ~~Add `plugin_key_registry` table to `QueueRepository`~~ — done (`PluginRegistryRepository`)
4. ~~Update `core-api/src/index.ts` to call `plugin.start(deps)` and `plugin.stop()` in startup/shutdown~~ — done
5. **Add `listExternalKeys()` to `PluginStartDeps`** — remaining gap, wire to `PluginRegistryRepository.listByPlugin()`

### Phase 2: Plugin Package
5. Create `packages/plugin-apple-notes/` with `package.json`
6. Implement `content-builder.ts` with full tests
7. Implement `sync-loop.ts` with manifest diffing
8. Implement `index.ts` (plugin entry point, `onMemoryIndexed` handler)

### Phase 3: Integration
9. Register `AppleNotesPlugin` in `core-api/src/index.ts` (behind `KORE_APPLE_NOTES_ENABLED` guard)
10. Add plugin routes to the Elysia app
11. Add `kore sync` command to CLI
12. Add `KORE_AN_*` env vars to `.env.example`

### Phase 4: Validation
13. Manual E2E test: export a real Apple Notes account, verify memories created correctly
14. Test delete sync: delete a note in Apple Notes, verify Kore memory is removed on next cycle
15. Test update sync: modify a note, verify Kore memory is refreshed
16. Test folder filtering: verify allowlist/blocklist work correctly
17. Test failure recovery: revoke Full Disk Access mid-sync, verify graceful error and recovery

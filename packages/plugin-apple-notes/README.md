# Apple Notes Plugin (`@kore/plugin-apple-notes`)

Kore's first fully automated, passive ingestion source. This plugin runs a background sync loop that incrementally exports your Apple Notes to Markdown, diffs against previously seen notes, and enqueues new or updated content for LLM extraction. Deleted notes are automatically removed from Kore's memory store.

## How It Works

```
Apple Notes DB (read-only)
        │
   syncNotes() via @kore/an-export
        │
        ▼
Staging directory ($KORE_HOME/staging/apple-notes/)
        │
   manifest diff against Plugin Identity Registry
        │
        ├── New note → build content → enqueue for extraction
        ├── Updated note → delete old memory → re-enqueue
        ├── Deleted note → delete Kore memory + registry entry
        └── Unchanged → skip
```

1. **Export** — `syncNotes()` from `@kore/an-export` incrementally exports modified notes to the staging directory
2. **Diff** — The sync loop loads `an-export-manifest.json` and compares each note's Z_PK against the Plugin Identity Registry
3. **Transform** — New/updated notes are processed by the content builder, which prepends folder hierarchy and title as LLM context, strips local attachment references, and enforces an 8,000-character limit
4. **Enqueue** — Transformed content is submitted to Kore's extraction queue with `source: "apple_notes"` and `priority: "low"`
5. **Resolve** — When extraction completes, the `onMemoryIndexed` hook resolves the pending registry entry to the final Kore memory ID
6. **Delete** — Notes present in the registry but absent from the manifest are removed from Kore

## Prerequisites

- **macOS** — Apple Notes databases are only accessible on macOS
- **Full Disk Access** — The terminal or process running Kore must have Full Disk Access granted in System Settings > Privacy & Security > Full Disk Access. This is required to read `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`
- **Ollama** — Must be running for LLM extraction of note content

## Enabling the Plugin

Set the following in your `.env` file:

```bash
KORE_APPLE_NOTES_ENABLED=true
```

Then restart Kore (`bun run start`). You should see:

```
[apple-notes] Plugin started (staging: /Users/you/.kore/staging/apple-notes)
```

The first sync cycle runs 10 seconds after startup.

## Configuration

All configuration is via environment variables. Only `KORE_APPLE_NOTES_ENABLED` is required; the rest have sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `KORE_APPLE_NOTES_ENABLED` | `false` | Enable the Apple Notes plugin |
| `KORE_AN_SYNC_INTERVAL_MS` | `900000` (15 min) | Interval between sync cycles in milliseconds |
| `KORE_AN_INCLUDE_HANDWRITING` | `false` | Include OCR text from handwritten drawings |
| `KORE_AN_FOLDER_ALLOWLIST` | *(empty — all folders)* | Comma-separated list of top-level folders to sync |
| `KORE_AN_FOLDER_BLOCKLIST` | *(empty — none excluded)* | Comma-separated list of top-level folders to exclude |

### Folder Filtering

Folder filtering operates on the **top-level folder** in your Apple Notes hierarchy. For example, if your notes are organized as:

```
iCloud/
├── Work/
│   ├── Projects/
│   └── Meetings/
├── Personal/
│   └── Travel/
└── Archive/
```

- `KORE_AN_FOLDER_ALLOWLIST=Work,Personal` — Only syncs notes in Work and Personal (and their subfolders)
- `KORE_AN_FOLDER_BLOCKLIST=Archive` — Syncs everything except Archive

Rules:
- Blocklist takes precedence over allowlist
- If allowlist is empty, all folders are included (subject to blocklist)
- Folder matching is case-insensitive
- Notes at the root level (no folder) always pass the filter
- When you unblock a previously blocked folder, its notes appear as "new" on the next sync cycle and get processed automatically

### Example `.env`

```bash
# Enable Apple Notes ingestion
KORE_APPLE_NOTES_ENABLED=true

# Sync every 5 minutes instead of 15
KORE_AN_SYNC_INTERVAL_MS=300000

# Only sync Work and Personal folders
KORE_AN_FOLDER_ALLOWLIST=Work,Personal

# Exclude the Archive folder
KORE_AN_FOLDER_BLOCKLIST=Archive
```

## Content Transformation

Before a note is sent to the LLM for extraction, the content builder transforms it:

1. **Folder context** — Prepends `Apple Notes Folder: Work / Projects` based on the note's folder path
2. **Title extraction** — Extracts the first `# heading` and prepends `Title: ...`
3. **Attachment handling** — Local attachment references (`![](../attachments/photo.jpg)`) are replaced with `[Attachment: photo.jpg]`. URL-based images, Markdown tables, and `[[internal links]]` are preserved
4. **Truncation** — Content exceeding 8,000 characters is truncated with a `[Content truncated for extraction]` notice

Example transformed output:

```
Apple Notes Folder: Work / Projects
Title: Q1 Planning

# Q1 Planning

Key objectives for the quarter:
- Launch the new API
- Migrate to the new database
[Attachment: architecture-diagram.png]
```

## API Endpoints

Both endpoints require bearer token authentication (the same `KORE_API_KEY` used for all Kore API routes).

### `GET /api/v1/plugins/apple-notes/status`

Returns the current sync status.

```json
{
  "enabled": true,
  "last_sync_at": "2026-03-16T10:30:00.000Z",
  "last_sync_result": "success",
  "total_tracked_notes": 42,
  "next_sync_in_seconds": 820,
  "staging_path": "/Users/you/.kore/staging/apple-notes"
}
```

### `POST /api/v1/plugins/apple-notes/sync`

Triggers an immediate sync cycle. Returns `202 Accepted`.

```json
{
  "status": "sync_triggered",
  "message": "Sync cycle started"
}
```

## CLI Commands

### `kore sync`

Trigger a manual sync cycle:

```sh
kore sync
# → Sync triggered. Sync cycle started
```

### `kore sync --status`

Check the current sync status:

```sh
kore sync --status
# → Apple Notes:    enabled
#   Last Sync:      2026-03-16T10:30:00.000Z
#   Last Result:    success
#   Tracked Notes:  42
#   Next Sync In:   13m 40s
#   Staging Path:   /Users/you/.kore/staging/apple-notes
```

Both commands support `--json` for machine-readable output.

## Troubleshooting

### "Could not load manifest, skipping cycle"

The `syncNotes()` export failed — usually because Full Disk Access was revoked or the Apple Notes database is locked by an iCloud sync. The plugin will retry on the next cycle automatically.

### Notes not appearing after sync

1. Check that the plugin is enabled: `kore sync --status`
2. Check that your notes are in an allowed folder (if using allowlist)
3. Check that Ollama is running — extraction happens asynchronously after enqueue
4. Check the server logs for `[apple-notes] Sync complete:` messages

### Encrypted/locked notes

Password-protected notes are skipped by `@kore/an-export` and will not appear in Kore.

## Development

```sh
# Run unit tests
bun test packages/plugin-apple-notes

# Run integration test (uses test database, no Full Disk Access needed)
bun test packages/plugin-apple-notes/__tests__/integration.test.ts

# Type check
bun run --filter @kore/plugin-apple-notes typecheck
```

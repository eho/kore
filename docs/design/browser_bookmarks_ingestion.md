# Browser Bookmarks Ingestion Design

## Overview

Passively ingest browser bookmarks into Kore by monitoring local bookmark files on macOS. Instead of requiring a browser extension, Kore watches the bookmark database files directly, detects new additions, fetches page content, and routes it through the standard LLM extraction pipeline.

This plugin follows the same architecture as `plugin-apple-notes`: background sync loop, manifest diffing, external key registry, and plugin lifecycle hooks.

## Goals

1. **Passive Capture:** Zero-friction ingestion of bookmarks and reading list items — no extension, no clicks.
2. **Rich Context:** Transform bare URLs into structured memories with type classification, intent, tags, and confidence — using the existing extraction pipeline.
3. **Local-First:** Run entirely on macOS. Content fetching uses local tools (Readability.js, optional headless browser). No cloud services required.

## Architecture

### 1. The Watcher (Event Source)

A background sync loop (modeled on `plugin-apple-notes`) polls browser bookmark files for changes.

**Supported browsers:**

| Browser | File | Format |
|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome/Default/Bookmarks` | JSON |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Bookmarks` | JSON |
| Edge | `~/Library/Application Support/Microsoft Edge/Default/Bookmarks` | JSON |
| Arc | `~/Library/Application Support/Arc/User Data/Default/Bookmarks` | JSON |
| Firefox | `~/Library/Application Support/Firefox/Profiles/<profile>/places.sqlite` | SQLite |
| Safari Bookmarks | `~/Library/Safari/Bookmarks.plist` | Binary plist |
| Safari Reading List | Embedded in `Bookmarks.plist` under `ReadingList` key | Binary plist |

Browser paths should be configurable via environment variables to support custom profiles and non-standard installations.

**Detection strategy:**

- Poll file `mtime` on a configurable interval (default: 5 minutes)
- On change, parse the file and diff against the plugin's external key registry (keyed by URL) to identify net-new bookmarks
- Chromium-based browsers all use the same JSON schema — a single parser covers Chrome, Brave, Edge, and Arc
- Firefox requires a read-only SQLite connection to `places.sqlite`
- Safari requires `plutil -convert xml1` (via `Bun.$`) or a bplist parser library

### 2. The Fetcher (Content Extraction)

Fetches page content from new bookmark URLs before sending to the LLM.

**Tiered extraction:**

| Tier | Method | When |
|---|---|---|
| **0: Meta tags** | Parse `<title>`, `og:title`, `og:description`, `meta[name=description]` from a lightweight `GET` | Always attempted first — fast, no heavy parsing |
| **1: Readability** | Full `GET` + Mozilla Readability.js to extract article text | When Tier 0 returns insufficient content |
| **2: `summarize`** | `summarize --extract --json <url>` (see below) | When Tier 1 fails or returns minimal content. Optional — only used if `summarize` is available on `$PATH` |

Tiers 0-1 are fully local with no external dependencies. Tier 2 is optional and provides significantly better extraction for edge cases.

**Fetch safeguards:**

- **Rate limiting:** Max 2 concurrent fetches, 1-second delay between sequential fetches to avoid hammering sites
- **Timeouts:** 15-second timeout per fetch (configurable)
- **Content size limit:** Skip responses larger than 5 MB
- **Redirect following:** Follow up to 5 redirects; resolve tracking URLs (`t.co`, UTM links) to final destination
- **URL filtering:** Skip non-HTTP URLs (`file://`, `javascript:`, `about:`, `chrome://`, `data:`)
- **Graceful degradation:** If all tiers fail (paywall, auth-required, offline), store URL + title + bookmark folder as a minimal memory with a `content_extraction_failed: true` flag

### 2a. `summarize` CLI Integration (Optional Tier 2)

[`summarize`](https://summarize.sh) (`@steipete/summarize`) is an open-source CLI that extracts clean text from URLs, PDFs, YouTube links, and audio/video files. It is used by [OpenClaw](https://github.com/openclaw/openclaw) and can be installed via `brew install steipete/tap/summarize` or `npm i -g @steipete/summarize`.

**Why it's useful as a fetcher:**

Kore does **not** use `summarize` for its LLM summarization — Kore has its own extraction pipeline. The value is `summarize --extract --json <url>`, which returns raw extracted content *without* calling an LLM. It handles cases that Readability.js can't:

- **JS-heavy SPAs** — uses its own rendering pipeline (Readability → markitdown → Firecrawl fallback)
- **YouTube links** — extracts transcripts (published captions first, Whisper fallback)
- **PDFs** — extracts text content directly
- **Audio/video** — transcription via Whisper
- **Paywalled sites** — optional Firecrawl fallback (`FIRECRAWL_API_KEY`)

**Integration approach:**

- **Optional dependency** — detected at runtime via `which summarize` at startup
- If available, logged as an enabled capability; if not, Tiers 0-1 handle extraction and unfetchable URLs degrade gracefully
- Only the `--extract` flag is used (raw content extraction) — Kore's own LLM pipeline handles structured extraction
- The `--json` flag provides machine-readable output for clean parsing

**Cloud considerations:**

`summarize` itself is local, but some of its fallback features use cloud services:
- **Firecrawl** (`FIRECRAWL_API_KEY`) — optional, for paywalled/blocked sites
- **Apify** (`APIFY_API_TOKEN`) — optional, for YouTube transcript fallback

These are opt-in via environment variables. Without them, `summarize` still works locally for most content using Readability and markitdown. This preserves Kore's local-first principle while giving power users access to better extraction when they choose.

**Broader reuse beyond bookmarks:**

`summarize` is also relevant to other ingestion sources on the roadmap:
- **Voice memos (roadmap 1.5)** — `summarize` handles audio files with Whisper transcription
- **Video bookmarks** — YouTube and podcast URLs are extracted automatically
- **PDF ingestion** — bookmarked PDFs or local files
- **Email links** — URLs in forwarded emails could be run through the same fetcher

A shared `@kore/content-fetcher` utility wrapping the tiered extraction logic could serve all these use cases.

### 3. The Extraction Pipeline

Fetched content is routed through Kore's **existing LLM extraction pipeline** (`@kore/llm-extractor`), not a custom summarizer. This means:

- The LLM classifies the memory type (`place`, `media`, `note`, `person`) based on page content
- Standard fields are extracted: `intent`, `tags`, `confidence`, `category`
- The bookmark folder path is included as context in the raw content (same pattern as Apple Notes folder context), e.g.:

```
[Bookmark Folder: Japan 2026 / Food]
[URL: https://example.com/best-ramen-tokyo]

Mutekiya in Ikebukuro — consistently ranked as Tokyo's best tsukemen...
```

This lets the LLM infer intent from folder structure without introducing custom schema fields.

### 4. Storage & Indexing

Memories are stored as standard `.md` files using Kore's existing schema:

```markdown
---
id: <uuid>
type: place
category: qmd://travel/food/japan
date_saved: 2026-03-21T10:00:00Z
source: browser_bookmark
source_browser: chrome
tags: [ramen, tokyo, ikebukuro]
url: https://example.com/best-ramen-tokyo
intent: recommendation
confidence: 0.88
---

# Mutekiya Ramen — Ikebukuro

Best tsukemen in Tokyo. Cash only, expect a 30-minute wait...
```

Key points:
- `source: browser_bookmark` identifies provenance
- `source_browser` (optional) tracks which browser it came from
- `url` preserves the original bookmarked URL
- No custom `bookmark` type — the LLM classifies into existing types
- Files are written to the appropriate type directory (`places/`, `media/`, `notes/`, etc.)

### 5. Plugin Integration

The plugin follows the `KorePlugin` interface:

- **`onStart(deps)`** — register with the plugin registry, begin sync loop
- **External key registry** — maps `browser_bookmark:<url>` → memory ID to prevent duplicate ingestion
- **`onMemoryIndexed(event)`** — resolves pending bookmark → memory ID mappings
- **Event emission** — emits standard `memory.indexed` events so consolidation picks up new memories

## Safari Reading List vs. Bookmarks

Safari Reading List and Bookmarks are stored in the same file but represent different user intent:

| | Bookmarks | Reading List |
|---|---|---|
| Intent | "Save permanently" | "Read later" |
| Typical use | References, recommendations | Articles, long reads |
| Suggested `intent` | `recommendation` or `reference` | `to_review` |
| Include by default? | Yes | Configurable (default: yes) |

The folder context passed to the LLM should indicate which source the item came from (e.g., `[Source: Safari Reading List]` vs. `[Bookmark Folder: Tech/Articles]`).

## Bookmark Deletions

Unlike Apple Notes, bookmark deletions should **not** trigger memory deletions. Rationale:

- Users often clean up bookmark clutter without intending to discard the knowledge
- The extracted memory has standalone value beyond the bookmark
- This matches user mental model: "I bookmarked it, Kore learned from it, I can clean up my bookmarks"

If a user wants to remove a memory, they can do so explicitly via `kore delete <id>`.

## URL Deduplication

Before fetching, check for existing memories with the same URL:

1. Query the external key registry for `browser_bookmark:<url>`
2. If not found, also query existing memories by URL field (covers content saved via other sources like Apple Notes or manual ingest)
3. If a match is found, skip ingestion and log it

This prevents duplicate memories when the same URL is bookmarked across multiple browsers or was already ingested from another source.

## Implementation Phases

### Phase 1: Prototype (Discovery)

- [x] Write a standalone script to parse Chrome JSON and Safari plist bookmarks on macOS
- [ ] Verify data structures and ability to extract URLs, titles, and folders
- [ ] Test Firefox `places.sqlite` read-only access
- [ ] Verify macOS permissions requirements for each browser

### Phase 2: Plugin Scaffold

- Create `packages/plugin-browser-bookmarks/`
- Implement plugin lifecycle following `plugin-apple-notes` pattern
- Build parsers for Chromium JSON, Safari plist, and Firefox SQLite
- Implement sync loop with external key registry for URL-based dedup
- Handle "Backlog Bankruptcy": only ingest bookmarks added *after* plugin is first enabled, with an optional `kore bookmarks backfill --browser chrome --folder "Tech"` CLI command for selective backfill

### Phase 3: Fetcher

- Implement Tier 0 (meta tags) and Tier 1 (Readability.js) content extraction
- Add `summarize` CLI detection and Tier 2 integration (`--extract --json`)
- Add rate limiting, timeouts, and content size limits
- Handle graceful degradation for unfetchable URLs
- Route fetched content + folder context through `POST /api/v1/remember`
- Consider extracting fetcher logic into a shared `@kore/content-fetcher` package for reuse by other ingestion plugins

### Phase 4: Polish

- Add CLI commands: `kore bookmarks sync`, `kore bookmarks status`
- Add configuration for browser selection, sync interval, folder allowlist/blocklist
- Documentation and testing

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KORE_BOOKMARKS_ENABLED` | `false` | Enable the plugin |
| `KORE_BOOKMARKS_BROWSERS` | `chrome` | Comma-separated list: `chrome`, `brave`, `edge`, `arc`, `firefox`, `safari` |
| `KORE_BOOKMARKS_SYNC_INTERVAL_MS` | `300000` (5 min) | Sync interval |
| `KORE_BOOKMARKS_FOLDER_ALLOWLIST` | *(all)* | Comma-separated folder names to include |
| `KORE_BOOKMARKS_FOLDER_BLOCKLIST` | *(none)* | Comma-separated folder names to exclude |
| `KORE_BOOKMARKS_INCLUDE_READING_LIST` | `true` | Include Safari Reading List items |
| `KORE_BOOKMARKS_FETCH_TIMEOUT_MS` | `15000` | Per-URL fetch timeout |
| `KORE_BOOKMARKS_MAX_CONTENT_SIZE` | `5242880` (5 MB) | Skip responses larger than this |

## Edge Cases and Mitigations

1. **Paywalls / Authenticated Content:** Fetcher will fail on logged-in sites (Twitter, private Substack). *Mitigation:* If `summarize` is available with a `FIRECRAWL_API_KEY`, Firecrawl can often extract paywalled content. Otherwise, graceful degradation — store URL + title + folder context as a minimal memory.

2. **Mass Rearrangements:** Moving bookmarks between folders updates the file but shouldn't trigger re-ingestion. *Mitigation:* Track bookmarks by URL in the external key registry, not by folder position.

3. **Safari Plist Parsing:** Binary plists can't be read directly. *Mitigation:* Use `Bun.$`plutil -convert xml1 -o - <path>`` to convert to XML on stdout, then parse.

4. **macOS Permissions:** Safari's `Bookmarks.plist` and some browser profiles are protected by macOS privacy controls. *Mitigation:* The Kore process must have **Full Disk Access** (System Settings > Privacy & Security). This is the same requirement as the Apple Notes plugin.

5. **Firefox Lock Contention:** Firefox holds a write lock on `places.sqlite` while running. *Mitigation:* Open the database in read-only mode (`?mode=ro`) or copy the file before reading.

6. **Concurrent Browser Edits:** User adds bookmarks while a sync is in progress. *Mitigation:* The sync loop reads a snapshot of the file at the start of each cycle; concurrent changes are picked up in the next cycle.

## Future Ideas

- **`summarize` Chrome extension as ingestion source** — `summarize` ships a Chrome extension backed by a local daemon on localhost. Instead of watching bookmark files, users could use the extension to explicitly send page content to Kore. This is a complementary path: file watching is passive/automatic, the extension is active/intentional. Both could coexist.
- **Shared `@kore/content-fetcher` package** — Extract the tiered fetching logic (meta tags → Readability → `summarize`) into a standalone package. Other plugins (email ingestion, social media, voice memos) all need to fetch and extract content from URLs or files. A shared fetcher avoids reimplementing the same logic in each plugin.
- **Tab groups ingestion** — Chrome and Arc support tab groups that represent research sessions. A group of related tabs could be ingested as a batch with shared context, producing naturally clustered memories.
- **Browser history (high-frequency visits)** — Pages visited 3+ times could be worth ingesting, even if never explicitly bookmarked. Much noisier; would need aggressive filtering.
- **Cross-browser dedup at folder level** — If the same URL appears in Chrome "Recipes" and Safari "Cooking", merge the folder context rather than creating two memories.

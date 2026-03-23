# Kore Roadmap

**Last updated:** 2026-03-21
**Status:** Living document — add ideas freely, prioritize periodically

---

## Completed

- [x] Phase 1: Passive ingestion pipeline, extraction worker, QMD indexing, MCP server, CLI
- [x] Phase 2: Consolidation system, Apple Notes plugin, MCP enhancements
- [x] CLN-001: Remove deprecated endpoints, deduplicate utilities, dead code removal
- [x] CLN-002: Split app.ts and consolidation-loop.ts into focused modules
- [x] CLN-003: Error handling, configuration, and code quality improvements

---

## The Thesis

Kore's moat is the combination of three things no other tool does together:

1. **Passive ingestion** — you don't change how you work; Kore watches your existing tools
2. **LLM-powered understanding** — not just storing, but extracting structure, intent, and meaning
3. **Agentic retrieval** — your AI assistant knows what you've saved without you asking

The flywheel: more sources ingested → richer memory graph → more useful retrieval → more reason to save things → repeat. The key insight is that **the value compounds over time** — consolidation synthesizes patterns across months of saved content that no human would notice.

To make Kore take off, we need to (a) widen the ingestion funnel, (b) make retrieval feel magical, and (c) build the push channel that no one else has.

---

## Track 1: Widen the Ingestion Funnel

The system is only as good as what it knows. Every new source multiplies the value of every existing memory through consolidation and cross-referencing.

### 1.1 Browser Extension (Safari / Chrome)
**Impact: High | Effort: Medium**

A lightweight web clipper that sends selected text + URL to `POST /api/v1/remember`. This is probably the single highest-value ingestion source — people discover and lose things on the web constantly.

- Minimum viable: right-click → "Save to Kore" sends selection + page URL
- Better: auto-detect when user bookmarks something, offer to ingest
- Best: passive mode that watches for bookmark additions across browsers
- Consider: Safari App Extension (Swift) vs Chrome Extension (JS) — start with one

### 1.2 X / Twitter Bookmarks
**Impact: High | Effort: Low**

Scheduled sync of X bookmarks via API. People bookmark tweets as a "save for later" that they never revisit. Architecture already supports this via plugin system.

- Use X API v2 bookmarks endpoint
- Differential sync (only new bookmarks since last check)
- Extract thread context, not just single tweet
- Plugin pattern: `plugin-x-bookmarks/`

### 1.3 Reddit Saved Posts
**Impact: Medium | Effort: Low**

Same pattern as X. Reddit's saved posts are a graveyard of forgotten recommendations.

### 1.4 Readwise / Pocket / Instapaper
**Impact: Medium | Effort: Low**

Read-later services accumulate highlights and annotations that are perfect extraction targets. Readwise in particular already structures highlights well.

### 1.5 Voice Memos / Audio
**Impact: High | Effort: Medium**

Whisper (local) or similar for transcription → extraction pipeline. People capture ideas verbally that never get written down.

- Watch a folder for `.m4a` / `.mp3` files (same pattern as file watcher)
- Transcribe with local Whisper model via Bun
- Feed transcript into existing extraction pipeline
- Preserve audio file reference in frontmatter

### 1.6 Email Forwarding
**Impact: Medium | Effort: Medium**

A dedicated email address (e.g., `save@kore.local`) that ingests forwarded emails. Restaurant confirmations, travel itineraries, recommendation emails.

### 1.7 Screenshot / Image OCR
**Impact: Medium | Effort: Medium**

Multi-modal extraction from images. The content builder already preserves `[Attachment: filename]` placeholders — these could be processed by a vision model.

- Screenshots of menus, maps, recommendations
- Photos of business cards, signs, handwritten notes
- Use Ollama vision models (llava, etc.) for local processing

### 1.8 Telegram / Messaging
**Impact: Medium | Effort: Low**

Telegram bot that accepts forwarded messages and media. Many people use "Saved Messages" in Telegram as a catch-all inbox.

---

## Track 2: Make Retrieval Magical

The pull channel works, but it can be dramatically better. The goal: Kore should feel like having a perfect memory.

### 2.1 Smarter MCP Prompting
**Impact: High | Effort: Low**

The MCP server instructions tell agents when and how to use Kore tools. Better prompting can dramatically improve how often Claude proactively recalls relevant memories without being asked.

- Expand trigger heuristics in tool descriptions
- Add few-shot examples of good recall behavior
- Tune the balance between proactive recall and noise
- Consider: a "context priming" tool that pre-loads relevant memories at conversation start

### 2.2 Raycast / Spotlight Extension
**Impact: High | Effort: Medium**

Quick-access search from anywhere on macOS. Type a hotkey, search your memories, get results instantly. This makes Kore accessible outside of Claude conversations.

- Raycast extension (TypeScript, good ecosystem fit)
- Hit `POST /api/v1/recall` from the extension
- Show results as a list with type icons and preview
- Action to open full memory, copy to clipboard, or open source URL

### 2.3 Web Dashboard
**Impact: Medium | Effort: Medium**

A local web UI for browsing, searching, and managing memories. Not the primary interface, but essential for trust and debugging.

- Browse memories by type, date, tags
- View consolidation graph (which memories produced which insights)
- Manual edit/delete
- Consolidation health dashboard (stale insights, failed extractions)
- Use Bun.serve() + HTML imports (per CLAUDE.md conventions)

### 2.4 iOS Shortcuts Integration
**Impact: Medium | Effort: Low**

Expose Kore as a Shortcuts action. "Hey Siri, remember this restaurant" → hits the API. Requires Kore to be reachable from the phone (Tailscale, Cloudflare Tunnel, etc.).

### 2.5 Conversation Context Priming
**Impact: High | Effort: Medium**

Instead of waiting for a relevant topic to come up, proactively load a "context brief" at the start of a conversation based on what the user is likely discussing.

- Analyze recent memories and active insights
- Generate a compact summary for the agent
- Could be a new MCP tool: `prime` — returns a curated context packet

---

## Track 3: Push Channel (Proactive Nudges)

This is the most differentiated piece of the vision and the hardest to build. No existing tool does this well. When it works, it's magic.

### 3.1 Location-Aware Nudges
**Impact: Very High | Effort: High**

When you're near a saved place, get a notification. "You saved 'Mutekiya Ramen' 6 months ago — it's 5 minutes from here."

**Architecture:**
- Spatialite plugin for geospatial queries on memory coordinates
- Location pinger: iOS Shortcuts (send GPS every N minutes) or companion app
- Proximity engine: find memories within radius of current location
- Notification delivery: start with Telegram bot or Pushover, graduate to native push
- Cooldown logic: don't spam, respect time-of-day, don't re-notify for same place

**Incremental approach:**
1. First: manual "what's near me?" query (new MCP tool or CLI command)
2. Then: scheduled check (cron-style, every 30 min when location changes)
3. Finally: real-time geofencing

### 3.2 Temporal Nudges
**Impact: High | Effort: Medium**

Time-based reminders derived from memory content. "Your anniversary is next week — you saved 3 restaurant recommendations in Sydney."

- Parse dates and temporal references during extraction
- Daily digest: scan upcoming dates, surface relevant memories
- Seasonal: "Last spring you wanted to visit X" — re-surface when the season returns
- Decay-based: memories not accessed in 6+ months get a "remember this?" nudge

### 3.3 Contextual Nudges
**Impact: High | Effort: High**

Trigger nudges based on what you're doing, not just where you are.

- Calendar integration: upcoming trip → surface all memories for that destination
- Weather: rainy day → surface indoor activity recommendations
- Travel detection: airport/flight → surface destination memories
- Conversation: after a Claude conversation about cooking → push related saved recipes

### 3.4 Digest / Daily Brief
**Impact: Medium | Effort: Low**

A simpler version of push: a daily email or Telegram message with curated memory highlights.

- "Today's memories": random selection weighted by relevance to recent activity
- "This week's insights": new consolidation results
- "Forgotten gems": old memories with high confidence that haven't been recalled
- This is the easiest entry point to push — no location infrastructure needed

---

## Track 4: Knowledge Quality

Make the memory graph smarter and more trustworthy over time.

### 4.1 User Feedback on Insights
**Impact: High | Effort: Low**

Let users upvote/downvote insights to tune confidence. The `reinforcement_count` field already exists but isn't user-facing.

- Thumbs up/down in web UI or CLI
- Feed into consolidation priority (high-confidence insights get re-synthesized less)
- Negative feedback triggers re-evaluation or retirement

### 4.2 Chunking for Long Notes
**Impact: Medium | Effort: Medium**

Notes >8000 chars are currently truncated. Chunking into multiple linked memories would improve extraction quality significantly.

- Split by semantic sections (headings, paragraph breaks)
- Cross-reference chunks via `related_ids` frontmatter
- Consolidation can later merge chunk-level extractions

### 4.3 Embedding Model Flexibility
**Impact: Medium | Effort: Medium**

Support swappable embedding models for better semantic search. Currently tied to QMD's default.

- OpenAI ada-002 for higher quality (requires API key)
- Local sentence-transformers for privacy
- A/B comparison tooling to measure retrieval quality

### 4.4 Contradiction Detection
**Impact: Medium | Effort: Low**

The consolidation system already has a `contradiction` insight type. Lean into this — actively surface conflicting information.

- "You saved Restaurant X as 'amazing' in January but 'overrated' in March"
- Flag stale recommendations (place closed, event passed)
- Build user trust by being honest about conflicting signals

### 4.5 Confidence Calibration
**Impact: Medium | Effort: Medium**

Track whether low-confidence extractions are actually useful and auto-tune thresholds.

- Log when low-confidence memories are recalled and used
- Adjust extraction prompts based on failure patterns
- Auto-retire memories that consistently rank low in search results

---

## Track 6: macOS App

A Tauri-based native macOS app that packages Kore as a proper `.app` bundle. See [full planning doc](macos-app.md) for details.

**Core value:** Zero-friction setup (onboarding wizard), Apple Notes permission fixed (inherits app's TCC grants), daemon runs as a menu bar app (no terminal tab), Quick Search global hotkey (replaces Raycast extension), Dashboard UI (replaces web dashboard).

### 6.1 Phase 1 — Shell (MVP)
**Impact: High | Effort: Medium**
Tauri scaffold, Rust daemon manager, menu bar icon, bundled Bun binary, launch at login, Apple Notes permission flow.
_Done when: app starts, daemon runs in background, MCP still works, no terminal needed._

### 6.2 Phase 2 — Onboarding & Settings
**Impact: High | Effort: Medium**
Full 5-step onboarding wizard, auto-write Claude Desktop/Code MCP config, Apple Notes folder picker, LLM connection tester, Keychain for API keys.
_Done when: new user can go from DMG to first synced memory without touching terminal._

### 6.3 Phase 3 — Dashboard & Quick Search
**Impact: High | Effort: Medium**
Global hotkey Quick Search window (replaces Raycast track), Dashboard with Overview/Memories/Insights tabs, native notifications, memory detail view.
_Done when: app replaces CLI for day-to-day interaction._

### 6.4 Phase 4 — Polish & Distribution
**Impact: Medium | Effort: Medium**
App icon, Apple notarization, DMG installer, auto-updater, graph view, iOS Shortcuts integration.

---

## Track 5: Operations & Polish

Make Kore reliable, observable, and easy to run.

### 5.1 Structured Logging
**Impact: Medium | Effort: Low**

Replace console.log with structured JSON logging for better debugging and monitoring.

### 5.2 Metrics Endpoint
**Impact: Medium | Effort: Low**

Expose key stats: ingestion rate, queue depth, consolidation health, search latency. Useful for the web dashboard and personal monitoring.

### 5.3 Multi-Device Sync
**Impact: High | Effort: Medium**

Markdown-native storage makes this feasible. Options:
- iCloud Drive (zero config for Apple users)
- Syncthing (cross-platform, no cloud)
- Git-based sync (version history for free)

Main challenge: merge conflicts in frontmatter during concurrent edits.

### 5.4 Backup & Export
**Impact: Medium | Effort: Low**

Since everything is Markdown files, backup is mostly about the SQLite databases (queue, tracker, registry). A `kore backup` CLI command that snapshots the full `$KORE_HOME` directory.

### 5.5 Onboarding Experience
**Impact: High | Effort: Medium**

First-run setup wizard that:
- Checks Ollama is running and model is pulled
- Creates `$KORE_HOME` directory structure
- Generates API key
- Offers to enable Apple Notes sync
- Installs MCP server config for Claude Desktop/Code
- Imports a starter set of memories from a chosen source

---

## Ideas Parking Lot

Unscoped ideas to evaluate later:

- **Knowledge graph visualization** — D3/force-directed graph of memory relationships
- **Collaborative memories** — share memory subsets with family/friends (trip planning)
- **Memory aging / archival** — automatically archive memories older than N years, keep them searchable but out of active consolidation
- **Custom extraction templates** — user-defined schemas for specific memory types (wine notes, workout logs, recipes)
- **Plugin marketplace** — community-contributed ingestion plugins
- **Local-first mobile app** — native iOS app for capture + push notifications
- **Integration with Obsidian** — bidirectional sync for users who already have an Obsidian vault
- **Semantic deduplication** — detect when the same recommendation is saved from multiple sources
- **Memory "strength" decay** — memories that are never recalled gradually lose prominence in search results (like real memory)
- **"Serendipity mode"** — surface random, surprising connections during idle time

---

## Prioritization Framework

When deciding what to work on next, weigh these factors:

| Factor | Question |
|---|---|
| **Flywheel impact** | Does this make the entire system more valuable? (ingestion sources and retrieval quality do) |
| **Differentiation** | Does this set Kore apart from Notion/Obsidian/Mem? (push channel, consolidation, agentic retrieval do) |
| **Effort/reward** | Can we ship something useful in a weekend? (browser extension MVP, daily digest, Raycast) |
| **Compounding** | Will this get better over time without additional work? (consolidation, more memories) |
| **Dog-fooding** | Will we personally use this every day? (if not, deprioritize) |

---

## Suggested Next Moves

1. **macOS App — Phase 1 shell (Track 6.1)** — Packages Kore as a proper `.app`, fixes Apple Notes permissions, eliminates the "keep a terminal tab open" requirement. Foundation for everything in Track 6.

2. **Browser extension (Track 1.1)** — Dramatically widens the ingestion funnel. Can be built in parallel with or after the macOS app. Start with a Safari right-click "Save to Kore" action.

3. **Daily digest via Telegram (Track 3.4)** — Simplest possible push channel. No location infrastructure, no mobile app. Gets the push pattern established immediately.

The macOS app (Track 6) subsumes Track 2.2 (Raycast extension) and Track 2.3 (Web Dashboard) and Track 5.5 (Onboarding) — building it first consolidates three separate tracks into one cohesive effort.

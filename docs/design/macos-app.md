# Kore macOS App — Design Document

**Status:** Design (decisions finalized)
**Created:** 2026-03-23
**Updated:** 2026-03-24
**Tech stack:** Tauri v2 (Rust shell + React/TypeScript UI)
**Target user:** Primarily personal use, but designed for others to install
**Secondary goal:** Learn proper macOS app development with Tauri (entitlements, Rust IPC, app structure)

---

## The Problem This Solves

Kore today requires technical setup: install Bun, clone the repo, configure env vars, edit `claude_desktop_config.json`, and grant Full Disk Access to Terminal. The Apple Notes plugin fails silently if the user's terminal emulator hasn't been granted Full Disk Access in System Settings — a confusing, invisible failure mode.

A native macOS app changes all of this:

1. **Onboarding becomes a wizard**, not a README
2. **Apple Notes permission is a native dialog** ("Allow Kore to access your files") instead of "open System Settings, navigate to Privacy & Security, find Full Disk Access, scroll to find your terminal, toggle it on"
3. **The daemon runs invisibly** as a menu bar app, not a terminal tab that the user must remember to keep open
4. **Discovery** — the app lives in `/Applications`, not `~/dev/kore`

---

## Why Tauri

| | Tauri | Electron | Swift/SwiftUI |
|---|---|---|---|
| **Bundle size** | ~10–15 MB | ~150 MB | ~5 MB |
| **UI language** | React + TypeScript | React + TypeScript | SwiftUI |
| **macOS entitlements** | Yes (Rust `Info.plist`) | Partial | Native |
| **Codebase continuity** | High (UI is TypeScript) | High | Low |
| **Native feel** | Good | OK | Best |
| **Menu bar app** | Yes (`tauri-plugin-positioner`) | Yes | Native |
| **System tray** | Yes | Yes | Native |

Tauri wins on bundle size and lets us write the UI in the same TypeScript ecosystem we already use. The Rust shell handles process management, permissions, and native OS integration without the 150 MB Electron overhead.

---

## Core Concept: The App as a Daemon Manager

The macOS app is **not a replacement for Kore's architecture** — it is a **host and controller** for the existing Bun daemon.

```
┌─────────────────────────────────────────────────┐
│                  Kore.app (Tauri)               │
│                                                 │
│  ┌──────────────┐    ┌──────────────────────┐   │
│  │  Menu Bar    │    │   React UI Windows   │   │
│  │  (Rust)      │    │   - Settings         │   │
│  │              │    │   - Onboarding       │   │
│  │              │    │   - Dashboard (later) │   │
│  └──────┬───────┘    └──────────┬───────────┘   │
│         │                       │               │
│         └──────────┬────────────┘               │
│                    │ Tauri IPC (invoke)         │
│         ┌──────────▼───────────┐                │
│         │   Rust Core Layer    │                │
│         │  - Process manager   │                │
│         │  - Config file I/O   │                │
│         │  - Permission checks │                │
│         │  - Launch at login   │                │
│         │  - Health polling    │                │
│         └──────────┬───────────┘                │
│                    │ Child process              │
│                    │ (bun run start at clone)   │
│         ┌──────────▼───────────┐                │
│         │   Bun Daemon         │                │
│         │  localhost:3000      │                │
│         │  (existing core-api) │                │
│         └──────────────────────┘                │
└─────────────────────────────────────────────────┘
```

The Rust layer manages the Bun daemon as a child process (`std::process::Command`). The Bun daemon runs exactly as it does today — same REST API, same SQLite, same markdown files. The UI talks to the daemon via `localhost:3000` using the existing API.

This means:
- The MCP server still works unchanged
- The CLI still works unchanged
- All existing tests still apply
- We're not rewriting Kore — we're wrapping it

**MVP simplification:** In Phase 1, the diagram is even simpler — the "Bun Daemon" box is just `bun run start` executed at the local clone path. No bundled binary, no `Resources/` extraction.

---

## Bundling Strategy

### Why `bun build --compile` won't work

The Kore daemon depends on QMD, which uses `node-llama-cpp` (native GGUF bindings), `better-sqlite3`, and `sqlite-vec` — all native modules with platform-specific prebuilt binaries. `bun build --compile` cannot bundle these native addons into a single executable. The README already documents this limitation.

### Phased approach to bundling

**Phase 1 (MVP):** No bundling. The app assumes:
- Bun is pre-installed on the user's machine
- Kore is cloned locally (e.g., `~/dev/kore`)
- `node_modules` are already installed via `bun install`

The app spawns the daemon by running `bun run start` at the configured clone path. This is the simplest possible approach and avoids all native module packaging issues.

**Future (self-contained app):** The app bundles three things in `Resources/`:
1. **Bun binary** — macOS universal binary
2. **Kore source** — the full monorepo source
3. **`node_modules`** — pre-installed with native modules for the target architecture

On first launch, the Rust layer copies these to `~/.kore/app/` and runs `bun run start` from there. This makes the download larger (~200MB+ with native modules) but avoids a first-run `bun install` step.

The daemon and the app are tightly coupled — updating the daemon means updating the whole app. Tauri's auto-updater (`tauri-plugin-updater`) handles this as a single unit in later phases.

### CLI availability

**Phase 1 (MVP):** The CLI is already available from the local clone — no installation needed. The user runs `kore` via their existing setup (e.g., `bun run --cwd ~/dev/kore cli` or a symlink). Both the app and CLI operate on the same clone, same `.env`, same daemon. No conflict.

**Future (self-contained app):** The Kore source lives inside `Resources/kore/` in the app bundle — not on `$PATH`. The app offers an "Install CLI" button in Settings (like VS Code's "Install 'code' command in PATH") that symlinks the `kore` binary to `/usr/local/bin/`. This is explicit and reversible.

**Config resolution for the CLI:** In the self-contained app, there is no `.env` file (the app bundle is immutable). Both the daemon and CLI read `$KORE_HOME/config.json` as the primary config source. The `config.ts` change made in Phase 1 is load-bearing for this — it ensures both the daemon and CLI resolve config from the same JSON file.

**Precedence in self-contained mode:**
1. Env vars (explicit)
2. `$KORE_HOME/config.json` (written by the app, read by daemon and CLI)
3. No `.env` — it's not in the bundle

---

## Configuration Strategy

### Decision: `config.json` in `$KORE_HOME`

The daemon currently reads all configuration from environment variables (auto-loaded from `.env` by Bun). The macOS app introduces a new `$KORE_HOME/config.json` file as the primary config surface for GUI users.

**Precedence order (highest wins):**
1. Environment variables (explicit `VAR=value bun run start`)
2. `.env` file (Bun auto-loads)
3. `$KORE_HOME/config.json` (new, written by the app)

This means:
- The app reads and writes `config.json` — clean JSON, easy to parse from both Rust and TypeScript
- CLI users can keep using `.env` as before — fully backwards-compatible
- Power users can override any setting with env vars

**`config.json` schema:**
```json
{
  "koreHome": "~/.kore",
  "port": 3000,
  "apiKey": "random-key-for-testing",
  "llm": {
    "provider": "gemini",
    "geminiApiKey": "AIza...",
    "geminiModel": "gemini-2.5-flash-lite",
    "ollamaBaseUrl": "http://localhost:11434",
    "ollamaModel": "qwen2.5:7b"
  },
  "appleNotes": {
    "enabled": true,
    "syncIntervalMs": 900000,
    "includeHandwriting": false,
    "folderAllowlist": [],
    "folderBlocklist": [],
    "dbDirOverride": null
  },
  "consolidation": {
    "intervalMs": 1800000,
    "cooldownDays": 7,
    "maxAttempts": 3
  },
  "embedIntervalMs": 300000,
  "mcpEnabled": true
}
```

**Implementation:** Requires a small change to `apps/core-api/src/config.ts` — load `config.json` as defaults, let env vars override. The config loader reads JSON once at startup and merges with `Bun.env`.

**API key storage:** For MVP, the Gemini API key lives in `config.json` as plaintext (same security posture as the current `.env`). A future phase moves it to macOS Keychain via `security` CLI or a Tauri Keychain plugin.

**Apple Notes DB path:** Defaults to the real Notes database (`~/Library/Group Containers/group.com.apple.notes`). The `dbDirOverride` field is kept for development/testing only — the Settings UI does not expose it.

---

## Apple Notes Permission — How It Gets Fixed

### Current state (CLI)
macOS TCC tracks permissions per application. A CLI tool has no bundle ID, so macOS cannot show a permission dialog for it. The user must manually locate Terminal (or iTerm, etc.) in System Settings → Privacy & Security → Full Disk Access and toggle it on. If they use multiple terminals, each needs to be granted separately.

### With the macOS app
The `.app` bundle has a bundle ID (`com.kore.app`) and an `Info.plist` that declares:

```xml
<key>NSAppleEventsUsageDescription</key>
<string>Kore needs access to Apple Notes to sync your notes as memories.</string>
```

macOS can now show a proper consent dialog the first time access is attempted. More precisely, the app:

1. On first launch, detects whether Apple Notes sync is enabled
2. If enabled, attempts to open the Notes database path
3. If that fails (TCC denial), shows a native in-app sheet: "Kore needs access to your Notes database. Click below to open System Settings." + a deep link button: `x-apple.systempreferences:com.apple.preference.security?Privacy_AllDiskAccess`
4. After the user grants access, the Bun daemon (a child process of the app) **inherits the app's TCC grants automatically** — no extra steps

**Even better:** The app can request the `com.apple.security.files.user-selected.read-write` entitlement and use `NSOpenPanel` (via Tauri's `tauri-plugin-dialog`) to let the user pick the Notes folder once. macOS stores a security-scoped bookmark, and the app can open the folder on every subsequent launch without re-prompting. This avoids Full Disk Access entirely — just a one-time folder picker.

---

## Feature Areas

### 1. Menu Bar App

The primary persistent UI surface. Always visible in the menu bar when Kore is running.

**Menu bar icon states:**
- `●` (filled) — daemon running, last sync OK
- `◌` (hollow) — daemon stopped
- `⟳` (spinning) — sync or consolidation in progress
- `!` (exclamation) — error state (permission denied, Ollama offline, etc.)

**Dropdown menu (MVP):**
```
Kore                          ●
───────────────────────────────
  Last sync: 2 minutes ago
  Daemon: running on :3000
───────────────────────────────
  Sync Apple Notes Now
  Trigger Consolidation
───────────────────────────────
  Settings...                 ⌘,
  Quit Kore
```

**Dropdown menu (future — with Dashboard):**
```
Kore                          ●
───────────────────────────────
  Last sync: 2 minutes ago
  42 memories · 8 insights
───────────────────────────────
  Open Dashboard              ⌘D
  Quick Search...             ⌘K
───────────────────────────────
  Sync Apple Notes Now
  Trigger Consolidation
───────────────────────────────
  Settings...                 ⌘,
  Quit Kore
```

### 2. Quick Search (Command Palette) — _Future, not MVP_

Global hotkey (e.g., `⌘⌥K`) opens a floating search bar anywhere in macOS — like Raycast or Spotlight but scoped to Kore memories.

- Hits `POST /api/v1/recall`
- Shows results with type icon, title, summary snippet, date
- Actions: copy to clipboard, open full memory in Dashboard, open source URL
- Keyboard-navigable, dismisses on Escape or focus loss

This replaces the proposed Raycast extension — we get the same UX built in. Deferred from MVP because the global hotkey floating window is one of the more complex Tauri features to implement correctly.

### 3. Onboarding (First Launch)

The onboarding flow is minimal but functional. On first launch (detected by absence of `$KORE_HOME/config.json`), the app opens the Settings window in a guided mode that walks through the essential tabs.

**MVP onboarding flow:**

**Step 1 — Welcome sheet**
- Brief explanation of what Kore does
- "Let's configure your setup"

**Step 2 — General tab (auto-focused)**
- Set the Kore clone path (pre-filled if detected)
- Set `$KORE_HOME` (default `~/.kore`)
- Verify Bun is installed (check `which bun`)

**Step 3 — LLM tab**
- Radio: Local (Ollama) vs Cloud (Gemini)
- If Ollama: checks if running, model name input
- If Gemini: text field for API key (stored in `config.json` for MVP, Keychain in future)

**Step 4 — Apple Notes tab**
- Enable/disable toggle
- If enabled: trigger the permission flow (folder picker or FDA deep link)
- Sync interval

**Step 5 — MCP Integration**
- Enable/disable toggle for Claude Desktop MCP config
- Enable/disable toggle for Claude Code MCP config
- If enabled: auto-writes the JSON with correct paths
- If skipped: user can use "Install MCP Config" button in Settings → MCP tab later

**Step 6 — Start**
- Write `config.json`
- Start daemon
- Show "Kore is running" confirmation

This reuses the Settings window UI — no separate wizard component. The "guided mode" is just a stepper overlay that highlights each tab in sequence.

### 4. Settings Window

Persistent settings UI. Organized in tabs. The Settings window is the primary UI surface in the MVP — it also doubles as the onboarding flow on first launch.

All settings are read from and written to `$KORE_HOME/config.json`.

#### MVP tabs

**General**
- Kore clone path (file picker, validated — must contain `apps/core-api/`)
- `$KORE_HOME` directory (show path, button to reveal in Finder)
- Daemon port (default 3000)
- Launch at login (toggle, backed by `SMAppService`)
- Daemon status indicator (running / stopped / error) with Start / Stop / Restart buttons

**LLM**
- Provider selector (Ollama / Gemini)
- If Ollama: model name input, Ollama URL, "Check Connection" button
- If Gemini: API key field (plaintext in config.json for MVP), model selector
- Connection test button (verifies the LLM is reachable)

**Apple Notes**
- Enable/disable sync (toggle)
- Permission status indicator (granted / denied / unknown)
- "Grant Access" button — triggers folder picker (NSOpenPanel) or System Settings deep link
- Folder allow/block list (comma-separated input for MVP, tree view in future)
- Sync interval slider (5 min → 60 min, default 15 min)
- "Sync Now" button
- Last sync timestamp + result

**MCP / Integrations** (lightweight — just the auto-config button)
- Claude Desktop config status (detected / not detected)
- "Install MCP Config" button (auto-writes the JSON with correct paths)
- Claude Code config status + install button

#### Future tabs

**Consolidation**
- Enable/disable background consolidation
- Interval (30 min default)
- "Trigger Now" button
- Show last consolidation result

**Advanced**
- Log level (info / debug)
- "View Logs" button (opens Console.app or in-app log viewer)
- "Reset Kore" (nuke insights, rebuild index)
- Export memories as zip

### 5. Dashboard Window

The main browseable UI. Tabbed or sidebar-based layout.

**Overview tab**
- Stats cards: total memories, insights, last sync, index health
- Recent activity feed (last 10 saves with source icon)
- Consolidation status (when last ran, how many clusters found)
- Quick actions: "Sync Now", "Consolidate Now"

**Memories tab**
- Table/grid of memories with type icon, title, tags, date, confidence
- Filter bar: type, tags, date range, source (Apple Notes / manual / etc.)
- Search box (hits `POST /api/v1/recall`)
- Click memory → detail panel with full content, frontmatter metadata, related insights

**Insights tab**
- List of synthesized insights with type badge (cluster_summary / connection / evolution / contradiction)
- Filter by type, date
- Click insight → full content, source memories listed, superseded status

**Graph tab** _(aspirational)_
- Force-directed graph of memory ↔ insight relationships
- Color-coded by type
- Click node → open in Memories or Insights tab

**Sync Status tab**
- Apple Notes sync history (last N cycles)
- Per-folder stats (notes synced, skipped, deleted)
- Error log for failed extractions

### 6. Notifications

Native macOS notifications for key events:

- Sync completed: "Synced 12 new memories from Apple Notes"
- New insight synthesized: "New insight: Your Tokyo recommendations have a theme"
- Error: "Ollama is not running — extraction paused"
- Idle nudge (optional): "You haven't added a memory in 3 days"

Use `tauri-plugin-notification` for all of these.

---

## Packaging Details

### App Structure (MVP — no bundled daemon)
```
Kore.app/
  Contents/
    MacOS/
      Kore                    # Tauri Rust binary
    Resources/
      icon.icns               # App icon
    Info.plist                # Bundle ID, entitlements, usage descriptions
```

The MVP app is lightweight — just the Tauri binary and icon. The Bun daemon runs from the user's local Kore clone. No Bun binary or source code is bundled.

### App Structure (Future — self-contained)
```
Kore.app/
  Contents/
    MacOS/
      Kore                    # Tauri Rust binary
    Resources/
      bun                     # Bundled Bun binary (universal)
      kore/                   # Full Kore source + node_modules
      icon.icns               # App icon
    Info.plist                # Bundle ID, entitlements, usage descriptions
    embedded.provisionprofile # For distribution
```

### Entitlements (`Kore.entitlements`)
```xml
<!-- Required for Full Disk Access flow (Apple Notes) -->
<key>com.apple.security.files.user-selected.read-write</key>
<true/>

<!-- For security-scoped bookmarks (folder picker persistence) -->
<key>com.apple.security.files.bookmarks.app-scope</key>
<true/>

<!-- For running child processes (Bun daemon) -->
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
```

### Distribution Options
- **MVP:** Unsigned `.app` for personal use (requires Gatekeeper bypass: right-click → Open)
- **Future:** Notarized DMG — Apple-notarized, no Gatekeeper warnings, requires Apple Developer account ($99/yr)
- **Not planned:** Mac App Store — sandboxed, too constrained for a daemon manager

---

## Monorepo Integration

The app lives in a new `apps/` workspace alongside `core-api`, `cli`, and `mcp-server`:

```
apps/
  core-api/       # Unchanged
  cli/            # Unchanged
  mcp-server/     # Unchanged
  macos/          # New — Tauri app
    src-tauri/    # Rust shell
      src/
        main.rs
        daemon.rs      # Child process management
        permissions.rs # TCC / entitlement helpers
        config.rs      # App config read/write
      tauri.conf.json
      Cargo.toml
    src/           # React/TypeScript UI
      components/
      pages/
        Dashboard.tsx
        Settings.tsx
        Onboarding.tsx
      App.tsx
    index.html
    package.json
```

The React UI calls the existing Kore API at `localhost:3000` — same endpoints, no new API surface needed (initially). Tauri's `invoke()` IPC is used only for things the web UI can't do natively: launching the daemon, reading/writing `config.json`, checking permissions.

### Required change to core-api

`apps/core-api/src/config.ts` needs to be updated to load `$KORE_HOME/config.json` as default values, with env vars taking precedence. This is the only change to the existing codebase required for Phase 1. The config loader should:

1. Check if `$KORE_HOME/config.json` exists
2. If so, parse it and use values as defaults
3. Let env vars override any JSON value
4. If the JSON file doesn't exist, behavior is unchanged (pure env var config)

### Tauri IPC commands (Rust → TypeScript)

The following Rust commands are exposed via `tauri::command` for the React UI:

```rust
// Daemon lifecycle
#[tauri::command] fn start_daemon(clone_path: &str, port: u16) -> Result<(), String>
#[tauri::command] fn stop_daemon() -> Result<(), String>
#[tauri::command] fn restart_daemon() -> Result<(), String>
#[tauri::command] fn daemon_status() -> DaemonStatus  // Running/Stopped/Error

// Config
#[tauri::command] fn read_config(kore_home: &str) -> Result<KoreConfig, String>
#[tauri::command] fn write_config(kore_home: &str, config: KoreConfig) -> Result<(), String>

// Permissions
#[tauri::command] fn check_notes_access() -> PermissionStatus
#[tauri::command] fn open_fda_settings() -> Result<(), String>  // Deep link to System Settings

// Environment
#[tauri::command] fn check_bun_installed() -> Result<String, String>  // Returns bun version or error
#[tauri::command] fn check_ollama_running(url: &str) -> Result<bool, String>

// MCP config
#[tauri::command] fn install_mcp_config(target: &str, daemon_url: &str, api_key: &str) -> Result<(), String>
```

---

## Phased Approach

### Phase 1 — MVP (Menu Bar + Settings)

Get a working `.app` that manages the daemon lifecycle and provides a Settings UI. Assumes Bun is pre-installed and Kore is cloned locally.

**Scaffold & infrastructure:**
- [ ] Tauri v2 project scaffold in `apps/macos/`
- [ ] Rust daemon manager: start, stop, restart Bun process via `std::process::Command`
- [ ] `config.json` read/write from Rust (serde_json)
- [ ] Update `apps/core-api/src/config.ts` to load `$KORE_HOME/config.json` as defaults

**Menu bar:**
- [ ] Menu bar icon with status states (running / stopped / error)
- [ ] Dropdown: status info, Sync Now, Consolidate Now, Settings, Quit
- [ ] Daemon health polling (periodic `GET /api/v1/health` to localhost)

**Settings window (React/TypeScript):**
- [ ] General tab: clone path, KORE_HOME, port, launch at login, daemon controls
- [ ] LLM tab: provider toggle (Gemini/Ollama), API key, connection test
- [ ] Apple Notes tab: enable/disable, permission flow, sync interval, folder lists
- [ ] MCP tab: auto-write Claude Desktop and Claude Code config

**Onboarding:**
- [ ] First-launch detection (no `config.json` exists)
- [ ] Guided mode through Settings tabs (stepper overlay)
- [ ] Bun installation check (`which bun`)
- [ ] Write initial `config.json` on completion

**Permissions:**
- [ ] Apple Notes permission check from Rust
- [ ] Folder picker (NSOpenPanel via `tauri-plugin-dialog`) or FDA deep link
- [ ] Security-scoped bookmark for persistent folder access
- [ ] Launch at login via `SMAppService`

**Prerequisites:**
- Bun installed on user's machine
- Kore cloned locally with `bun install` already run

**Done when:** The app starts, manages the daemon in the background, persists config to `config.json`, handles Apple Notes permissions properly, and auto-configures MCP. User never needs to open a terminal for day-to-day use.

### Phase 2 — Dashboard & Notifications

Make memories browseable and surface key events.

- [ ] Dashboard window: Overview + Memories + Insights tabs
- [ ] Memory detail view (full content, metadata, related insights)
- [ ] Native notifications via `tauri-plugin-notification` (sync complete, new insight, errors)
- [ ] Sync Status tab with per-folder history
- [ ] Consolidation settings tab
- [ ] Advanced settings tab (log viewer, reset, export)
- [ ] Apple Notes folder tree view (replace comma-separated input)

**Done when:** The app provides a browseable view of all memories and insights.

### Phase 3 — Quick Search & Self-Contained Packaging

Make the app standalone and add power-user features.

- [ ] Quick Search global hotkey window (`⌘⌥K`)
- [ ] Bundle Bun binary + Kore source + `node_modules` in `Resources/`
- [ ] First-run extraction to `~/.kore/app/`
- [ ] Remove requirement for pre-installed Bun and local clone
- [ ] Keychain integration for API keys (replace plaintext in config.json)
- [ ] LLM connection tester with model pull support (Ollama)

**Done when:** A user can go from DMG download to running Kore without any prerequisites.

### Phase 4 — Polish & Distribution

Make it something you'd share.

- [ ] Proper app icon
- [ ] Apple Developer notarization
- [ ] DMG installer with drag-to-Applications
- [ ] Auto-updater (`tauri-plugin-updater`)
- [ ] Graph view for memory relationships
- [ ] iOS Shortcuts API endpoint (expose Kore externally via Cloudflare Tunnel or Tailscale)

---

## Resolved Design Decisions

These questions were open during the brainstorm phase and are now resolved:

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | **Bun daemon compilation** — can `bun build --compile` handle QMD's native modules? | **No.** `node-llama-cpp`, `better-sqlite3`, and `sqlite-vec` cannot be bundled. | README already documents this limitation. MVP uses `bun run start` at clone path. |
| 2 | **QMD model downloads** — how are GGUF models bundled? | **They aren't.** QMD downloads models on first use to `~/.cache/qmd/`. The app lets this happen naturally. | QMD handles this transparently via `node-llama-cpp`. No app involvement needed. |
| 3 | **Ollama management** — should the app start Ollama? | **No.** Check and prompt only. | Simpler. Ollama has its own lifecycle. The app just verifies connectivity. |
| 4 | **Config format** — how does the app write daemon config? | **`$KORE_HOME/config.json`** — new JSON file, env vars override. | Clean JSON for the app to read/write. Backwards-compatible — `.env` still works for CLI users. |
| 5 | **MCP server paths** — how do paths change with bundling? | **MVP:** Paths point to local clone. **Future:** Paths point to bundled Bun + source in `Resources/`. | The "Install MCP Config" button writes the correct paths for the current mode. |
| 6 | **Update flow** — daemon vs app updates | **Tightly coupled.** Updating the daemon = updating the app. | The daemon IS the Kore source. `git pull` for MVP; Tauri auto-updater for the self-contained app. |
| 7 | **Multiple Claude clients** | **Yes.** Settings has install buttons for both Claude Desktop and Claude Code. | Both use the same MCP config format with different file paths. |

## Remaining Open Questions

1. **Tauri v2 menu bar support**: Verify that `tauri-plugin-positioner` and system tray APIs work reliably on macOS with Tauri v2. Build a minimal proof-of-concept before committing to the full implementation.

2. **Security-scoped bookmarks in Tauri**: Can Tauri's dialog plugin return a security-scoped bookmark for the Apple Notes folder, or do we need a custom Rust implementation? This determines whether we can avoid Full Disk Access entirely.

3. **First-run QMD download UX**: The first `embed()` call triggers a ~500MB model download. How should the app communicate this? Options: (a) show a progress bar in Settings, (b) show a notification, (c) just let it happen silently. Need to check if QMD exposes download progress events.

---

## Relationship to Roadmap

Adding this as a new track to the roadmap:

- **Track 6: macOS App** replaces Track 5.5 (Onboarding) and partially replaces Track 2.3 (Web Dashboard) and Track 2.2 (Raycast Extension) — the Quick Search window covers the Raycast use case, and the Dashboard covers the Web Dashboard use case, both in a native-feeling package.
- **Track 3 (Push Channel)** becomes easier to build once the app exists — native notifications are already wired up, and the app can eventually host a location permission request for geofencing nudges.
- **Track 1.1 (Browser Extension)** remains independent — the browser extension talks to the daemon API regardless of whether the app exists.

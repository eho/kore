# Kore macOS App — Design Document

**Status:** Revised
**Created:** 2026-03-23
**Updated:** 2026-03-24
**Revised 2026-03-24:** Addressed review feedback — added daemon lifecycle edge cases, testing strategy, success metrics, non-goals, design principles, vision alignment, risks table, and user stories.
**Tech stack:** Tauri v2 (Rust shell + React/TypeScript UI)
**Target user:** Primarily personal use, but designed for others to install
**Secondary goal:** Learn proper macOS app development with Tauri (entitlements, Rust IPC, app structure)

---

## Goals

- Eliminate terminal-based setup for non-technical users — onboarding should require zero command-line interaction
- Make Apple Notes permissions a one-click flow instead of a multi-step System Settings hunt
- Keep the daemon running invisibly as a menu bar app so users never manage a terminal tab
- Provide a GUI settings surface that covers all common configuration without editing files
- Learn Tauri v2 + Rust IPC + macOS entitlements as a secondary personal goal

### Success Metrics

| Metric | Target | How to measure |
|--------|--------|----------------|
| Time to first successful Apple Notes sync | < 3 minutes from first launch | Manual timing during onboarding |
| Memory footprint of Tauri shell (idle) | < 50 MB RSS | Activity Monitor spot checks |
| Daemon uptime after initial start | > 99.5% (no unexplained crashes per week) | Health poll failure rate in logs |
| Onboarding completion rate | 100% of attempts (personal use) | No abandoned onboarding flows |
| Cold start to daemon healthy | < 5 seconds | Timestamp delta: app launch → first healthy poll |

### Non-Goals

- **Not a rewrite of Kore's core** — the app wraps the existing Bun daemon, it does not replace it
- **Not a custom LLM chat UI** — Kore's interaction model is MCP-based (Claude Desktop / Claude Code), not a standalone chat window
- **Not an Ollama manager** — the app checks Ollama connectivity but does not start, stop, or update Ollama
- **Not a Mac App Store app** — sandboxing is too constrained for a daemon manager that needs Full Disk Access and child process spawning
- **Not a multi-user or server deployment** — this is a single-user desktop app for personal use

### Design Principles

1. **Silent by default** — the app should be invisible during normal operation. Menu bar icon + notifications only. No persistent windows.
2. **Daemon-first** — every feature must work without the GUI. The app is a convenience layer, not a requirement. CLI and MCP remain first-class.
3. **No magic** — configuration is readable JSON, logs are accessible, and the app never hides what it's doing. Power users can always drop to the CLI.
4. **Graceful degradation** — if Ollama is offline, Apple Notes access is denied, or the LLM API key is missing, the app continues running with reduced functionality and clear status indicators.

---

## Vision Alignment

This design directly advances the vision's "background engine" architecture. The vision (`docs/vision/vision.md`) emphasizes passive ingestion, agentic retrieval via MCP, and proactive nudges — all without a complex user-facing UI. The macOS app serves exactly this role: a silent menu bar daemon manager that keeps the Kore backend running so that the Pull Channel (MCP via Claude Desktop / Claude Code) and Push Channel (notifications, future location-based nudges) work reliably. By intentionally deferring a chat UI and focusing on daemon management + Apple Notes permissions, the app supports the vision's "Passive Ingestion" and "Agentic Retrieval" pillars without introducing competing interaction models. The future Dashboard and Quick Search features align with the vision's intent to make memories browseable, but the MVP correctly prioritizes the invisible infrastructure over UI polish.

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

## Daemon Lifecycle & Edge Cases

The Rust process manager (`daemon.rs`) is responsible for the full lifecycle of the Bun child process. This section defines behavior for every failure mode.

### Process Management Model

The Rust layer holds a `Child` handle from `std::process::Command`. The daemon manager maintains a state machine:

```
Stopped → Starting → Running → Stopping → Stopped
                  ↘ Error ↙
```

**Health polling:** While in `Running` state, the Rust layer polls `GET /api/v1/health` on `localhost:{port}` every 5 seconds. Three consecutive failures transition to `Error` state.

### Failure Scenarios

| Scenario | Detection | Behavior |
|----------|-----------|----------|
| **Port already in use** | `bun run start` exits immediately with `EADDRINUSE` | Transition to `Error` state. Menu bar icon shows `!`. Settings shows: "Port 3000 is in use by another process. Change the port in Settings or stop the other process." No auto-retry. |
| **Bun not found** | `which bun` fails or spawn returns `ENOENT` | Transition to `Error` state. Settings shows: "Bun is not installed. Install it from bun.sh." |
| **Clone path invalid** | Configured path doesn't contain `apps/core-api/` | Transition to `Error` state. Settings shows: "Kore clone not found at {path}. Update the clone path in Settings." |
| **Daemon crashes (OOM, panic, uncaught exception)** | Child process exits with non-zero code | Transition to `Error` state. Log the exit code and last 50 lines of stderr. **Auto-restart:** retry once after a 3-second delay. If the second attempt also fails within 30 seconds, stay in `Error` state and notify the user. No infinite restart loops. |
| **Daemon killed externally** (Activity Monitor, `kill`) | Child process exits with signal (SIGTERM/SIGKILL) | Same as crash — single auto-restart attempt. If killed again within 30 seconds, stay in `Error` and surface: "Daemon was terminated externally." |
| **Health poll failures (daemon hangs)** | 3 consecutive failed health polls (15 seconds) | Transition to `Error` state. Attempt graceful stop (SIGTERM), wait 5 seconds, then SIGKILL. Then auto-restart once. |
| **App quit (normal)** | User clicks "Quit Kore" or Cmd+Q | Send SIGTERM to child process, wait up to 5 seconds for clean exit, then SIGKILL if still alive. App exits only after child is confirmed dead. |
| **App crash** | Tauri process terminates unexpectedly | **Zombie prevention:** On startup, the Rust layer checks for a PID file at `$KORE_HOME/.daemon.pid`. If the PID file exists and the process is still running, adopt it (store the PID, begin health polling). If the process is dead, delete the stale PID file and start fresh. |
| **Config change requiring restart** | User changes port, clone path, or LLM provider in Settings | Settings UI shows "Restart required" badge on the daemon status. User clicks "Restart" explicitly — no silent auto-restart on config change. |

### PID File

The Rust layer writes `$KORE_HOME/.daemon.pid` containing the child process PID immediately after a successful spawn. The file is deleted on clean shutdown. This enables:
- Zombie detection on app startup (see above)
- External tooling to check if the daemon is running

### Logging

Daemon stdout and stderr are captured by the Rust layer and written to `$KORE_HOME/logs/daemon.log` (rotated, max 10 MB, last 3 files kept). The "View Logs" button in Advanced settings opens this file.

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

## Testing Strategy

The existing Bun daemon tests (`bun test`) continue to cover all core-api logic unchanged. This section covers testing the **new** Tauri/Rust layer and React UI.

### Rust Unit Tests (`cargo test`)

The Rust layer is tested with standard `cargo test` in `apps/macos/src-tauri/`:

| Module | Test scenarios |
|--------|---------------|
| `daemon.rs` | Spawn mock process, verify PID file written. Kill process, verify PID file cleaned up. Simulate crash (non-zero exit), verify single auto-restart. Simulate double crash within 30s, verify no further restarts. |
| `config.rs` | Read valid `config.json`, verify all fields parsed. Read missing file, verify defaults returned. Write config, read back, verify round-trip. Malformed JSON returns clear error. |
| `permissions.rs` | Mock TCC query responses for granted/denied/unknown states. Verify correct `PermissionStatus` enum returned. |

**Note:** Daemon spawn tests use a trivial mock process (e.g., `sleep 60` or a small Bun script that listens on a port) rather than the full Kore daemon, to keep tests fast and isolated.

### React UI Tests (`bun test`)

The React UI in `apps/macos/src/` is tested with `bun test` and a lightweight component testing approach:

| Area | Test scenarios |
|------|---------------|
| Settings tabs | Each tab renders without error. Form inputs update local state. Save button calls `invoke('write_config')` with correct payload. |
| Onboarding flow | Stepper advances through all steps. Required fields block progression. Final step calls `invoke('write_config')` then `invoke('start_daemon')`. |
| Daemon status display | UI reflects `Running` / `Stopped` / `Error` states correctly. Error state shows the error message. Start/Stop/Restart buttons call correct IPC commands. |
| Menu bar dropdown | Status text updates from health poll data. Action buttons (Sync Now, Consolidate Now) call correct API endpoints. |

**Tauri IPC mocking:** Tests mock `@tauri-apps/api/core`'s `invoke()` function to simulate Rust responses without running the full app.

### Integration / Manual Test Scenarios

These scenarios require a running macOS environment and are tracked as a checklist for each release:

- [ ] **Fresh install:** Delete `$KORE_HOME/config.json`, launch app, verify onboarding flow triggers
- [ ] **Port conflict:** Start another process on port 3000, launch Kore, verify error message and no crash
- [ ] **Daemon crash recovery:** Start daemon, `kill -9` the Bun process, verify app detects the crash and auto-restarts once
- [ ] **Double crash (no restart loop):** Kill the daemon twice within 30 seconds, verify app stays in Error state
- [ ] **TCC denial:** Revoke Full Disk Access, trigger Apple Notes sync, verify graceful error message
- [ ] **TCC grant:** Grant access via folder picker, verify sync succeeds on next cycle
- [ ] **App crash → zombie prevention:** Force-kill the Tauri process, relaunch, verify app adopts the orphaned daemon via PID file
- [ ] **Config change restart:** Change port in Settings, verify "Restart required" badge appears, restart works
- [ ] **Bun not installed:** Rename Bun binary, launch app, verify clear error message
- [ ] **Ollama offline:** Disable Ollama, verify app shows connection error but continues running
- [ ] **MCP config install:** Click "Install MCP Config" for Claude Desktop, verify JSON written to correct path
- [ ] **Launch at login:** Enable toggle, reboot, verify app starts automatically

### CI (GitHub Actions)

- `cargo test` runs on every PR touching `apps/macos/src-tauri/`
- `bun test` runs on every PR touching `apps/macos/src/`
- Tauri build (`tauri build --ci`) runs on macOS runner to verify compilation — does not run the app

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Tauri v2 menu bar / system tray APIs are unstable or incomplete on macOS | Medium | High — would require rearchitecting the primary UI surface | Build a minimal proof-of-concept (Open Question #1) before committing to full implementation. Fallback: use a standard window with `windowLevel: floating`. |
| Security-scoped bookmarks don't work through Tauri's dialog plugin | Medium | Medium — would require Full Disk Access instead of folder picker | Test early in Phase 1. Fallback: use the FDA deep link flow, which is already designed. |
| First QMD model download (~500MB) surprises users with no progress feedback | High | Low — annoying UX but not a blocker | Show a notification when the first embedding operation starts. Investigate whether `node-llama-cpp` exposes download progress events (Open Question #3). |
| Bun daemon child process leaks resources or doesn't respond to SIGTERM cleanly | Low | Medium — orphaned processes consuming CPU/memory | PID file mechanism + SIGKILL fallback after 5s. Logging captures stderr for diagnosis. |
| macOS Gatekeeper warnings scare users (unsigned MVP app) | High (for non-developer users) | Medium — users may not know to right-click → Open | Document the bypass clearly. Phase 4 adds Apple notarization. For MVP, target is developer users who understand Gatekeeper. |
| Native module compatibility breaks across macOS versions | Low | High — daemon won't start | Pin to tested macOS versions in docs. Native modules (`better-sqlite3`, `sqlite-vec`) have broad macOS support. |

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
| 8 | **Daemon upgrades in Phase 1** | **Manual.** User runs `git pull && bun install` at the clone path. The app does not manage source updates. | Phase 1 assumes a developer user who cloned the repo. The app can surface a "New version available" notice by checking the remote git tag, but updating is the user's responsibility. Self-contained mode (Phase 3) bundles updates via Tauri's auto-updater. |
| 9 | **Config change → daemon restart** | **Explicit restart required.** Settings shows a "Restart required" badge; user clicks Restart. | Silent auto-restarts on config change are surprising and could interrupt in-flight operations (sync, consolidation). Explicit is safer. |
| 10 | **Zombie process prevention** | **PID file + startup adoption.** Rust writes `$KORE_HOME/.daemon.pid` on spawn, checks it on startup, and adopts or cleans up. App sends SIGTERM then SIGKILL on quit. | See "Daemon Lifecycle & Edge Cases" section for full details. |
| 11 | **Tauri v2 menu bar support** — do `tauri-plugin-positioner` and system tray APIs work reliably on macOS with Tauri v2? | **Yes (APIs confirmed; reliability validated in MAC-001).** Use `@tauri-apps/plugin-system-tray` for the tray icon and `tauri-plugin-positioner` (with `tray-icon` feature) for tray-relative window positioning. MAC-001 includes a minimal tray POC that validates actual behavior before the backend is built. | Official Tauri v2 docs confirm support. Known edge cases: dual-monitor positioning can be inconsistent on the first 1–2 clicks; plan for a small workaround in the positioner logic. |

## Remaining Open Questions

1. **Security-scoped bookmarks in Tauri**: Can Tauri's dialog plugin return a security-scoped bookmark for the Apple Notes folder, or do we need a custom Rust implementation? This determines whether we can avoid Full Disk Access entirely.

2. **First-run QMD download UX**: The first `embed()` call triggers a ~500MB model download. The preferred approach is: the daemon exposes an SSE endpoint that streams download progress, and the Tauri app subscribes and shows a non-intrusive progress bar in the tray panel. Two pre-conditions need verification before committing to this: (a) does `node-llama-cpp` expose an `onDownloadProgress` callback that the daemon can hook into? (b) is adding an SSE endpoint to the daemon in scope for MVP, or should we fall back to a simpler "Downloading model, please wait…" notice with a spinner? The daemon currently has no SSE infrastructure.

---

## Context Required for Implementation

An implementing agent must read these files to understand the existing system before making changes:

- `apps/core-api/src/config.ts` — current config resolution logic (uses `resolveKoreHome()` from `@kore/qmd-client`), path helpers for data/db directories
- `apps/core-api/src/index.ts` — daemon entry point showing full startup lifecycle: QMD init → queue/index → plugins → consolidation loop → HTTP listen
- `apps/core-api/src/app.ts` — HTTP app factory, route composition, Bearer auth setup
- `apps/core-api/src/operations/health.ts` — health endpoint response schema (version, memories, queue, index, sync status)
- `packages/qmd-client/src/index.ts` — `resolveKoreHome()` implementation (checks `$KORE_HOME`, defaults to `~/.kore`)
- `packages/shared-types/` — Zod schemas and TypeScript interfaces used across the monorepo
- `package.json` (root) — workspace configuration (`./apps/*`, `./packages/*`)
- `docs/vision/vision.md` — product vision: passive ingestion, agentic retrieval, proactive nudges
- `docs/design/macos-app.md` — this document

---

## User Stories

Prefix: **MAC**

These stories cover Phase 1 (MVP). Each is scoped to be completable in a single focused agent session. Stories are ordered by dependency — later stories depend on earlier ones.

### MAC-001: Scaffold Tauri v2 Project + Minimal Tray POC

**Description:** As a developer, I want a properly scaffolded Tauri v2 project in `apps/macos/` with a working menu bar icon and window, so that I have a validated foundation to build on.

This story also serves as the proof-of-concept for Resolved Decision #11 — confirming that `tauri-plugin-positioner` and the system tray APIs work reliably on macOS before the backend is built.

**Context:**
- Files to read: `package.json` (root, for workspace config), `apps/core-api/package.json` (for reference on how existing apps are structured)
- The monorepo uses Bun workspaces (`./apps/*`, `./packages/*`)

**Acceptance Criteria:**
- [ ] `apps/macos/` directory created with Tauri v2 project structure: `src-tauri/` (Rust) and `src/` (React/TypeScript)
- [ ] `src-tauri/Cargo.toml` configured with Tauri v2 dependencies (`tauri`, `tauri-plugin-positioner` with `tray-icon` feature), app identifier `com.kore.app`
- [ ] `src-tauri/tauri.conf.json` configured for menu bar app (system tray enabled, no default window on launch)
- [ ] `apps/macos/package.json` created with React, TypeScript, `@tauri-apps/api`, and `@tauri-apps/plugin-positioner` dependencies
- [ ] `apps/macos/src/App.tsx` renders a minimal placeholder panel (shown when tray icon is clicked)
- [ ] `apps/macos/index.html` entry point exists
- [ ] Root `package.json` workspaces already include `./apps/*` — verify no changes needed
- [ ] `Info.plist` includes `NSAppleEventsUsageDescription` for Apple Notes access
- [ ] `Kore.entitlements` includes `com.apple.security.files.user-selected.read-write`, `com.apple.security.files.bookmarks.app-scope`, and `com.apple.security.cs.allow-unsigned-executable-memory`
- [ ] **Minimal tray POC:** `main.rs` creates a tray icon using `TrayIconBuilder`, registers a single "Quit Kore" menu item, and uses `tauri-plugin-positioner` to position the panel window relative to the tray icon on click
- [ ] Tray icon visually appears in the macOS menu bar when the app runs
- [ ] Clicking the tray icon opens/closes the placeholder panel window, positioned correctly below the icon
- [ ] "Quit Kore" menu item exits the app cleanly
- [ ] `bun install` succeeds from repo root
- [ ] `cargo build` succeeds in `apps/macos/src-tauri/`
- [ ] Typecheck/lint passes (`cargo clippy` + TypeScript)
- [ ] **Documentation:** Update `docs/README.md` to add the macOS app entry under the Design section

---

### MAC-002: Config System (TypeScript + Rust)

**Description:** As a developer, I want `config.json` loading in the core API and Rust IPC commands for reading/writing config and checking permissions, so that both the daemon and the GUI share the same configuration data contract.

**Context:**
- Files to read: `apps/core-api/src/config.ts`, `packages/qmd-client/src/index.ts` (for `resolveKoreHome()`), `apps/macos/src-tauri/src/main.rs` (from MAC-001)
- Relevant data contract: the `config.json` schema defined in the Configuration Strategy section of this document
- Precedence order (TypeScript side): env vars > `.env` (Bun auto-loads) > `config.json`
- Permission check target (Rust side): `~/Library/Group Containers/group.com.apple.notes` directory read access

**Acceptance Criteria:**

*TypeScript — `apps/core-api/src/config.ts`:*
- [ ] Exports a new `loadConfig()` function that calls `resolveKoreHome()`, reads `config.json` if present, and uses its values as defaults (env vars take precedence)
- [ ] Config values accessible via exported getter functions (e.g., `getPort()`, `getLlmProvider()`, `getApiKey()`)
- [ ] Existing env var names preserved: `KORE_HOME`, `KORE_API_KEY`, `KORE_PORT`, `LLM_PROVIDER`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `KORE_APPLE_NOTES_ENABLED`, etc.
- [ ] `apps/core-api/src/index.ts` calls `loadConfig()` at startup before any other initialization
- [ ] Existing behavior is 100% backwards-compatible — no `config.json` = no change
- [ ] Unit tests in `apps/core-api/src/config.test.ts`: config.json present, config.json missing (fallback to env), env var overrides JSON value, malformed JSON throws clear error

*Rust — `apps/macos/src-tauri/src/`:*
- [ ] `config.rs` created with:
  - `KoreConfig` struct (serde-serializable) matching the `config.json` schema
  - `read_config(kore_home: &str) -> Result<KoreConfig, String>` — reads and parses JSON, returns defaults if file missing
  - `write_config(kore_home: &str, config: KoreConfig) -> Result<(), String>` — writes JSON with pretty formatting
- [ ] `permissions.rs` created with:
  - `PermissionStatus` enum: `Granted`, `Denied`, `Unknown`
  - `check_notes_access() -> PermissionStatus` — attempts to read the Apple Notes database directory to detect TCC status
  - `open_fda_settings() -> Result<(), String>` — opens `x-apple.systempreferences:com.apple.preference.security?Privacy_AllDiskAccess` via `std::process::Command`
- [ ] `check_bun_installed() -> Result<String, String>` — runs `which bun` and returns version string or error
- [ ] `check_ollama_running(url: &str) -> Result<bool, String>` — HTTP GET to Ollama API endpoint, returns true if reachable
- [ ] All Rust functions exposed as `#[tauri::command]` in `main.rs`
- [ ] Unit tests for `config.rs`: read valid JSON, read missing file returns defaults, write then read round-trip, malformed JSON returns error
- [ ] Typecheck/lint passes (`cargo clippy` + TypeScript)
- [ ] **Documentation:** Add a "Configuration File" section to the root `README.md` explaining the `config.json` option and precedence order. Add inline Rust doc comments on all public structs and functions.

---

### MAC-003: Rust Daemon Process Manager

**Description:** As a developer, I want a Rust module (`daemon.rs`) that manages the Bun daemon as a child process with start/stop/restart, PID file tracking, health polling, and crash recovery so that the Tauri app can reliably control the daemon lifecycle.

**Context:**
- Files to read: `apps/macos/src-tauri/src/main.rs` (from MAC-001), `apps/macos/src-tauri/src/config.rs` (from MAC-002), `apps/core-api/src/operations/health.ts` (health endpoint response schema)
- The daemon is started via `bun run start` at the configured clone path
- Health endpoint: `GET /api/v1/health` on `localhost:{port}` — returns JSON with `version`, `memories`, `queue`, `index` fields

**Acceptance Criteria:**
- [ ] `apps/macos/src-tauri/src/daemon.rs` module created with a `DaemonManager` struct
- [ ] State machine implemented: `Stopped → Starting → Running → Stopping → Stopped`, with `Error` reachable from `Starting` and `Running`
- [ ] `start_daemon(clone_path, port)` spawns `bun run start` via `std::process::Command`, writes PID to `$KORE_HOME/.daemon.pid`
- [ ] `stop_daemon()` sends SIGTERM, waits 5s, then SIGKILL if still alive, deletes PID file
- [ ] `restart_daemon()` calls stop then start
- [ ] `daemon_status()` returns current state enum (`Running`, `Stopped`, `Starting`, `Stopping`, `Error(String)`)
- [ ] Health polling: spawns an async task that polls `GET /api/v1/health` every 5 seconds while in `Running` state. Three consecutive failures transition to `Error`
- [ ] Crash recovery: on child process exit with non-zero code, auto-restart once after 3s delay. If second attempt fails within 30s, stay in `Error` state
- [ ] Startup adoption: on `DaemonManager::new()`, check for `$KORE_HOME/.daemon.pid` — if PID file exists and process is alive, adopt it; if process is dead, delete stale PID file
- [ ] Daemon stdout/stderr captured and written to `$KORE_HOME/logs/daemon.log` (simple append, no rotation in MVP)
- [ ] All functions exposed as `#[tauri::command]` in `main.rs`
- [ ] Typecheck/lint passes (`cargo clippy`)
- [ ] Write unit tests covering: start writes PID file, stop cleans up PID file, crash triggers single auto-restart, double crash within 30s does not restart, stale PID file on startup is cleaned up
- [ ] **Documentation:** Add inline Rust doc comments on all public functions

---

### MAC-004: Full System Tray with Status and Dropdown

**Description:** As a user, I want the menu bar icon to reflect daemon status and provide a dropdown menu for quick actions so that I can monitor and control Kore without opening a window.

**Context:**
- Files to read: `apps/macos/src-tauri/src/main.rs` (from MAC-001), `apps/macos/src-tauri/src/daemon.rs` (from MAC-003), `apps/macos/src-tauri/src/config.rs` (from MAC-002)
- Extends the minimal tray POC from MAC-001 with dynamic state and daemon integration
- Icon states: filled circle (running), hollow circle (stopped), exclamation (error)

**Acceptance Criteria:**
- [ ] Tray icon updates to reflect daemon state: filled (running), hollow (stopped), exclamation (error)
- [ ] Dropdown menu shows:
  - Status line: "Last sync: {time}" and "Daemon: {status} on :{port}" (from health poll data)
  - "Sync Apple Notes Now" — calls `POST /api/v1/remember` or equivalent sync trigger
  - "Trigger Consolidation" — calls `POST /api/v1/consolidate`
  - "Settings..." (with `⌘,` accelerator) — opens Settings window
  - "Quit Kore" — triggers clean daemon shutdown then app exit
- [ ] Health poll data from `daemon.rs` updates the menu status text every 5 seconds
- [ ] Daemon API calls include the Bearer token read from `config.rs`
- [ ] Typecheck/lint passes (`cargo clippy`)
- [ ] **Documentation:** Update `docs/design/macos-app.md` if any menu bar behavior deviates from the spec

---

### MAC-005: Settings Window

**Description:** As a user, I want a Settings window with tabs for General, LLM, Apple Notes, and MCP configuration so that I can manage all Kore settings through a GUI.

**Context:**
- Files to read: `apps/macos/src/App.tsx` (from MAC-001), `apps/macos/src-tauri/src/config.rs` (from MAC-002 — `KoreConfig` struct)
- UI reads config via `invoke('read_config')`, writes via `invoke('write_config')`
- Settings window opens from tray "Settings..." item or `⌘,`
- MCP install buttons call `invoke('install_mcp_config')` — implemented in MAC-006

**Acceptance Criteria:**
- [ ] `apps/macos/src/pages/Settings.tsx` created with a tabbed layout
- [ ] **General tab:**
  - Clone path input with file picker (validated — path must contain `apps/core-api/`)
  - KORE_HOME directory display with "Reveal in Finder" button
  - Port input (number, default 3000)
  - Launch at login toggle (calls `invoke('set_launch_at_login')` — implemented in MAC-006)
  - Daemon status indicator (Running / Stopped / Error with message) + Start / Stop / Restart buttons calling IPC commands
  - "Restart required" badge when port or clone path changes
- [ ] **LLM tab:**
  - Provider radio: Ollama / Gemini
  - If Ollama: model name input, URL input (default `http://localhost:11434`), "Check Connection" button calling `invoke('check_ollama_running')`
  - If Gemini: API key text field, model selector
  - Connection test feedback shown inline
- [ ] **Apple Notes tab:**
  - Enable/disable sync toggle
  - Permission status indicator (Granted / Denied / Unknown) from `invoke('check_notes_access')`
  - "Grant Access" button that calls `invoke('open_fda_settings')`
  - Folder allowlist and blocklist text inputs (comma-separated)
  - Sync interval slider (5–60 min, default 15)
  - "Sync Now" button (calls daemon API)
  - Last sync timestamp display
- [ ] **MCP tab:**
  - Claude Desktop config status (detected / not detected — check file existence)
  - "Install MCP Config" button for Claude Desktop calling `invoke('install_mcp_config')`
  - Claude Code config status + install button
- [ ] All settings read from and write to `config.json` via Tauri IPC
- [ ] Save button persists all changes; unsaved changes show a visual indicator
- [ ] Typecheck/lint passes
- [ ] Write component tests: each tab renders, form inputs update state, save calls `invoke('write_config')` with correct payload
- [ ] **Documentation:** None required beyond inline code comments

---

### MAC-006: MCP Config, Launch at Login, and Onboarding

**Description:** As a user, I want one-click MCP installation, launch-at-login support, and a first-run setup wizard so that I can go from install to running without reading documentation.

**Context:**
- Files to read: `apps/macos/src-tauri/src/main.rs`, `apps/macos/src/pages/Settings.tsx` (from MAC-005), root `README.md` (MCP setup section for correct JSON format and file paths)
- Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Code config: `~/.claude/settings.json` or project-level `.mcp.json`
- First launch detected by absence of `$KORE_HOME/config.json`
- Onboarding reuses Settings tab content with a stepper overlay — no separate wizard component

**Acceptance Criteria:**

*Rust — MCP config writer (`apps/macos/src-tauri/src/mcp.rs`):*
- [ ] `install_mcp_config(target: &str, daemon_url: &str, api_key: &str) -> Result<(), String>` implemented
- [ ] For `target = "claude-desktop"`: reads/creates `claude_desktop_config.json`, adds/updates the `kore` MCP server entry with correct `command`, `args`, and `env` fields pointing to the clone path
- [ ] For `target = "claude-code"`: reads/creates the appropriate config file and adds the Kore MCP server entry
- [ ] Existing entries in the config files are preserved — only the `kore` key is added/updated
- [ ] `install_mcp_config` exposed as `#[tauri::command]`
- [ ] Unit tests: generates correct JSON structure, preserves existing config entries, handles missing config file

*Rust — Launch at login (`apps/macos/src-tauri/src/login.rs`):*
- [ ] `set_launch_at_login(enabled: bool)` and `get_launch_at_login() -> bool` implemented using `SMAppService` (via `objc2` crate or shell command to `launchctl`)
- [ ] Both functions exposed as `#[tauri::command]`

*React — Onboarding (`apps/macos/src/pages/Onboarding.tsx`):*
- [ ] Stepper wrapper around Settings tab content
- [ ] On app launch, Rust checks for `config.json` — if absent, opens onboarding window instead of starting daemon
- [ ] **Step 1 — Welcome:** Brief explanation of Kore + "Let's configure your setup" button
- [ ] **Step 2 — General:** Clone path (auto-detected from `~/dev/kore`), KORE_HOME, Bun check via `invoke('check_bun_installed')` with inline status
- [ ] **Step 3 — LLM:** Provider selection (Ollama / Gemini) with connection test
- [ ] **Step 4 — Apple Notes:** Enable/disable toggle, permission grant flow if enabled
- [ ] **Step 5 — MCP:** Optional auto-config for Claude Desktop and Claude Code via `invoke('install_mcp_config')`
- [ ] **Step 6 — Start:** Writes `config.json` via `invoke('write_config')`, starts daemon via `invoke('start_daemon')`, shows "Kore is running" confirmation
- [ ] Required fields (clone path, KORE_HOME) block step progression; stepper allows going back
- [ ] After completion, app transitions to normal menu bar mode
- [ ] Component tests: stepper advances, required fields block progression, final step calls write_config then start_daemon
- [ ] Typecheck/lint passes (`cargo clippy` + TypeScript)
- [ ] **Documentation:** Update root `README.md` MCP setup section to mention the app's "Install MCP Config" button as an alternative to manual setup

---

## Future Extensions

- **Track 6: macOS App** replaces Track 5.5 (Onboarding) and partially replaces Track 2.3 (Web Dashboard) and Track 2.2 (Raycast Extension) — the Quick Search window covers the Raycast use case, and the Dashboard covers the Web Dashboard use case, both in a native-feeling package.
- **Track 3 (Push Channel)** becomes easier to build once the app exists — native notifications are already wired up, and the app can eventually host a location permission request for geofencing nudges.
- **Track 1.1 (Browser Extension)** remains independent — the browser extension talks to the daemon API regardless of whether the app exists.
- **Phase 2:** Dashboard window (Memories, Insights, Sync Status tabs), native macOS notifications via `tauri-plugin-notification`, advanced settings (log viewer, reset, export).
- **Phase 3:** Quick Search global hotkey window (`⌘⌥K`), self-contained app bundling (Bun + source + node_modules in Resources/), Keychain integration for API keys.
- **Phase 4:** Apple Developer notarization, DMG installer, auto-updater, graph view for memory relationships.

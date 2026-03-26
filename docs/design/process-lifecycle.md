# Kore Process Lifecycle Management

**Author:** eho
**Date:** 2026-03-26
**Status:** Revised
**Revised 2026-03-26:** Addressed review feedback — split LCM-001 into rename + behavior stories, added state transition table, resolved `--force` mechanism, renamed PID file to `.kore.pid`, documented polling intervals and restart behavior.

---

## Problem Statement

The macOS app's `DaemonManager` has accumulated incremental patches for edge cases — orphan adoption, EADDRINUSE on restart, tray icon not reflecting adopted processes, externally-started servers killed on quit — that have made the lifecycle logic fragile and hard to reason about. There is no way for users to stop or restart Kore from the tray menu, and the CLI has no stop/status commands. The result: when something goes wrong with the server process, users have no recovery path short of quitting the app and manually killing processes.

Additionally, the current code conflates three distinct ownership scenarios (app-spawned, PID-file-adopted, health-probe-observed) into a single code path, leading to surprising behavior like killing a developer's terminal-started server when the macOS app quits.

---

## Goals

1. **Clear ownership semantics** — distinguish spawned, adopted, and observed processes with explicit, different quit/stop behavior for each.
2. **User-controllable lifecycle** — expose Start / Stop / Restart in the tray menu so users never need to kill processes manually.
3. **CLI parity** — add `kore stop` command and extend `kore health` with process info, sharing the same PID file contract as the macOS app.
4. **Single state machine** — all state transitions defined in one place, auditable, with no implicit edges.
5. **No "daemon" in user-facing language** — use "Kore" or "server" in menus, CLI output, and logs.

---

## Non-Goals

- **launchd integration** — not adding a system-level launch daemon (SMAppService for login items is already implemented separately).
- **Multi-instance support** — only one Kore server per `$KORE_HOME`. Running multiple servers on different ports is out of scope.
- **Remote server management** — the CLI and macOS app only manage `localhost` processes.
- **Log rotation** — the current simple append-to-file approach is sufficient for MVP. Rotation is a future concern.
- **Bundled Bun binary** — the server still runs from the user's local clone with their installed Bun. Self-contained app bundling is a separate design.

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Orphan processes after app quit | 0 (for spawned/adopted) | Manual test: quit app, check `ps aux \| grep bun` |
| Externally-started server survives app quit | Always | Manual test: start from terminal, open app, quit app, verify server still running |
| Time from tray "Start" click to running status | < 8 seconds | Timestamp delta in logs |
| CLI `kore health` accuracy | Matches actual process state | Automated test comparing `kore health` output with `kill -0` and health check |

---

## Design Principles

1. **You break it, you own it.** Only kill processes the app (or CLI) spawned. Adopted processes (from a previous app session via PID file) are treated as owned. Observed processes (found via health probe, no PID file) are never killed.
2. **Fail loud, recover quiet.** Surface errors clearly in the tray and CLI. Auto-restart silently on first crash, but stop and show the error on repeated crashes.
3. **Single source of truth.** The PID file at `$KORE_HOME/.kore.pid` is the coordination point between the macOS app and CLI. Whoever writes the PID file owns the process.
4. **No daemon in user-facing text.** Menus say "Start Kore" / "Stop Kore". CLI says "Kore is running on :3000". Logs can use "server" or "process" internally.

---

## Vision Alignment

Kore's vision emphasizes a **background engine that removes the burden of "remembering to remember"** through passive operation. The macOS app exists to make this invisible — the server runs behind a menu bar icon, not in a terminal tab. This design directly supports that by making lifecycle management reliable enough that users never think about it: the server starts on app launch, recovers from crashes, and stops cleanly on quit. The CLI commands support developers who work outside the GUI but still need reliable start/stop behavior.

---

## Alternatives Considered

### A. launchd-managed server process
Run the Kore server as a `launchd` user agent with `KeepAlive: true`, independent of the macOS app. The app becomes a pure status monitor.

**Rejected because:** Adds significant complexity (plist management, `launchctl` interactions, permission issues). The server depends on Bun and native modules at user-specific paths that `launchd` environments don't inherit. The Postgres.app model (app owns the process) is simpler and proven.

### B. Server writes its own PID file
Have the core-api server write `$KORE_HOME/.kore.pid` on startup instead of the parent process writing it.

**Rejected because:** The PID file is a contract between the *manager* (app or CLI) and the process. If the server writes its own PID file, any crash leaves a stale file with no owner to clean it up reliably. The manager should write the PID file because the manager is responsible for lifecycle. However, see Open Questions for a hybrid approach.

### C. Unix socket instead of PID file for coordination
Use a Unix domain socket at `$KORE_HOME/.kore.sock` as the liveness indicator.

**Rejected because:** Adds complexity for marginal benefit. PID files are the standard macOS pattern (used by PostgreSQL, MySQL, nginx). The health endpoint already provides liveness checking beyond what a socket existence check offers.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Kore macOS App                        │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ AppDelegate  │───▶│ ProcessMgr   │───▶│ Kore      │  │
│  │ (tray menu)  │    │ (lifecycle)  │    │ Server    │  │
│  │              │◀───│              │◀───│ (Bun)     │  │
│  └─────────────┘    └──────────────┘    └───────────┘  │
│         │                  │                            │
│         │           PID file read/write                 │
│         │                  │                            │
└─────────┼──────────────────┼────────────────────────────┘
          │                  ▼
          │     $KORE_HOME/.kore.pid   ◀──── Shared contract
          │                  ▲
          │                  │
┌─────────┼──────────────────┼────────────────────────────┐
│         │           PID file read/write                 │
│         ▼                  │                            │
│  ┌─────────────┐    ┌──────────────┐                   │
│  │ kore CLI    │───▶│ stop/health  │                   │
│  │ (Commander) │    │ (new + ext)  │                   │
│  └─────────────┘    └──────────────┘                   │
│                                                         │
│                    Kore CLI (`@kore/cli`)                │
└─────────────────────────────────────────────────────────┘
```

**Key components:**

- **ProcessManager** (renamed from `DaemonManager`) — the Swift actor that owns the state machine, spawns/stops processes, manages PID file, runs health polling.
- **PID file** (`$KORE_HOME/.kore.pid`) — plain text file containing the server's PID. Written by the spawner (app or CLI). Read by anyone to check liveness.
- **Health endpoint** (`GET /api/v1/health`) — HTTP liveness check. Used for health polling and observed-mode detection.
- **CLI commands** (`kore start`, `kore stop`, `kore health`) — `start` and `stop` manage the PID file; `health` (existing) is extended with process info (PID, uptime) when available. No separate `status` command — `kore health` already fills that role.

---

## API & Data Contracts

### PID File Contract

```
Location: $KORE_HOME/.kore.pid
Format:   Single line containing the PID as a decimal integer, followed by a newline.
Owner:    The process that spawned the server (macOS app or CLI).
Write:    Atomic write-then-rename to prevent partial reads during races.
          Swift: String.write(to:atomically:) already does this.
          TS: write to .kore.pid.tmp, then rename to .kore.pid.
Lifecycle:
  - Written immediately after successful Process.run() / Bun.spawn()
  - Deleted on clean shutdown (stop, quit, SIGTERM)
  - Stale files (PID not alive) are cleaned up by any reader
```

### Ownership Enum (Swift)

```swift
/// How the app relates to the running server process.
public enum ProcessOwnership: Equatable, Sendable {
    /// We spawned this process — we own it, will kill on quit.
    case spawned

    /// Found via PID file from a previous app session — treat as owned.
    /// Adoption requires BOTH: (1) kill(pid, 0) confirms process alive,
    /// AND (2) health endpoint responds with valid Kore status.
    /// This prevents adopting a random process after PID reuse (e.g., reboot).
    case adopted

    /// Found via health probe only (no PID file) — monitor, don't kill.
    case observed

    /// No server detected.
    case none
}
```

### State Machine (Swift)

```swift
public enum ServerState: Equatable, Sendable {
    case stopped
    case starting
    case running
    case stopping
    case error(String)
}
```

### State Transition Table

```
stopped  ──▶ starting    (startServer, auto-start, or auto-restart after crash)
starting ──▶ running     (process spawned + health OK, or adoption/probe succeeds)
starting ──▶ error       (spawn failure, health never passes, Bun not found, bad clone path)
running  ──▶ stopping    (user stop, app quit with owned process)
running  ──▶ error       (3 consecutive health failures, or observed server disappears)
stopping ──▶ stopped     (process terminated)
error    ──▶ starting    (auto-restart once within 30s, or user clicks Start/Restart)
error    ──▶ stopped     (user acknowledges, or reconnect probe cycle resets)
stopped  ──▶ running     (reconnect probe detects external server → observed)
```

Invalid transitions are silently ignored (guard clauses). For example, calling `startServer()` while in `.running` is a no-op.

**Ownership validity per state:**

| State | Valid ownership values |
|-------|----------------------|
| `.stopped` | `.none` |
| `.starting` | `.none` (spawning in progress) |
| `.running` | `.spawned`, `.adopted`, `.observed` |
| `.stopping` | `.spawned`, `.adopted` (never `.observed` — observed servers aren't stopped) |
| `.error` | `.spawned`, `.adopted`, `.none` |

### Restart Behavior

`restartServer()` is `stopServer()` then `startServer()` — two sequential state transitions:

```
running → stopping → stopped → starting → running
```

There is no direct `running → starting` shortcut. The delay between stop and start is the time it takes for `terminateActiveProcess()` to complete (up to 5s for SIGTERM + SIGKILL). No additional artificial delay.

### CLI Health Output (extended)

The existing `kore health` command is extended to include process info when a PID file exists:

```
$ kore health
Kore is running on :3000 (pid 12345)

Version:      1.2.0

Memories
  Total:      142
  ...

$ kore health  # when stopped
Kore is not running.

$ kore health --json  # includes process info when available
{"pid":12345,"port":3000,"version":"1.2.0","memories":{...},...}

$ kore health --json  # when stopped
{"status":"stopped"}
```

When the server is unreachable, `kore health` also checks the PID file to give a more precise error: "Kore process exists (pid 12345) but health endpoint is not responding" vs "Kore is not running."

### CLI Stop Output

```
$ kore stop
Stopping Kore (pid 12345)... done.

$ kore stop  # when not running
Kore is not running.

$ kore stop  # when no PID file but health endpoint responds
Kore is running but was not started by the CLI (no PID file).
Use --force to stop it anyway, or stop it from the process that started it.

$ kore stop --force
Stopping Kore on :3000... done.
```

---

## Integration Points

### Swift — ProcessManager (refactored from DaemonManager)

**File:** `apps/macos/Kore/Sources/KoreLib/DaemonManager.swift` → rename to `ProcessManager.swift`

Changes:
- Rename `DaemonManager` → `ProcessManager` (class and all references)
- Rename `DaemonState` → `ServerState`
- Rename `DaemonHealthInfo` → `ServerHealthInfo`
- Add `ownership: ProcessOwnership` property alongside `state`
- `stopServer()` (renamed from `stopDaemon`) checks ownership before killing:
  - `.spawned` / `.adopted` → SIGTERM → SIGKILL
  - `.observed` → no-op (or send SIGTERM only if explicitly forced via a `force` parameter)
- `terminateSync()` respects ownership — only kills spawned/adopted
- `adoptOrphanedProcess(port:)` becomes async — checks PID liveness AND health endpoint before adopting. Sets `ownership = .adopted` only if both pass. Deletes PID file if PID is alive but health fails (PID reuse)
- `probeForRunningDaemon()` sets `ownership = .observed` (not `.none`)

### Swift — AppDelegate tray menu

**File:** `apps/macos/Kore/Sources/Kore/KoreApp.swift`

Changes to `buildMenu()`:
- Add "Start Kore" menu item (enabled when state is `.stopped` or `.error`)
- Add "Stop Kore" menu item (enabled when state is `.running` and ownership is `.spawned` or `.adopted`)
- Add "Restart Kore" menu item (enabled when state is `.running` and ownership is `.spawned` or `.adopted`)
- Rename internal references from "daemon" to "server" in variable names and log messages

### Swift — BridgeHandler

**File:** `apps/macos/Kore/Sources/KoreLib/BridgeHandler.swift`

Changes:
- Update bridge message type names: `daemonStatus` → `serverStatus`, `startDaemon` → `startServer`, etc.
- Add `ownership` field to status messages sent to JS
- Update all internal references

### CLI — New and modified commands

**File:** `apps/cli/src/commands/stop.ts` (new)

Needs to:
1. Resolve `$KORE_HOME` (reuse the same logic as ConfigManager — check `KORE_HOME` env var, walk up for `.env`, default `~/.kore`)
2. Read `$KORE_HOME/.kore.pid`
3. Check process liveness with `process.kill(pid, 0)` (signal 0 = liveness check)
4. Send SIGTERM, wait, SIGKILL if needed, delete PID file

**File:** `apps/cli/src/commands/health.ts` (modified)

Changes:
- Before hitting the health endpoint, check the PID file for process info
- When server is reachable: prepend "Kore is running on :PORT (pid N)" to existing output
- When server is unreachable but PID file has a live process: "Kore process exists (pid N) but health endpoint is not responding"
- When nothing found: "Kore is not running." (replaces current generic error)
- `--json` output gains `pid` and `port` fields when available

**File:** `apps/cli/src/commands/start.ts` (modified)

Changes:
- Write PID file after successful spawn
- Delete PID file on exit (register SIGTERM/SIGINT handlers)
- Read port from `$KORE_HOME/config.json` if available
- Support `--port` flag override
- Check for existing PID / health before spawning

**File:** `apps/cli/src/index.ts` (modified)

Changes:
- Register `stop` command
- Update `start` command description (remove "daemon" wording)

### CLI — Shared utility

**File:** `apps/cli/src/utils/pid.ts` (new)

Shared PID file operations:
```typescript
export function pidFilePath(koreHome: string): string
export async function readPidFile(koreHome: string): Promise<number | null>
export async function writePidFile(koreHome: string, pid: number): Promise<void>
export async function deletePidFile(koreHome: string): Promise<void>
export function isProcessAlive(pid: number): boolean
```

### CLI — Config resolution

**File:** `apps/cli/src/utils/env.ts` (modified)

Add `resolveKoreHome()` function that mirrors the Swift `ConfigManager.resolveKoreHome()` logic:
1. Check `KORE_HOME` env var
2. Walk up directory tree looking for `.env` with `KORE_HOME=...`
3. Default to `~/.kore`

---

## Sequence / Flow Walkthrough

### Flow 1: Normal app launch (post-onboarding)

```
1. AppDelegate.applicationDidFinishLaunching
2. Read config.json → get port, clonePath
3. Create ProcessManager
4. Register state change + health poll callbacks
5. processManager.adoptOrphanedProcess(port:)
   → reads .kore.pid
   → if PID alive AND health endpoint confirms Kore: set ownership=.adopted, state=.running, start health polling
   → if PID alive but health fails: delete PID file (not our process — PID was reused)
   → if PID dead: delete stale PID file
6. If not adopted:
   processManager.probeForRunningDaemon(port:)
   → GET /api/v1/health
   → if healthy: set ownership=.observed, state=.running, start health polling
   → if not: set state=.stopped, start reconnect probing
7. If still stopped and autoStart enabled:
   processManager.startServer(clonePath:, port:)
   → spawn bun, write PID file, ownership=.spawned, state=.running
8. Update tray icon and menu based on state + ownership
```

### Flow 2: User clicks "Stop Kore" in tray

```
1. stopServer() called on ProcessManager
2. Check ownership:
   - .spawned/.adopted → proceed
   - .observed → no-op (button should be disabled, but guard anyway)
   - .none → no-op
3. Cancel health polling
4. Set state = .stopping, notify UI
5. Send SIGTERM to process
6. Wait up to 5 seconds (100ms poll loop)
7. If still alive: send SIGKILL
8. Delete PID file
9. Set state = .stopped, ownership = .none
10. Start reconnect probing (in case user starts server externally later)
```

### Flow 3: `kore stop` from CLI

```
1. Resolve KORE_HOME
2. Read .kore.pid
3. If no PID file:
   a. Check health endpoint at configured port
   b. If healthy: print "Kore is running but was not started by the CLI"
   c. If not: print "Kore is not running." → exit 0
4. If PID file exists:
   a. Check process liveness (kill -0)
   b. If not alive: delete stale PID file, print "Kore is not running." → exit 0
   c. If alive: send SIGTERM, wait up to 10s, SIGKILL if needed
   d. Delete PID file
   e. Print "Stopping Kore (pid N)... done."
```

### Flow 4: `kore start` from CLI (updated)

```
1. Resolve KORE_HOME, read config.json for port
2. Check .kore.pid — if exists and alive, print "Kore is already running (pid N)" → exit 0
3. Check health endpoint — if healthy, print "Kore is already running on :PORT" → exit 0
4. Spawn bun process (foreground, inherited stdio)
5. Write .kore.pid with child PID
6. Register SIGTERM/SIGINT handler to:
   a. Forward signal to child
   b. Delete PID file
   c. Exit
7. Await child exit → delete PID file → propagate exit code
```

### Flow 5: App quit with observed server

```
1. User clicks "Quit Kore"
2. applicationWillTerminate fires
3. processManager.terminateSync() called
4. Check ownership:
   - .observed → skip termination, just clean up app state
   - .spawned/.adopted → SIGTERM → wait → SIGKILL → delete PID
5. App exits; external server continues running
```

---

## Example Output

### Tray menu (server running, app-spawned)

```
┌──────────────────────────────────┐
│ Kore: running on :3000           │  (disabled info row)
│ Last sync: 2m ago                │  (disabled info row)
├──────────────────────────────────┤
│ ■ Stop Kore                      │
│ ↻ Restart Kore                   │
├──────────────────────────────────┤
│ Sync Apple Notes Now             │
│ Trigger Consolidation            │
├──────────────────────────────────┤
│ Settings…                   ⌘,   │
├──────────────────────────────────┤
│ Quit Kore                   ⌘Q   │
└──────────────────────────────────┘
```

### Tray menu (server running, observed — started externally)

```
┌──────────────────────────────────┐
│ Kore: running on :3000           │
│ Last sync: 2m ago                │
├──────────────────────────────────┤
│ Sync Apple Notes Now             │
│ Trigger Consolidation            │
├──────────────────────────────────┤
│ Settings…                   ⌘,   │
├──────────────────────────────────┤
│ Quit Kore                   ⌘Q   │
└──────────────────────────────────┘
```

Note: Stop/Restart are hidden (not just disabled) when server is observed — reduces confusion.

### Tray menu (server stopped)

```
┌──────────────────────────────────┐
│ Kore: not running                │
├──────────────────────────────────┤
│ ▶ Start Kore                     │
├──────────────────────────────────┤
│ Settings…                   ⌘,   │
├──────────────────────────────────┤
│ Quit Kore                   ⌘Q   │
└──────────────────────────────────┘
```

### CLI session

```
$ kore health
Kore is not running.

$ kore start
Kore Core API running on http://localhost:3000
QMD store initialized
...

# In another terminal:
$ kore health
Kore is running on :3000 (pid 54321)

Version:      1.2.0

Memories
  Total:      142
  ...

$ kore stop
Stopping Kore (pid 54321)... done.
```

---

## Configuration

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `port` | `config.json` / `KORE_PORT` env / `--port` flag | `3000` | Server listen port |
| `clonePath` | `config.json` | `~/dev/kore` | Path to Kore monorepo clone |
| `koreHome` | `KORE_HOME` env / `config.json` | `~/.kore` | Kore data directory |
| `apiKey` | `config.json` / `KORE_API_KEY` env | `""` | API key for server auth |

**PID file location:** `$KORE_HOME/.kore.pid` (not configurable — it's a contract, not a preference).

**Process management constants** (compile-time, not user-configurable):

| Constant | Value | Description |
|----------|-------|-------------|
| Health poll interval | 5 seconds | How often the running server's health endpoint is checked |
| Reconnect probe interval | 10 seconds | How often the idle app probes for an externally-started server |
| Health check timeout | 5 seconds | HTTP request timeout per health check |
| Max consecutive health failures | 3 | Failures before declaring server unresponsive |
| SIGTERM grace period | 5 seconds | Time to wait before escalating to SIGKILL |
| Auto-restart delay | 3 seconds | Delay before restarting after a crash |
| Crash window | 30 seconds | If second crash occurs within this window, stop auto-restarting |

**Auto-start behavior:** After onboarding completes (i.e., `lastLaunchAt` is set in config.json), the macOS app auto-starts the server on launch if no running server is detected. This matches Postgres.app's model.

---

## Testing Strategy

### Swift unit tests

**File:** `apps/macos/Kore/Tests/KoreTests/ProcessManagerTests.swift` (rename from `DaemonManagerTests.swift`)

| Test case | Description |
|-----------|-------------|
| Spawn sets ownership to `.spawned` | Start server, verify `ownership == .spawned` |
| Adopt with healthy endpoint sets `.adopted` | Write PID file with alive PID, mock healthy endpoint, call `adoptOrphanedProcess(port:)`, verify `.adopted` |
| Adopt with live PID but unhealthy endpoint rejects | Write PID file with alive PID, mock failed health, call `adoptOrphanedProcess(port:)`, verify PID file deleted and state stays `.stopped` |
| Probe sets ownership to `.observed` | Mock health endpoint, call `probeForRunningDaemon()`, verify `.observed` |
| Stop kills spawned process | Start, stop, verify process terminated and PID file deleted |
| Stop kills adopted process | Adopt, stop, verify SIGTERM sent and PID file deleted |
| Stop skips observed process | Observe, stop, verify no signal sent, state transitions to `.stopped` |
| Quit skips observed process | Observe, call `terminateSync()`, verify process still alive |
| Stale PID file cleaned up | Write PID file with dead PID, adopt, verify file deleted and state stays `.stopped` |
| Auto-restart on crash | Start, kill process, verify single restart attempt within 3s |
| No restart loop | Start, kill twice within 30s, verify state is `.error` after second crash |
| Health failure triggers recovery | Mock 3 failed health checks, verify state transition to error + restart |
| State machine rejects invalid transitions | Attempt `.stopped` → `.stopping`, verify no-op |

### CLI tests

**File:** `apps/cli/tests/stop.test.ts` (new)
**File:** `apps/cli/tests/health.test.ts` (extend existing or new)

| Test case | Description |
|-----------|-------------|
| `health` with no PID file and no server | Prints "Kore is not running." |
| `health` with server running and PID file | Prepends "Kore is running on :PORT (pid N)" to output |
| `health` with PID alive but server unresponsive | Prints "process exists but health endpoint not responding" |
| `health --json` includes pid/port fields | Valid JSON with pid, port, version, memories fields |
| `stop` with valid PID file | Sends SIGTERM, deletes PID file, prints confirmation |
| `stop` with no PID file | Prints "not running", exits 0 |
| `stop` with stale PID file | Cleans up file, prints "not running" |
| `stop` without PID file but health responds | Prints warning about external process |
| `stop --force` without PID file | Discovers port from config, stops regardless |
| `start` when already running | Prints "already running", exits 0 |
| `start` writes PID file | Verify PID file exists after spawn |

**File:** `apps/cli/tests/pid.test.ts` (new)

| Test case | Description |
|-----------|-------------|
| `writePidFile` / `readPidFile` roundtrip | Write PID, read it back, verify match |
| `readPidFile` with missing file | Returns null |
| `readPidFile` with corrupt content | Returns null |
| `isProcessAlive` with current process | Returns true |
| `isProcessAlive` with invalid PID | Returns false |
| `deletePidFile` removes file | Write, delete, verify gone |

### Manual test checklist

- [ ] Start from app, quit app → server stops, no orphan
- [ ] Start from terminal (`kore start`), open app → tray shows "running", no duplicate spawn
- [ ] Start from terminal, open app, quit app → server keeps running
- [ ] Start from app, `kore stop` in terminal → server stops, tray updates within 10s
- [ ] Start from app, `kore health` → shows "running on :3000 (pid N)" with correct PID
- [ ] Kill server process (`kill <pid>`), app auto-restarts once
- [ ] Kill server twice within 30s → app shows error, no restart loop
- [ ] `kore start` when already running → prints "already running"
- [ ] Click "Start Kore" in tray when stopped → server starts, tray updates

---

## Observability & Logging

### Log format

Plain text, prefixed with `[Kore]` for macOS app logs, no prefix for CLI (direct stdout/stderr).

### Key operations to log

| Event | Level | Format | Example |
|-------|-------|--------|---------|
| Server spawn | info | `[Kore] Starting server — clone={path} port={port}` | `[Kore] Starting server — clone=~/dev/kore port=3000` |
| Server running | info | `[Kore] Server running (pid {pid}) on :{port}` | `[Kore] Server running (pid 12345) on :3000` |
| Server stop initiated | info | `[Kore] Stopping server (pid {pid}, ownership={own})` | `[Kore] Stopping server (pid 12345, ownership=spawned)` |
| Server stopped | info | `[Kore] Server stopped` | |
| State transition | info | `[Kore] State: {old} → {new}` | `[Kore] State: stopped → starting` |
| Ownership set | info | `[Kore] Ownership: {value} (source: {how})` | `[Kore] Ownership: adopted (source: PID file)` |
| PID file written | debug | `[Kore] PID file written: {path} = {pid}` | |
| PID file deleted | debug | `[Kore] PID file deleted: {path}` | |
| Stale PID file cleaned | info | `[Kore] Stale PID file removed (pid {pid} not alive)` | |
| Health check pass | debug | `[Kore] Health OK on :{port}` | |
| Health check fail | warn | `[Kore] Health check failed on :{port} ({n}/3)` | `[Kore] Health check failed on :3000 (2/3)` |
| Health failure → recovery | error | `[Kore] Server unresponsive (3 failures), attempting recovery` | |
| Crash detected | error | `[Kore] Server exited (code {n}), auto-restarting in 3s` | |
| Double crash | error | `[Kore] Server crashed again within 30s — not restarting. stderr: {last_lines}` | |
| Observed server detected | info | `[Kore] External server detected on :{port} (monitoring only)` | |
| Observed server lost | info | `[Kore] External server on :{port} no longer responding` | |
| Quit with observed server | info | `[Kore] Quitting — leaving external server running` | |
| Spawn failure | error | `[Kore] Failed to start server: {error}` | |
| SIGKILL escalation | warn | `[Kore] Server did not stop after SIGTERM, sending SIGKILL` | |

---

## Edge Cases & Failures

| Failure | Detection | Mitigation |
|---------|-----------|------------|
| **Port in use (EADDRINUSE)** | `bun run start` exits immediately | Transition to `.error`. Tray shows "Port 3000 is in use." Start button remains available for retry after user resolves conflict. |
| **Bun not installed** | `checkBunInstalled()` throws | Transition to `.error`. Tray shows "Bun not found — install from bun.sh." |
| **Clone path invalid** | Missing `apps/core-api/` directory | Transition to `.error`. Tray shows "Kore clone not found at {path}." |
| **Server crash (single)** | Child process exits non-zero | Auto-restart once after 3s delay. Log exit code and stderr. |
| **Server crash (repeated)** | Second crash within 30s of first | Stay in `.error`. Show stderr excerpt. No further auto-restart. |
| **Server killed externally** | Child process exit signal | Same as crash — single auto-restart attempt. |
| **Health poll failures (hang)** | 3 consecutive failures (15s) | Transition to `.error`. SIGTERM → SIGKILL the process. Single auto-restart attempt. |
| **App crash / force quit** | Stale PID file on next launch | `adoptOrphanedProcess()` checks PID liveness AND health endpoint. Both pass → adopt. PID alive but health fails → delete PID file (PID reused by another process). PID dead → delete stale PID file. |
| **CLI and app race on PID file** | Both try to write PID file | `start` commands check for existing alive PID before spawning. First writer wins. Second gets "already running." |
| **App quit with observed server** | `ownership == .observed` | `terminateSync()` is a no-op. Server continues. Tray disappears, server keeps running. |
| **Config change requiring restart** | User changes port/clonePath in Settings | Settings shows "Restart required" badge. User clicks Restart explicitly. |
| **`kore stop` for externally started server** | No PID file, health responds | Print warning. Require `--force` flag to send SIGTERM via PID discovery (`lsof -i :PORT`). |
| **CLI stops server while app has it adopted** | `kore stop` kills process and deletes PID file while macOS app has `ownership = .adopted` | App's health poll detects failure → transitions to `.error` → auto-restart attempt fails (process gone, port free) or succeeds (respawns). If restart succeeds, app becomes the spawner. If the user doesn't want a respawn, they should stop from the app instead. |
| **Reconnect probe finds server** | Health endpoint responds during idle probe | Set `ownership = .observed`, `state = .running`. Start health polling. Update tray icon. |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Renaming DaemonManager breaks existing tests | High | Low | Rename in a single commit with find-replace. Run all tests immediately. |
| PID file race between CLI and app | Low | Medium | Both check liveness before writing. Atomic write (`write-then-rename`). |
| `kill(pid, 0)` false positive (PID reuse) | Low | High — could kill random process | Adoption requires both `kill(pid, 0)` AND a successful health endpoint check confirming Kore. If PID is alive but health fails, PID file is deleted as stale. |
| Breaking bridge API renames (`daemonStatus` → `serverStatus`) | High | Medium | Update Swift and JS in the same story. React UI references are compile-checked by TypeScript. |
| User confusion about observed vs managed | Medium | Low | Tray menu hides Stop/Restart for observed servers. Status line says "running (external)" for clarity. |

---

## Open Questions

1. **Auto-start: should it be a config toggle?** The design says auto-start after onboarding. Should there be a "Start Kore automatically" checkbox in Settings? Postgres.app always auto-starts; Docker Desktop has a toggle. Recommendation: auto-start by default, add a toggle in a future iteration if users request it.

---

## Context Required for Implementation

- `apps/macos/Kore/Sources/KoreLib/DaemonManager.swift` — the current process manager being refactored
- `apps/macos/Kore/Sources/Kore/KoreApp.swift` — AppDelegate with tray menu and lifecycle hooks
- `apps/macos/Kore/Sources/KoreLib/BridgeHandler.swift` — JS↔Swift bridge message routing
- `apps/macos/Kore/Sources/KoreLib/ConfigManager.swift` — config reading/writing and KoreConfig schema
- `apps/macos/Kore/Sources/KoreLib/DaemonAPIClient.swift` — HTTP client for server health checks
- `apps/macos/Kore/Tests/KoreTests/DaemonManagerTests.swift` — existing tests to rename/update
- `apps/cli/src/index.ts` — CLI entry point with command registration
- `apps/cli/src/commands/start.ts` — existing start command to modify
- `apps/cli/src/utils/env.ts` — environment resolution to extend
- `apps/cli/src/api.ts` — API client pattern for health checks
- `apps/core-api/src/index.ts` — server entry point (SIGTERM/SIGINT handling, port binding)
- `apps/core-api/src/routes/system.ts` — health endpoint definition
- `docs/design/macos-app.md` — parent design doc with daemon lifecycle section to update

---

## User Stories

### LCM-001: Rename DaemonManager to ProcessManager and update all references

**Description:** As a developer, I want all "daemon" naming replaced with "server"/"process" naming across the Swift, React, and bridge layers, so the codebase matches the user-facing language and is ready for the ownership model.

**Context:**
- Files to read: `apps/macos/Kore/Sources/KoreLib/DaemonManager.swift`, `apps/macos/Kore/Sources/Kore/KoreApp.swift`, `apps/macos/Kore/Sources/KoreLib/BridgeHandler.swift`, `apps/macos/Kore/Sources/KoreLib/OnboardingWindowManager.swift`, `apps/macos/Kore/Sources/KoreLib/PanelManager.swift`, `apps/macos/Kore/Sources/KoreLib/SettingsWindowManager.swift`, `apps/macos/Kore/Sources/KoreLib/DaemonAPIClient.swift`
- This is a **mechanical rename only** — no behavioral changes. Ownership model comes in LCM-002.

**Acceptance Criteria:**
- [ ] `DaemonManager.swift` renamed to `ProcessManager.swift`; class `DaemonManager` → `ProcessManager`
- [ ] `DaemonState` → `ServerState`, `DaemonHealthInfo` → `ServerHealthInfo` throughout KoreLib
- [ ] All public method names updated: `startDaemon` → `startServer`, `stopDaemon` → `stopServer`, `restartDaemon` → `restartServer`, `daemonStatus` → `serverStatus`
- [ ] `DaemonAPIClient.swift` renamed to `ServerAPIClient.swift`; class `DaemonAPIClient` → `ServerAPIClient`
- [ ] All references in `KoreApp.swift`, `BridgeHandler.swift`, `OnboardingWindowManager.swift`, `PanelManager.swift`, `SettingsWindowManager.swift` updated
- [ ] Bridge message types updated: `daemonStatus` → `serverStatus`, `startDaemon` → `startServer`, `stopDaemon` → `stopServer`, `restartDaemon` → `restartServer`, `getDaemonStatus` → `getServerStatus`
- [ ] React UI files (`Settings.tsx`, `Onboarding.tsx`, `main.tsx`) updated to match new bridge message types
- [ ] All user-facing "daemon" text in React UI replaced with "Kore" or "server" (Settings tab label, Onboarding step, status strings)
- [ ] PID file renamed from `.daemon.pid` to `.kore.pid` in all code references
- [ ] `DaemonManagerTests.swift` renamed to `ProcessManagerTests.swift`; all test references updated
- [ ] Existing tests pass with renamed types
- [ ] `swift build` succeeds; `bun run build` in `apps/macos` succeeds
- [ ] **Documentation:** Update `docs/design/macos-app.md` — rename all DaemonManager references to ProcessManager, update user-facing sections to "server"/"Kore" language

### LCM-002: Ownership model with safe adoption and ownership-aware stop/quit

**Description:** As a user, I want the macOS app to track whether it spawned, adopted, or merely observed the server, so that quitting the app only kills servers it owns and health-verified adoption prevents killing random processes after PID reuse.

**Context:**
- Files to read: `apps/macos/Kore/Sources/KoreLib/ProcessManager.swift` (after LCM-001), `apps/macos/Kore/Sources/Kore/KoreApp.swift`
- Depends on: LCM-001
- Refer to the State Transition Table and Ownership Validity table in the Architecture section of this design doc.

**Acceptance Criteria:**
- [ ] New `ProcessOwnership` enum added to `ProcessManager.swift`: `.spawned`, `.adopted`, `.observed`, `.none`
- [ ] `ProcessManager` has a public `ownership: ProcessOwnership` property, initialized to `.none`
- [ ] `adoptOrphanedProcess(port:)` becomes async — checks PID liveness (`kill(pid, 0)`) AND health endpoint. Only sets `ownership = .adopted` when both pass. If PID alive but health fails, deletes PID file as stale (PID reuse safety). Logs `[Kore] Ownership: adopted (source: PID file)` or `[Kore] Stale PID file removed (pid N not Kore — health check failed)`
- [ ] `probeForRunningDaemon()` sets `ownership = .observed` when health check succeeds; logs `[Kore] External server detected on :PORT (monitoring only)`
- [ ] `startServer()` sets `ownership = .spawned` after successful spawn
- [ ] `stopServer()` checks ownership: `.spawned`/`.adopted` → SIGTERM/SIGKILL + delete PID file; `.observed` → transition to `.stopped`, no signal sent; `.none` → no-op. Resets `ownership = .none`.
- [ ] `terminateSync()` skips termination when `ownership == .observed`, logs `[Kore] Quitting — leaving external server running`
- [ ] `restartServer()` is `stopServer()` then `startServer()` — sequential, no shortcut
- [ ] Bridge status messages include `ownership` field (so JS layer can show "(external)" label)
- [ ] **Tests:** New test cases in `ProcessManagerTests.swift`:
  - Spawn sets `ownership = .spawned`; stop terminates process and deletes PID file
  - Adopt with live PID + healthy endpoint → `ownership = .adopted`; stop sends SIGTERM
  - Adopt with live PID + failed health → PID file deleted, stays `.stopped`, `ownership = .none`
  - Adopt with dead PID → PID file deleted, stays `.stopped`
  - Probe with healthy endpoint → `ownership = .observed`; stop transitions to `.stopped` without signal
  - `terminateSync()` with `.observed` → process still alive after call
- [ ] Existing tests still pass
- [ ] `swift build` succeeds

### LCM-003: Tray menu lifecycle controls with auto-start

**Description:** As a user, I want Start, Stop, and Restart controls in the tray menu and automatic server start on app launch, so I can manage the server without a terminal and it "just works" on launch day-to-day.

**Context:**
- Files to read: `apps/macos/Kore/Sources/Kore/KoreApp.swift` (the `buildMenu()` method and `startNormalMode()`), `apps/macos/Kore/Sources/KoreLib/ProcessManager.swift` (after LCM-001), `apps/macos/Kore/Sources/KoreLib/ConfigManager.swift`
- Depends on: LCM-002

**Acceptance Criteria:**
- [ ] Tray context menu includes "Start Kore" item (shown when state is `.stopped` or `.error`)
- [ ] Tray context menu includes "Stop Kore" item (shown when state is `.running` and ownership is `.spawned` or `.adopted`)
- [ ] Tray context menu includes "Restart Kore" item (shown when state is `.running` and ownership is `.spawned` or `.adopted`)
- [ ] Stop/Restart items are hidden (not just disabled) when ownership is `.observed`
- [ ] "Start Kore" reads `clonePath` and `port` from config and calls `processManager.startServer()`
- [ ] "Stop Kore" calls `processManager.stopServer()`; tray updates within 1s
- [ ] "Restart Kore" calls `processManager.restartServer()`; tray shows "starting" then "running"
- [ ] Status info line: `Kore: running on :3000` when spawned/adopted, `Kore: running on :3000 (external)` when observed, `Kore: not running` when stopped
- [ ] Sync/Consolidation items are disabled (grayed out) when server is not running
- [ ] Menu items update dynamically when state changes (via `updateMenuStatusItems()`)
- [ ] Auto-start: in `startNormalMode()`, after adoption and probe, if still `.stopped` and `lastLaunchAt` is set: auto-start using config `clonePath`/`port`
- [ ] Auto-start skips if `clonePath` is missing or empty; logs `[Kore] Skipping auto-start — no clone path configured`
- [ ] Auto-start failure shows error in tray; user can fix in Settings and click "Start Kore"
- [ ] Reconnect probing: observed server disappears → transition to `.stopped`, show "Start Kore"
- [ ] Reconnect probing: external server appears while idle → transition to `.running` with `.observed`, update tray within 10s
- [ ] Typecheck/lint passes; `swift build` succeeds
- [ ] **Documentation:** Update `docs/design/macos-app.md` tray menu section to reflect new menu items and auto-start behavior

### LCM-004: CLI `kore stop` command and `kore health` process info

**Description:** As a developer, I want a `kore stop` command and enhanced `kore health` output with process info, so I can manage and monitor the server from the terminal using the same PID file contract as the macOS app.

**Context:**
- Files to read: `apps/cli/src/index.ts`, `apps/cli/src/commands/start.ts`, `apps/cli/src/commands/health.ts`, `apps/cli/src/utils/env.ts`, `apps/cli/src/api.ts`
- The existing `kore start` spawns the server but does not write a PID file. The existing `kore health` checks the API but has no process awareness. This story adds PID file support to both and creates `kore stop`.
- **Start with** `kore-home.ts` and `pid.ts` utilities — both `start`, `stop`, and `health` depend on them.

**Acceptance Criteria:**
- [ ] New file `apps/cli/src/utils/pid.ts` with functions: `pidFilePath()`, `readPidFile()`, `writePidFile()`, `deletePidFile()`, `isProcessAlive()`
- [ ] New file `apps/cli/src/utils/kore-home.ts` with `resolveKoreHome()` mirroring Swift ConfigManager logic (env var → `.env` walk → `~/.kore`)
- [ ] `kore start` modified:
  - Checks for existing PID file / health endpoint before spawning; prints "Kore is already running (pid N)" and exits 0 if found
  - Writes `$KORE_HOME/.kore.pid` after successful spawn
  - Registers SIGTERM/SIGINT handlers to delete PID file and forward signal to child
  - Deletes PID file on child exit
- [ ] `kore health` modified:
  - Before hitting API, reads PID file for process info
  - When server reachable: prepends "Kore is running on :PORT (pid N)" to existing output
  - When unreachable but PID alive: "Kore process exists (pid N) but health endpoint is not responding"
  - When nothing found: "Kore is not running." (replaces generic error)
  - `--json` output gains `pid` and `port` fields when available
- [ ] New `kore stop` command:
  - Reads PID file, checks liveness, sends SIGTERM, waits up to 10s, SIGKILL if needed
  - Deletes PID file on success
  - Prints "Stopping Kore (pid N)... done." or "Kore is not running."
  - If no PID file but health responds: prints warning, suggests `--force`
  - `--force` flag: discovers PID via `lsof -i :PORT -t` and sends SIGTERM/SIGKILL regardless of PID file
- [ ] `kore stop` registered in `apps/cli/src/index.ts`; descriptions use "Kore" not "daemon"
- [ ] **Tests:** Unit tests in `apps/cli/tests/pid.test.ts` for PID file utilities (read/write roundtrip, missing file, corrupt content, liveness check)
- [ ] **Tests:** Unit tests in `apps/cli/tests/stop.test.ts` (valid PID, no PID, stale PID, external process warning, `--force`)
- [ ] Typecheck/lint passes
- [ ] **Documentation:** Update `apps/cli/README.md` with `stop` command docs and updated `health` output description; remove "daemon" references from command descriptions

### LCM-005: Update design documentation and READMEs

**Description:** As a developer, I want the macOS app design doc, CLI README, and project README updated to reflect the new process lifecycle design, so that future contributors and users understand the ownership model, tray controls, and CLI commands.

**Context:**
- Files to read: `docs/design/macos-app.md`, `apps/cli/README.md`, `README.md` (project root if it references daemon management)
- Depends on: LCM-001, LCM-002, LCM-003, LCM-004 (all implementation complete)

**Acceptance Criteria:**
- [ ] `docs/design/macos-app.md`: "Daemon Lifecycle & Edge Cases" section rewritten to reference ProcessManager, ownership model (spawned/adopted/observed), health-verified adoption, and `.kore.pid` file
- [ ] `docs/design/macos-app.md`: Tray menu section reflects Start/Stop/Restart controls and auto-start behavior
- [ ] `docs/design/macos-app.md`: User-facing language uses "server"/"Kore" throughout; internal/technical sections may use "process"
- [ ] `docs/design/macos-app.md`: CLI section updated to describe `kore stop` and enhanced `kore health`
- [ ] `docs/design/macos-app.md`: All user stories (MAC-003, MAC-004, etc.) referencing DaemonManager updated to ProcessManager
- [ ] `apps/cli/README.md`: `start` description updated; `stop` command documented with `--force` flag; `health` output description updated to include process info; all "daemon" references removed
- [ ] Project-level README (if it references daemon/server management): updated to reflect current CLI commands and macOS app behavior

---

## Revision Notes

**Revised 2026-03-26:** Addressed review feedback from `review-process-lifecycle.md`.

| # | Feedback Item | Disposition | Reasoning |
|---|---------------|-------------|-----------|
| 1 | LCM-001 too large — split rename from behavioral changes | Accept | Mechanical rename across 10+ files is cleanly separable from ownership model. Gives a reviewable "rename" commit. Split into LCM-001 (rename) and LCM-002 (ownership). |
| 2 | `--force` mechanism underspecified | Accept | Resolved open question: use `lsof -i :PORT -t` for MVP. Updated LCM-004 AC to be explicit. |
| 3 | No state transition diagram | Accept | Added State Transition Table, ownership-per-state table, and restart behavior specification after the ServerState enum. |
| 4 | Vision alignment shallow | Reject | The connection to "background engine" is clear and sufficient. Adding pillar numbers would be pedantic and won't change implementation decisions. |
| 5 | LCM-003 (now LCM-004) sub-task ordering unclear | Accept | Added note that `kore-home.ts` and `pid.ts` utilities should be built first as shared dependencies. |
| 6 | `restartServer()` not defined | Accept | Added Restart Behavior section: `stop → start`, sequential, no shortcut, no artificial delay. |
| 7 | No PID file locking mentioned | Accept | Added atomic write-then-rename specification to PID file contract. |
| 8 | Health poll intervals not in Configuration | Accept | Added "Process management constants" table with all 7 intervals/thresholds. |
| 9 | CLI stops server while app has it adopted — what happens? | Accept | Added to Edge Cases table: health poll failure triggers error state, auto-restart may respawn. |
| 10 | `kore start` foreground vs background | Reject | Foreground is intentional — matches current behavior and `ollama serve`. Users who want background can use `&` or `nohup`. |
| 11 | PID file named `.daemon.pid` contradicts "no daemon" principle | Accept | Renamed to `.kore.pid` throughout. |

---

## Future Extensions

- **`kore restart` CLI command** — convenience wrapper for `stop` + `start`. Deferred because `kore stop && kore start` works and keeps the initial CLI surface small.
- **Auto-start toggle in Settings** — "Start Kore automatically when app launches" checkbox. Deferred because auto-start is the right default; add the toggle only if users request opt-out.
- **`/api/v1/pid` endpoint** — server exposes its own PID for `kore stop --force` discovery without `lsof`. Deferred pending Open Question resolution.
- **Log rotation** — rotate `daemon.log` at 10MB, keep last 3 files. Deferred because simple append is sufficient for MVP.
- **Process group management** — spawn the server in a dedicated process group so SIGTERM kills all child processes (Bun workers, etc.). Worth investigating if orphaned sub-processes become a problem.
- **Structured JSON logs** — switch from `[Kore] plain text` to JSON logs for machine parsing. Deferred until there's a log viewer or aggregation system.

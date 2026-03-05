# PRD: Apple Notes Exporter GUI (`an-export-gui`)

## Introduction

Apple Notes strictly protects its internal database (`NoteStore.sqlite`) behind macOS's Transparency, Consent, and Control (TCC) subsystem. CLI tools (like the underlying `an-export` engine) cannot access this location without forcing the user to grant Full Disk Access to their entire terminal via System Settings—a high-friction, confusing, and technically demanding process.

This project introduces a lightweight, native-feeling graphical user interface (GUI) wrapper using Electron. By utilizing macOS's native `NSOpenPanel` file picker, the app will prompt the user to explicitly select the Apple Notes data folder. macOS implicitly grants "Security-Scoped Bookmarks" to apps when users manually select folders in this dialog, completely bypassing the need for System Settings intervention. 

This GUI will sit in the macOS Menu Bar, allowing for frictionless, background, and completely permission-transparent exports and syncs.

## Goals

- Eliminate the need for users to manually grant "Full Disk Access" in System Settings.
- Provide a simple Menu Bar interface to trigger the export/sync process.
- Bundle the core `an-export` engine seamlessly so the user does not need to install Bun or Node.js separately.
- Maintain a persistent link to the chosen export destination directory.

## User Stories

### US-001: Bootstrap Electron Menu Bar App
**Description:** As a developer, I want an Electron application that runs strictly in the macOS menu bar (no dock icon or primary window) to keep the app lightweight and unobtrusive.

**Acceptance Criteria:**
- [ ] Initialize an Electron app with TypeScript and React (or vanilla HTML/JS if simpler).
- [ ] Configure the app to run as a Menu Bar (Tray) application only (`app.dock.hide()`).
- [ ] Render a generic Tray icon with a dropdown menu.
- [ ] The dropdown menu contains a "Quit" button that successfully closes the app.
- [ ] Typecheck/lint passes.
- [ ] **[Testing]** Verify in browser using dev-browser skill (or run the electron app locally to verify window visibility).

### US-002: Apple Notes Security-Scoped Folder Selection
**Description:** As a user, I need to select my Apple Notes database folder via a native macOS dialog so the application can legally read my notes without Full Disk Access.

**Acceptance Criteria:**
- [ ] Add a "Select Apple Notes Database..." option to the Menu Bar dropdown.
- [ ] Clicking it spawns an Electron `dialog.showOpenDialog` configured for `openDirectory` pointing to `~/Library/Group Containers/` by default.
- [ ] Store the selected path securely (e.g., using `electron-store`).
- [ ] Verify that macOS actually issues read permissions (a simple `fs.readdir` test on the protected folder post-selection).
- [ ] Typecheck/lint passes.
- [ ] **[Testing]** Write unit tests mocking `electron-store` and `dialog` events.

### US-003: Destination Folder Selection
**Description:** As a user, I need to select where my Markdown notes will be exported so the app knows where to write the files.

**Acceptance Criteria:**
- [ ] Add a "Select Export Destination..." option to the Menu Bar dropdown.
- [ ] Clicking it spawns a native directory picker dialog.
- [ ] Store the selected path securely via `electron-store`.
- [ ] Display the currently selected destination path (truncated if necessary) in the Menu Bar dropdown as a disabled visual indicator.
- [ ] Typecheck/lint passes.
- [ ] **[Testing]** Write unit tests covering destination assignment logic.

### US-004: Bundle and Execute Core Engine
**Description:** As a user, I want to click a single "Sync Now" button to run the exporter without needing to install the CLI or Bun on my machine.

**Acceptance Criteria:**
- [ ] Bundle the compiled `an-export` CLI code securely within the Electron app bundle (e.g., using `esbuild` or Webpack).
- [ ] Create a "Sync Now" button in the Menu Bar dropdown.
- [ ] The button is disabled if either the Notes Database or Destination folder has not been selected.
- [ ] Clicking "Sync Now" spawns a hidden background Node process executing the bundled `an-export` code.
- [ ] Pass the securely resolved Apple Notes database path dynamically to the engine (modifying the `an-export` CLI to accept a `--source` or `--db-dir` directory flag).
- [ ] Typecheck/lint passes.
- [ ] **[Testing]** Write unit tests mocking the child process invocation.

### US-005: Feedback and Progress States
**Description:** As a user, I need to know when my sync is running, if it succeeded, or if it failed, since the app runs in the background.

**Acceptance Criteria:**
- [ ] While a sync is executing, change the Menu Bar icon to a "loading" state and disable the "Sync Now" button.
- [ ] If the sync succeeds, emit a native macOS Notification (`new Notification()`) summarizing the export counts (Exported, Skipped).
- [ ] If the sync fails, emit a native macOS error notification.
- [ ] Reset the Menu Bar state back to idle after completion.
- [ ] Typecheck/lint passes.
- [ ] **[Testing]** Run unit tests mocking sync success/failure scenarios.

## Functional Requirements

- FR-1: The app must start in the background (Menu bar only) and hide the dock icon upon launch.
- FR-2: The app must request folder read access via native macOS UI (`NSOpenPanel`) to bypass global Full Disk Access requirements.
- FR-3: The app must persist directory selections across computer restarts.
- FR-4: The app must bundle the core TypeScript `an-export` engine so it executes using Electron's integrated Node.js runtime instead of requiring an external `bun` installation.
- FR-5: The underlying engine must be updated to accept the explicit Apple Notes database directory path (since the default hardcoded path might miss the security-scoped bookmark context).

## Non-Goals (Out of Scope)

- **Automated / Scheduled Backups:** The initial MVP will only trigger syncs manually via the "Sync Now" button. Cron/LaunchD automation is deferred to v2.
- **Complex GUI Dashboards:** No large windows, electron-renderer dashboards, or complex React state. The UI is strictly the native Menu Bar context menu.
- **Cross-Platform:** macOS exclusively (Apple Notes does not exist natively on Windows/Linux).
- **Public Distribution / Code Signing:** Apple Developer certificates, Notarization, and `.dmg` packaging are explicitly ignored for this personal developer build.

## Technical Considerations

- **Electron's Node Runtime:** Electron ships with its own Node.js binary. The core `an-export` engine currently relies heavily on `bun:sqlite`. We must ensure either:
  1. The core engine is refactored to use `better-sqlite3` (Node compatible).
  2. The electron app ships/downloads the `bun` binary internally as a sidecar process and spawns it using `child_process.spawn`. **Recommendation:** Shipping the Bun binary as a sidecar executable is likely much faster and requires zero rewrites of the core engine.
- **Security-Scoped Bookmarks:** In pure Electron, native macOS `Security-Scoped Bookmarks` aren't exposed directly by the JavaScript API. However, simply using `dialog.showOpenDialog` and keeping the app alive in the background is usually sufficient for standard file access. If the app restarts, we may need to use `electron-store` or an Electron native module like `electron-mac-secure-bookmarks` to persist permissions between total app restarts.

## Success Metrics

- A user can successfully run a data extraction without ever opening System Settings to grant Full Disk Access.
- The app takes less than 50MB of RAM while idling in the menu bar.
- Export speeds remain equivalent to the standalone CLI (no regressions introduced by the GUI wrapper).

## Open Questions

- **Bun vs Node SQLite:** Since `an-export` uses `bun:sqlite` extensively, and Electron uses Node.js, how do we compile the engine? Do we ship the `bun` executable inside the Electron `.app` wrapper, or rewrite the core engine to support `better-sqlite3`? *Tentative Decision: Pack the `bun` binary as an `extraResource` inside the Electron build to avoid touching the core engine's codebase.*

# Kore macOS App

Native Swift + WebView hybrid menu bar app for managing the Kore server.

The app is a thin native shell (Swift/AppKit) hosting a React/TypeScript UI via WKWebView. The Swift layer handles platform integration (NSStatusItem, NSPanel, entitlements) while React handles all visual rendering.

See the full [design document](../../docs/design/macos-app.md) for architecture details.

## Running the app

The app has two parts that must both be built before running:

1. **React UI** — compiled by Vite to `dist/`, loaded by WKWebView at runtime
2. **Swift binary** — the native shell that creates the menu bar icon and panel

```sh
# From apps/macos/ — build the React UI first
bun run build

# From apps/macos/Kore/ — build and launch the Swift app
cd Kore
swift build && .build/debug/Kore
```

A Kore icon appears in your menu bar:

- **Left-click** — toggle the WebView panel
- **Right-click** — context menu with server status, Sync Apple Notes, Trigger Consolidation, Settings, and Quit

The tray icon reflects server state: filled circle (running), empty circle (stopped), ellipsis (starting/stopping), exclamation (error).

> **Current scope (MAC-001 through MAC-004):** The Swift layer includes `ConfigManager` (read/write `config.json`, `.env` parsing), `Permissions` (Notes TCC check, Bun/Ollama detection), `ProcessManager` (process lifecycle, health polling, crash recovery), and `ServerAPIClient` (HTTP client for server API). The React UI in the WebView panel is still a placeholder.

### Do I need to run the server separately?

The app can manage the server as a child process (`ProcessManager.start()`), or it can detect an externally-started server via health-endpoint probing. If you start the server separately, the app will detect it within ~10 seconds:

```sh
# In a separate terminal
bun run start   # from repo root — starts core-api on localhost:3000
```

### KORE_HOME resolution

The app resolves `KORE_HOME` in this order:
1. `KORE_HOME` environment variable (must be **exported**)
2. `KORE_HOME=…` in a `.env` file (walks up from cwd, max 10 levels)
3. Fallback: `~/.kore`

### Iterating on the React UI

For fast UI iteration without rebuilding Swift each time:

```sh
# Terminal 1 — Vite dev server (browser preview at http://localhost:5173)
bun run dev

# Terminal 2 — rebuild dist/ and the native app picks up changes on next open
bun run build
```

The native app always loads from `dist/` (not the dev server), so run `bun run build` whenever you want to see UI changes in the actual panel.

## Structure

```
apps/macos/
├── Kore/                          # Swift project (SPM)
│   ├── Package.swift
│   ├── Sources/
│   │   ├── KoreLib/               # Shared library target (testable)
│   │   │   ├── BridgeHandler.swift    # JS ↔ Swift bridge (WKScriptMessageHandler)
│   │   │   ├── ConfigManager.swift    # KoreConfig Codable struct + read/write + .env parsing
│   │   │   ├── ServerAPIClient.swift  # HTTP client for server API (sync, consolidate, health)
│   │   │   ├── ProcessManager.swift    # Server lifecycle actor (start/stop, health poll, crash recovery)
│   │   │   ├── PanelManager.swift     # NSPanel + WKWebView setup, positioning
│   │   │   └── Permissions.swift      # Notes TCC check, Bun/Ollama detection
│   │   └── Kore/                  # Executable entry point (imports KoreLib)
│   │       ├── KoreApp.swift          # @main, NSStatusItem, tray menu, server callbacks
│   │       └── Resources/
│   │           ├── Info.plist         # Bundle config, Apple Notes usage description
│   │           └── Kore.entitlements  # File access, bookmarks, JIT permissions
│   └── Tests/KoreTests/
│       ├── ConfigManagerTests.swift   # Unit tests for ConfigManager + .env parsing
│       ├── ServerAPIClientTests.swift # Unit + integration tests for ServerAPIClient
│       └── ProcessManagerTests.swift   # Unit tests for ProcessManager lifecycle
├── src/                           # React/TypeScript UI
│   ├── App.tsx                    # Panel UI component
│   ├── main.tsx                   # React entry point
│   └── styles.css                 # Panel styling
├── index.html                     # Vite entry HTML
├── vite.config.ts                 # Builds to dist/ with relative paths for file:// loading
├── package.json                   # @kore/macos workspace package
└── tsconfig.json                  # TypeScript config (JSX enabled)
```

## Testing

```sh
# Swift unit tests (ConfigManager, ProcessManager, ServerAPIClient)
cd apps/macos/Kore && swift test

# TypeScript tests are run from repo root
bun test apps/core-api/src/config.test.ts
```

Integration tests in `ServerAPIClientTests.swift` require a running Kore server on port 3000 — they auto-skip via `XCTSkipUnless` when the server is unreachable.

## Prerequisites

- macOS 13+
- Bun (for the React UI)
- Xcode Command Line Tools: `xcode-select --install`

## Key Design Decisions

- **NSPanel** (not NSWindow) — required for appearing over fullscreen apps and on all Spaces
- **WKWebView** — same rendering engine Tauri uses internally, but with full control over the native layer
- **`base: "./"` in Vite** — ensures assets resolve correctly when loaded via `file://` in WKWebView
- **`LSUIElement = true`** — menu bar only, no Dock icon
- **JS bridge** — `window.webkit.messageHandlers.bridge.postMessage()` for JS→Swift, `window.bridgeCallback()` for Swift→JS

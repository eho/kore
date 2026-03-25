# Kore macOS App

Native Swift + WebView hybrid menu bar app for managing the Kore daemon.

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

A Kore icon appears in your menu bar. Left-click to open the panel, right-click for "Quit Kore".

> **Current scope (MAC-001 + MAC-002):** The panel shows a placeholder UI with a bridge test button. The Swift layer includes `ConfigManager` (read/write `config.json`) and `Permissions` (Notes TCC check, Bun/Ollama detection) — all callable from the React UI via the JS bridge. Daemon management (starting/stopping `bun run start`) is implemented in MAC-003.

### Do I need to run the daemon separately?

Not for this POC. In the final app the Swift shell will start/stop the daemon automatically as a child process. For now, if you want the daemon running alongside, start it separately:

```sh
# In a separate terminal
bun run start   # from repo root — starts core-api on localhost:3000
```

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
│   │   │   ├── ConfigManager.swift    # KoreConfig Codable struct + read/write helpers
│   │   │   ├── PanelManager.swift     # NSPanel + WKWebView setup, positioning
│   │   │   └── Permissions.swift      # Notes TCC check, Bun/Ollama detection
│   │   └── Kore/                  # Executable entry point (imports KoreLib)
│   │       ├── KoreApp.swift          # @main, NSStatusItem, click handling
│   │       └── Resources/
│   │           ├── Info.plist         # Bundle config, Apple Notes usage description
│   │           └── Kore.entitlements  # File access, bookmarks, JIT permissions
│   └── Tests/KoreTests/
│       └── ConfigManagerTests.swift   # Unit tests for ConfigManager
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
# Swift unit tests (ConfigManager)
cd Kore && swift test

# TypeScript tests are run from repo root
bun test apps/core-api/src/config.test.ts
```

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

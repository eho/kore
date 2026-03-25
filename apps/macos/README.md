# Kore macOS App

Native Swift + WebView hybrid menu bar app for managing the Kore daemon.

The app is a thin native shell (Swift/AppKit) hosting a React/TypeScript UI via WKWebView. The Swift layer handles platform integration (NSStatusItem, NSPanel, entitlements) while React handles all visual rendering.

See the full [design document](../../docs/design/macos-app.md) for architecture details.

## Structure

```
apps/macos/
├── Kore/                          # Swift project (SPM)
│   ├── Package.swift
│   └── Sources/Kore/
│       ├── KoreApp.swift          # Entry point, NSStatusItem, click handling
│       ├── PanelManager.swift     # NSPanel + WKWebView setup, positioning
│       ├── BridgeHandler.swift    # JS ↔ Swift bridge (WKScriptMessageHandler)
│       └── Resources/
│           ├── Info.plist         # Bundle config, Apple Notes usage description
│           └── Kore.entitlements  # File access, bookmarks, JIT permissions
├── src/                           # React/TypeScript UI
│   ├── App.tsx                    # Panel UI component
│   ├── main.tsx                   # React entry point
│   └── styles.css                 # Panel styling
├── index.html                     # Vite entry HTML
├── vite.config.ts                 # Builds to dist/ with relative paths for file:// loading
├── package.json                   # @kore/macos workspace package
└── tsconfig.json                  # TypeScript config (JSX enabled)
```

## Prerequisites

- macOS 13+
- Bun (for building the React UI)
- Xcode Command Line Tools (for `swift build`)

## Build

**React UI:**

```sh
bun install        # from repo root
bun run build      # from apps/macos/ — produces dist/
```

**Swift app:**

```sh
cd apps/macos/Kore
swift build
```

The compiled binary is at `Kore/.build/debug/Kore`. Run it directly to launch the menu bar app.

## Development

Run `bun run dev` from `apps/macos/` for Vite dev server with HMR (useful for iterating on the React UI in a browser). The Swift app loads `dist/index.html` from the file system, so run `bun run build` before testing the full native flow.

## Key Design Decisions

- **NSPanel** (not NSWindow) — required for appearing over fullscreen apps and on all Spaces
- **WKWebView** — same rendering engine Tauri uses internally, but with full control over the native layer
- **`base: "./"` in Vite** — ensures assets resolve correctly when loaded via `file://` in WKWebView
- **`LSUIElement = true`** — app runs as menu bar only (no Dock icon)
- **JS bridge** — `window.webkit.messageHandlers.bridge.postMessage()` for JS→Swift, `window.bridgeCallback()` for Swift→JS

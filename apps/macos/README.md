# Kore macOS App

A Tauri v2 menu bar app that manages the Kore daemon and provides a native settings UI.

## Prerequisites

- [Rust](https://rustup.rs/) (1.70+) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- [Bun](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- Xcode Command Line Tools — `xcode-select --install`

## Development

```bash
# From repo root — install all JS dependencies
bun install

# Start the Tauri dev server (hot-reloads both Rust and React)
cd apps/macos
bunx tauri dev
```

This opens the panel window in a regular window frame for easier debugging. The tray icon also appears in your menu bar.

## Build

```bash
# Compile the Rust crate only (no frontend)
cd apps/macos/src-tauri
cargo build

# Full app bundle (.app)
cd apps/macos
bunx tauri build
```

The bundled `.app` is written to `src-tauri/target/release/bundle/macos/Kore.app`.

## Lint & Typecheck

```bash
# Rust
cd apps/macos/src-tauri
cargo clippy

# TypeScript
cd apps/macos
bunx tsc --noEmit
```

## How it works

- The app runs as a **menu bar-only** process (no Dock icon).
- Clicking the tray icon toggles a small panel window, positioned below the icon via `tauri-plugin-positioner`.
- Right-clicking the tray icon shows a menu with **Quit Kore**.
- The panel calls Rust IPC commands via `invoke()` — currently a placeholder `get_daemon_status` command (full daemon management lands in MAC-003).

## Project structure

```
apps/macos/
├── index.html              # Vite entry point
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx            # React root
│   ├── App.tsx             # Panel UI
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml          # tauri v2, tauri-plugin-positioner
    ├── tauri.conf.json     # App config (identifier, window, tray)
    ├── Info.plist          # NSAppleEventsUsageDescription
    ├── entitlements/
    │   └── Kore.entitlements
    ├── icons/              # App + tray icons
    └── src/
        ├── main.rs         # Binary entry point
        ├── lib.rs          # Tauri setup, IPC commands
        └── tray.rs         # Tray icon + positioner logic
```

## Design doc

See [`docs/design/macos-app.md`](../../docs/design/macos-app.md) for the full design, goals, and phased roadmap.

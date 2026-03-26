import AppKit
import Foundation
import KoreLib

@main
struct KoreApp {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // Menu bar only, no Dock icon

        let delegate = AppDelegate()
        app.delegate = delegate

        app.run()
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?
    var panelManager: PanelManager?
    var settingsWindowManager: SettingsWindowManager?
    var onboardingWindowManager: OnboardingWindowManager?
    var daemonManager: DaemonManager?

    private let koreHome: String = ConfigManager.resolveKoreHome()

    // State tracking — main-thread only
    private var currentState: DaemonState = .stopped
    private var lastSyncTime: Date?
    private var daemonPort: Int = 3000

    // Retained menu items for in-place text updates
    private var menuDaemonStatusItem: NSMenuItem?
    private var menuSyncTimeItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Seed port from config so the menu shows the right value immediately.
        let config = (try? ConfigManager.readConfig(koreHome: koreHome)) ?? .defaults
        daemonPort = config.port ?? 3000
        // No lastLaunchAt means the app has never completed setup — show onboarding.
        // To re-trigger onboarding, remove the lastLaunchAt field from config.json.
        let isFirstLaunch = config.lastLaunchAt == nil
        print("[Kore] Starting — home=\(koreHome) port=\(daemonPort) firstLaunch=\(isFirstLaunch)")

        let dm = DaemonManager(koreHome: koreHome)
        daemonManager = dm

        if isFirstLaunch {
            // Show onboarding instead of starting daemon — daemon will start
            // when the user completes the setup wizard.
            setupStatusItem()
            onboardingWindowManager = OnboardingWindowManager(
                daemonManager: dm,
                onComplete: { [weak self] in
                    self?.onboardingWindowManager = nil
                    self?.startNormalMode(dm: dm)
                }
            )
            onboardingWindowManager?.showWindow()
        } else {
            startNormalMode(dm: dm)
        }
    }

    /// Initializes daemon callbacks, probes for a running daemon, and sets up UI managers.
    /// Called directly on normal launch, or after onboarding completes on first launch.
    private func startNormalMode(dm: DaemonManager) {
        // Re-read config in case onboarding just wrote it, and stamp lastLaunchAt
        if var freshConfig = try? ConfigManager.readConfig(koreHome: koreHome) {
            daemonPort = freshConfig.port ?? 3000
            let formatter = ISO8601DateFormatter()
            freshConfig.lastLaunchAt = formatter.string(from: Date())
            try? ConfigManager.writeConfig(koreHome: koreHome, config: freshConfig)
        }

        // Register callbacks, then adopt any orphaned daemon process — ordering matters
        // so no state transitions are missed.
        Task {
            await dm.setStateChangeCallback { [weak self] state in
                // Already dispatched to main queue by DaemonManager.
                self?.handleDaemonStateChange(state)
            }
            await dm.setHealthPollCallback { [weak self] info in
                // Already dispatched to main queue by DaemonManager.
                self?.handleHealthPoll(info)
            }
            // Try PID-file adoption first; if that finds nothing, probe the
            // health endpoint so a daemon started outside the app is detected.
            await dm.adoptOrphanedProcess()
            await dm.probeForRunningDaemon(port: daemonPort)
        }

        if statusItem == nil {
            setupStatusItem()
        }
        panelManager = PanelManager(daemonManager: dm)
        settingsWindowManager = SettingsWindowManager(daemonManager: dm)
    }

    func applicationWillTerminate(_ notification: Notification) {
        daemonManager?.terminateSync()
        panelManager = nil
    }

    // MARK: - State Handling

    private func handleDaemonStateChange(_ state: DaemonState) {
        currentState = state
        print("[Kore] Daemon state → \(state.statusKey)\(state.errorMessage.map { ": \($0.prefix(80))" } ?? "")")
        updateTrayIcon(for: state)
        // Update any open menu's status row if available.
        updateMenuStatusItems()
    }

    private func handleHealthPoll(_ info: DaemonHealthInfo) {
        daemonPort = info.port
        updateMenuStatusItems()
    }

    // MARK: - Tray Icon

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        guard let button = statusItem?.button else { return }
        button.toolTip = "Kore"
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.target = self

        updateTrayIcon(for: currentState)
    }

    private func updateTrayIcon(for state: DaemonState) {
        guard let button = statusItem?.button else { return }
        if let image = NSImage(systemSymbolName: state.symbolName, accessibilityDescription: "Kore") {
            image.isTemplate = true
            button.image = image
        } else {
            button.title = "K"
        }
    }

    // MARK: - Context Menu (right-click)

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        // ── Status section ──────────────────────────────────────────
        let daemonItem = NSMenuItem(title: daemonStatusLine(), action: nil, keyEquivalent: "")
        daemonItem.isEnabled = false
        menu.addItem(daemonItem)
        menuDaemonStatusItem = daemonItem

        let syncItem = NSMenuItem(title: lastSyncLine(), action: nil, keyEquivalent: "")
        syncItem.isEnabled = false
        menu.addItem(syncItem)
        menuSyncTimeItem = syncItem

        menu.addItem(.separator())

        // ── Actions ─────────────────────────────────────────────────
        let syncNotesItem = NSMenuItem(
            title: "Sync Apple Notes Now",
            action: #selector(syncAppleNotes),
            keyEquivalent: ""
        )
        syncNotesItem.target = self
        menu.addItem(syncNotesItem)

        let consolidateItem = NSMenuItem(
            title: "Trigger Consolidation",
            action: #selector(triggerConsolidation),
            keyEquivalent: ""
        )
        consolidateItem.target = self
        menu.addItem(consolidateItem)

        menu.addItem(.separator())

        // ── Settings ────────────────────────────────────────────────
        let settingsItem = NSMenuItem(
            title: "Settings\u{2026}",
            action: #selector(openSettings),
            keyEquivalent: ","
        )
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        // ── Quit ────────────────────────────────────────────────────
        let quitItem = NSMenuItem(
            title: "Quit Kore",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)

        return menu
    }

    private func daemonStatusLine() -> String {
        let label: String
        switch currentState {
        case .running:           label = "running"
        case .stopped:           label = "stopped"
        case .starting:          label = "starting"
        case .stopping:          label = "stopping"
        case .error(let msg):    label = "error: \(msg.prefix(40))"
        }
        return "Daemon: \(label) on :\(daemonPort)"
    }

    private func lastSyncLine() -> String {
        guard let date = lastSyncTime else {
            return "Last sync: Never"
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "Last sync: \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    /// Refreshes the text of the two status rows while the menu is open.
    private func updateMenuStatusItems() {
        menuDaemonStatusItem?.title = daemonStatusLine()
        menuSyncTimeItem?.title = lastSyncLine()
    }

    @objc private func handleStatusItemClick(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp {
            showContextMenu()
        } else {
            togglePanel()
        }
    }

    private func showContextMenu() {
        let menu = buildMenu()
        statusItem?.menu = menu
        statusItem?.button?.performClick(nil)
        DispatchQueue.main.async { [weak self] in
            self?.statusItem?.menu = nil
            // Clear retained menu item refs so they don't outlive the menu.
            self?.menuDaemonStatusItem = nil
            self?.menuSyncTimeItem = nil
        }
    }

    // MARK: - Menu Actions

    @objc private func syncAppleNotes() {
        guard case .running = currentState else {
            print("[Kore] Sync skipped — daemon not running")
            return
        }
        Task {
            let client = DaemonAPIClient.fromConfig(koreHome: koreHome)
            print("[Kore] Triggering Apple Notes sync on :\(client.port)…")
            let result = await client.syncAppleNotes()
            print("[Kore] Sync result: \(result)")
            if case .success = result {
                DispatchQueue.main.async { [weak self] in
                    self?.lastSyncTime = Date()
                    self?.updateMenuStatusItems()
                }
            }
        }
    }

    @objc private func triggerConsolidation() {
        guard case .running = currentState else {
            print("[Kore] Consolidation skipped — daemon not running")
            return
        }
        Task {
            let client = DaemonAPIClient.fromConfig(koreHome: koreHome)
            print("[Kore] Triggering consolidation on :\(client.port)…")
            let result = await client.triggerConsolidation()
            print("[Kore] Consolidation result: \(result)")
        }
    }

    @objc private func openSettings() {
        settingsWindowManager?.showWindow()
    }

    @objc private func quitApp() {
        // applicationWillTerminate calls terminateSync() for clean daemon shutdown.
        NSApp.terminate(nil)
    }

    // MARK: - Panel Toggle (left-click)

    private func togglePanel() {
        guard let panelManager = panelManager else { return }

        if panelManager.isVisible {
            panelManager.hidePanel()
        } else {
            guard let button = statusItem?.button else { return }
            panelManager.showPanel(relativeTo: button)
        }
    }
}

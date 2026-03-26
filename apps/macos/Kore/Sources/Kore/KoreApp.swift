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
    var processManager: ProcessManager?

    private let koreHome: String = ConfigManager.resolveKoreHome()

    // State tracking — main-thread only
    private var currentState: ServerState = .stopped
    private var currentOwnership: ProcessOwnership = .none
    private var lastSyncTime: Date?
    private var serverPort: Int = 3000

    // Retained menu items for in-place text updates
    private var menuServerStatusItem: NSMenuItem?
    private var menuSyncTimeItem: NSMenuItem?
    private var menuStartItem: NSMenuItem?
    private var menuStopItem: NSMenuItem?
    private var menuRestartItem: NSMenuItem?
    private var menuSyncNotesItem: NSMenuItem?
    private var menuConsolidateItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Seed port from config so the menu shows the right value immediately.
        let config = (try? ConfigManager.readConfig(koreHome: koreHome)) ?? .defaults
        serverPort = config.port ?? 3000
        // No lastLaunchAt means the app has never completed setup — show onboarding.
        // To re-trigger onboarding, remove the lastLaunchAt field from config.json.
        let isFirstLaunch = config.lastLaunchAt == nil
        print("[Kore] Starting — home=\(koreHome) port=\(serverPort) firstLaunch=\(isFirstLaunch)")

        let dm = ProcessManager(koreHome: koreHome)
        processManager = dm

        if isFirstLaunch {
            // Show onboarding instead of starting daemon — daemon will start
            // when the user completes the setup wizard.
            setupStatusItem()
            onboardingWindowManager = OnboardingWindowManager(
                processManager: dm,
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

    /// Initializes daemon callbacks, probes for a running server, and sets up UI managers.
    /// Called directly on normal launch, or after onboarding completes on first launch.
    private func startNormalMode(dm: ProcessManager) {
        // Re-read config in case onboarding just wrote it
        if var freshConfig = try? ConfigManager.readConfig(koreHome: koreHome) {
            serverPort = freshConfig.port ?? 3000
            // Stamp lastLaunchAt only if already set (normal launch) or freshly written
            // by onboarding. If the user cancelled onboarding, lastLaunchAt is still nil
            // and we leave it that way so onboarding shows again next time.
            if freshConfig.lastLaunchAt != nil {
                let formatter = ISO8601DateFormatter()
                freshConfig.lastLaunchAt = formatter.string(from: Date())
                try? ConfigManager.writeConfig(koreHome: koreHome, config: freshConfig)
            }
        }

        // Register callbacks, then adopt any orphaned server process — ordering matters
        // so no state transitions are missed.
        Task {
            await dm.setStateChangeCallback { [weak self] state in
                // Already dispatched to main queue by ProcessManager.
                self?.handleServerStateChange(state)
            }
            await dm.setHealthPollCallback { [weak self] info in
                // Already dispatched to main queue by ProcessManager.
                self?.handleHealthPoll(info)
            }
            await dm.setOwnershipChangeCallback { [weak self] ownership in
                // Already dispatched to main queue by ProcessManager.
                self?.handleOwnershipChange(ownership)
            }
            // Sync tray immediately with whatever state the server is already in
            // (e.g. already adopted/running from the onboarding path).
            let currentState = await dm.serverStatus()
            let currentOwnership = await dm.ownership
            DispatchQueue.main.async { [weak self] in
                self?.handleOwnershipChange(currentOwnership)
                self?.handleServerStateChange(currentState)
            }
            // Try PID-file adoption first; if that finds nothing, probe the
            // health endpoint so a server started outside the app is detected.
            await dm.adoptOrphanedProcess(port: serverPort)
            await dm.probeForRunningServer(port: serverPort)

            // Auto-start: if still stopped after adoption/probe and the app has
            // been set up before (lastLaunchAt is set), start the server automatically.
            let stateAfterProbe = await dm.serverStatus()
            if stateAfterProbe == .stopped {
                let home = koreHome
                let config = (try? ConfigManager.readConfig(koreHome: home)) ?? .defaults
                if config.lastLaunchAt != nil {
                    guard let clonePath = config.clonePath, !clonePath.isEmpty else {
                        print("[Kore] Skipping auto-start — no clone path configured")
                        return
                    }
                    let port = config.port ?? 3000
                    print("[Kore] Auto-starting server at \(clonePath) on :\(port)")
                    await dm.startServer(clonePath: clonePath, port: port)
                }
            }
        }

        if statusItem == nil {
            setupStatusItem()
        }
        panelManager = PanelManager(processManager: dm)
        settingsWindowManager = SettingsWindowManager(processManager: dm)
    }

    func applicationWillTerminate(_ notification: Notification) {
        processManager?.terminateSync()
        panelManager = nil
    }

    // MARK: - State Handling

    private func handleServerStateChange(_ state: ServerState) {
        currentState = state
        print("[Kore] Server state → \(state.statusKey)\(state.errorMessage.map { ": \($0.prefix(80))" } ?? "")")
        updateTrayIcon(for: state)
        // Update any open menu's status row if available.
        updateMenuStatusItems()
    }

    private func handleOwnershipChange(_ ownership: ProcessOwnership) {
        currentOwnership = ownership
        updateMenuStatusItems()
    }

    private func handleHealthPoll(_ info: ServerHealthInfo) {
        serverPort = info.port
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

    private func updateTrayIcon(for state: ServerState) {
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

        let isRunning = currentState == .running
        let isManaged = currentOwnership == .spawned || currentOwnership == .adopted
        let canStart = currentState == .stopped || currentState.errorMessage != nil

        // ── Status section ──────────────────────────────────────────
        let statusItem2 = NSMenuItem(title: serverStatusLine(), action: nil, keyEquivalent: "")
        statusItem2.isEnabled = false
        menu.addItem(statusItem2)
        menuServerStatusItem = statusItem2

        let syncItem = NSMenuItem(title: lastSyncLine(), action: nil, keyEquivalent: "")
        syncItem.isEnabled = false
        menu.addItem(syncItem)
        menuSyncTimeItem = syncItem

        menu.addItem(.separator())

        // ── Lifecycle controls ──────────────────────────────────────
        if canStart {
            let startItem = NSMenuItem(
                title: "Start Kore",
                action: #selector(startServer),
                keyEquivalent: ""
            )
            startItem.target = self
            menu.addItem(startItem)
            menuStartItem = startItem
        }

        if isRunning && isManaged {
            let stopItem = NSMenuItem(
                title: "Stop Kore",
                action: #selector(stopServer),
                keyEquivalent: ""
            )
            stopItem.target = self
            menu.addItem(stopItem)
            menuStopItem = stopItem

            let restartItem = NSMenuItem(
                title: "Restart Kore",
                action: #selector(restartServer),
                keyEquivalent: ""
            )
            restartItem.target = self
            menu.addItem(restartItem)
            menuRestartItem = restartItem
        }

        menu.addItem(.separator())

        // ── Actions ─────────────────────────────────────────────────
        let syncNotesItem = NSMenuItem(
            title: "Sync Apple Notes Now",
            action: isRunning ? #selector(syncAppleNotes) : nil,
            keyEquivalent: ""
        )
        syncNotesItem.target = self
        menu.addItem(syncNotesItem)
        menuSyncNotesItem = syncNotesItem

        let consolidateItem = NSMenuItem(
            title: "Trigger Consolidation",
            action: isRunning ? #selector(triggerConsolidation) : nil,
            keyEquivalent: ""
        )
        consolidateItem.target = self
        menu.addItem(consolidateItem)
        menuConsolidateItem = consolidateItem

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

    private func serverStatusLine() -> String {
        switch currentState {
        case .running where currentOwnership == .observed:
            return "Kore: running on :\(serverPort) (external)"
        case .running:
            return "Kore: running on :\(serverPort)"
        case .starting:
            return "Kore: starting on :\(serverPort)"
        case .stopping:
            return "Kore: stopping"
        case .error(let msg):
            return "Kore: error — \(msg.prefix(40))"
        case .stopped:
            return "Kore: not running"
        }
    }

    private func lastSyncLine() -> String {
        guard let date = lastSyncTime else {
            return "Last sync: Never"
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "Last sync: \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    /// Refreshes status rows and lifecycle item visibility while the menu is open.
    private func updateMenuStatusItems() {
        menuServerStatusItem?.title = serverStatusLine()
        menuSyncTimeItem?.title = lastSyncLine()

        let isRunning = currentState == .running
        let isManaged = currentOwnership == .spawned || currentOwnership == .adopted
        let canStart = currentState == .stopped || currentState.errorMessage != nil

        menuStartItem?.isHidden = !canStart
        menuStopItem?.isHidden = !(isRunning && isManaged)
        menuRestartItem?.isHidden = !(isRunning && isManaged)

        // Disable sync/consolidation when server is not running
        menuSyncNotesItem?.action = isRunning ? #selector(syncAppleNotes) : nil
        menuConsolidateItem?.action = isRunning ? #selector(triggerConsolidation) : nil
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
            self?.menuServerStatusItem = nil
            self?.menuSyncTimeItem = nil
            self?.menuStartItem = nil
            self?.menuStopItem = nil
            self?.menuRestartItem = nil
            self?.menuSyncNotesItem = nil
            self?.menuConsolidateItem = nil
        }
    }

    // MARK: - Lifecycle Actions

    @objc private func startServer() {
        let config = (try? ConfigManager.readConfig(koreHome: koreHome)) ?? .defaults
        guard let clonePath = config.clonePath, !clonePath.isEmpty else {
            print("[Kore] Cannot start — no clone path configured. Open Settings to set it.")
            return
        }
        let port = config.port ?? 3000
        Task {
            await processManager?.startServer(clonePath: clonePath, port: port)
        }
    }

    @objc private func stopServer() {
        Task {
            await processManager?.stopServer()
        }
    }

    @objc private func restartServer() {
        Task {
            await processManager?.restartServer()
        }
    }

    // MARK: - Menu Actions

    @objc private func syncAppleNotes() {
        guard case .running = currentState else {
            print("[Kore] Sync skipped — server not running")
            return
        }
        Task {
            let client = ServerAPIClient.fromConfig(koreHome: koreHome)
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
            print("[Kore] Consolidation skipped — server not running")
            return
        }
        Task {
            let client = ServerAPIClient.fromConfig(koreHome: koreHome)
            print("[Kore] Triggering consolidation on :\(client.port)…")
            let result = await client.triggerConsolidation()
            print("[Kore] Consolidation result: \(result)")
        }
    }

    @objc private func openSettings() {
        settingsWindowManager?.showWindow()
    }

    @objc private func quitApp() {
        // applicationWillTerminate calls terminateSync() for clean server shutdown.
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

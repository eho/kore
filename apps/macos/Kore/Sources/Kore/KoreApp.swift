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
    var daemonManager: DaemonManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let koreHome = ProcessInfo.processInfo.environment["KORE_HOME"] ?? "~/.kore"
        let dm = DaemonManager(koreHome: koreHome)
        daemonManager = dm

        // Adopt any daemon process left over from a previous session.
        Task { await dm.adoptOrphanedProcess() }

        setupStatusItem()
        panelManager = PanelManager(daemonManager: dm)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Stop the daemon synchronously before the process exits.
        daemonManager?.terminateSync()
        panelManager = nil
    }

    // MARK: - Menu Bar Icon

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        guard let button = statusItem?.button else { return }

        if let image = NSImage(systemSymbolName: "brain", accessibilityDescription: "Kore") {
            image.isTemplate = true
            button.image = image
        } else {
            button.title = "K"
        }

        button.toolTip = "Kore"
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.target = self
    }

    @objc private func handleStatusItemClick(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp {
            showContextMenu()
        } else {
            togglePanel()
        }
    }

    // MARK: - Context Menu (right-click)

    private func showContextMenu() {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Quit Kore", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem?.menu = menu
        statusItem?.button?.performClick(nil)
        DispatchQueue.main.async { [weak self] in
            self?.statusItem?.menu = nil
        }
    }

    @objc private func quitApp() {
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

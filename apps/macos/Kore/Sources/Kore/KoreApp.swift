import AppKit
import Foundation

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

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        panelManager = PanelManager()
    }

    func applicationWillTerminate(_ notification: Notification) {
        panelManager = nil
    }

    // MARK: - Menu Bar Icon

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        guard let button = statusItem?.button else { return }

        // Use a system symbol as a template image (scales correctly in menu bar)
        if let image = NSImage(systemSymbolName: "brain", accessibilityDescription: "Kore") {
            image.isTemplate = true // Renders correctly in light/dark mode
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
        // Reset menu so left-click doesn't open it next time
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
            if let button = statusItem?.button {
                panelManager.showPanel(relativeTo: button)
            }
        }
    }
}

import AppKit
import WebKit

/// Manages a standard NSWindow containing a WKWebView for the Settings UI.
///
/// Unlike PanelManager (borderless dropdown), this uses a titled, resizable window
/// that behaves like a standard macOS preferences window.
public class SettingsWindowManager: NSObject {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var bridgeHandler: BridgeHandler?

    public var isVisible: Bool {
        window?.isVisible ?? false
    }

    /// Creates the settings window manager and wires up the optional daemon manager to the bridge.
    public init(daemonManager: DaemonManager? = nil) {
        super.init()
        setupWindow()
        bridgeHandler?.daemonManager = daemonManager
    }

    // MARK: - Window Setup

    private func setupWindow() {
        let windowWidth: CGFloat = 640
        let windowHeight: CGFloat = 480

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Kore Settings"
        window.minSize = NSSize(width: 520, height: 400)
        window.isReleasedWhenClosed = false
        window.center()

        // Setup WKWebView with bridge
        let bridgeHandler = BridgeHandler()
        self.bridgeHandler = bridgeHandler

        let userContentController = WKUserContentController()
        userContentController.add(bridgeHandler, name: "bridge")

        let config = WKWebViewConfiguration()
        config.userContentController = userContentController
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        bridgeHandler.webView = webView

        window.contentView = webView
        window.delegate = self

        self.webView = webView
        self.window = window

        loadSettingsContent()
    }

    // MARK: - Web Content Loading

    private func loadSettingsContent() {
        // Look for settings.html in the main app bundle's Resources (packaged .app)
        if let bundleURL = Bundle.main.url(forResource: "settings", withExtension: "html") {
            webView?.loadFileURL(bundleURL, allowingReadAccessTo: bundleURL.deletingLastPathComponent())
            return
        }

        // Fallback: load dist/settings.html relative to the Swift package root (for development).
        // #file is Sources/KoreLib/SettingsWindowManager.swift; 4x up = apps/macos/
        let distURL = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()  // Sources/KoreLib/
            .deletingLastPathComponent()  // Sources/
            .deletingLastPathComponent()  // Kore/
            .deletingLastPathComponent()  // apps/macos/
            .appendingPathComponent("dist/settings.html")

        if FileManager.default.fileExists(atPath: distURL.path) {
            webView?.loadFileURL(distURL, allowingReadAccessTo: distURL.deletingLastPathComponent())
            return
        }

        // Final fallback: inline placeholder
        let html = """
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><style>
        body { font-family: -apple-system; background: #1c1c1e; color: #fff;
               display: flex; align-items: center; justify-content: center; height: 100vh; }
        </style></head>
        <body><p>Settings UI not found. Run <code>bun run build</code>.</p></body>
        </html>
        """
        webView?.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Show / Hide

    public func showWindow() {
        guard let window = window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func close() {
        window?.close()
    }
}

// MARK: - NSWindowDelegate

extension SettingsWindowManager: NSWindowDelegate {
    public func windowWillClose(_ notification: Notification) {
        // Window stays allocated (isReleasedWhenClosed = false) so it can be re-opened.
    }
}

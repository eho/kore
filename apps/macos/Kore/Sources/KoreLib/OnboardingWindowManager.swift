import AppKit
import WebKit

/// Manages the onboarding window shown on first launch (when config.json is absent).
///
/// Similar to SettingsWindowManager but loads the onboarding HTML page.
public class OnboardingWindowManager: NSObject {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var bridgeHandler: BridgeHandler?
    private var onComplete: (() -> Void)?

    public var isVisible: Bool {
        window?.isVisible ?? false
    }

    /// Creates the onboarding window manager.
    ///
    /// - Parameters:
    ///   - processManager: Optional daemon manager for bridge calls.
    ///   - onComplete: Called when the onboarding window is closed, signaling the app
    ///                 should transition to normal menu bar mode.
    public init(processManager: ProcessManager? = nil, onComplete: (() -> Void)? = nil) {
        self.onComplete = onComplete
        super.init()
        setupWindow()
        bridgeHandler?.processManager = processManager
    }

    // MARK: - Window Setup

    private func setupWindow() {
        let windowWidth: CGFloat = 680
        let windowHeight: CGFloat = 520

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Kore Setup"
        window.minSize = NSSize(width: 580, height: 440)
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

        loadOnboardingContent()
    }

    // MARK: - Web Content Loading

    private func loadOnboardingContent() {
        // Look for onboarding.html in the main app bundle's Resources (packaged .app)
        if let bundleURL = Bundle.main.url(forResource: "onboarding", withExtension: "html") {
            webView?.loadFileURL(bundleURL, allowingReadAccessTo: bundleURL.deletingLastPathComponent())
            return
        }

        // Fallback: load dist/onboarding.html relative to the Swift package root (for development).
        let distURL = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()  // Sources/KoreLib/
            .deletingLastPathComponent()  // Sources/
            .deletingLastPathComponent()  // Kore/
            .deletingLastPathComponent()  // apps/macos/
            .appendingPathComponent("dist/onboarding.html")

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
        <body><p>Onboarding UI not found. Run <code>bun run build</code>.</p></body>
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

extension OnboardingWindowManager: NSWindowDelegate {
    public func windowWillClose(_ notification: Notification) {
        onComplete?()
    }
}

import AppKit
import WebKit

class PanelManager: NSObject {
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var bridgeHandler: BridgeHandler?

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    override init() {
        super.init()
        setupPanel()
    }

    // MARK: - Panel Setup

    private func setupPanel() {
        let panelWidth: CGFloat = 380
        let panelHeight: CGFloat = 480

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )

        // Required for appearing over fullscreen apps and on all spaces
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.level = .statusBar
        panel.hasShadow = true
        panel.isOpaque = false
        panel.backgroundColor = .clear

        // Auto-hide when focus is lost
        panel.hidesOnDeactivate = true
        panel.becomesKeyOnlyIfNeeded = true

        // Setup WKWebView
        let bridgeHandler = BridgeHandler()
        self.bridgeHandler = bridgeHandler

        let userContentController = WKUserContentController()
        userContentController.add(bridgeHandler, name: "bridge")

        let config = WKWebViewConfiguration()
        config.userContentController = userContentController

        // Allow localhost connections for daemon API calls
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        // Store reference so BridgeHandler can call back into JS
        bridgeHandler.webView = webView

        panel.contentView = webView
        panel.delegate = self

        self.webView = webView
        self.panel = panel

        loadWebContent()
    }

    // MARK: - Web Content Loading

    private func loadWebContent() {
        // Look for index.html in the app bundle's Resources
        if let bundleURL = Bundle.module.url(forResource: "Resources/index", withExtension: "html") {
            webView?.loadFileURL(bundleURL, allowingReadAccessTo: bundleURL.deletingLastPathComponent())
            return
        }

        // Fallback: load dist/index.html relative to the Swift package root (for development).
        // #file is Sources/Kore/PanelManager.swift; 3× up = apps/macos/Kore/; 1× ../  = apps/macos/
        let devPaths = [
            URL(fileURLWithPath: #file)
                .deletingLastPathComponent()  // Sources/Kore/
                .deletingLastPathComponent()  // Sources/
                .deletingLastPathComponent()  // Kore/
                .deletingLastPathComponent()  // apps/macos/  (one more needed)
                .appendingPathComponent("dist/index.html"),
        ]

        for devURL in devPaths {
            if FileManager.default.fileExists(atPath: devURL.path) {
                webView?.loadFileURL(devURL, allowingReadAccessTo: devURL.deletingLastPathComponent())
                return
            }
        }

        // Final fallback: inline placeholder HTML
        let placeholderHTML = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                    background: rgba(30, 30, 30, 0.95);
                    color: #fff;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    border-radius: 12px;
                }
                h1 { font-size: 24px; margin-bottom: 8px; }
                p { font-size: 14px; color: #aaa; margin-bottom: 24px; }
                button {
                    padding: 8px 16px;
                    background: #0071e3;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 14px;
                    cursor: pointer;
                }
                button:hover { background: #0077ed; }
                #response { margin-top: 12px; font-size: 12px; color: #4CAF50; }
            </style>
        </head>
        <body>
            <h1>Kore</h1>
            <p>Menu bar app running</p>
            <button onclick="ping()">Test Bridge (ping)</button>
            <div id="response"></div>
            <script>
                window.bridgeCallback = function(data) {
                    document.getElementById('response').textContent = 'Bridge response: ' + JSON.stringify(data);
                };
                function ping() {
                    window.webkit.messageHandlers.bridge.postMessage({ type: 'ping' });
                }
            </script>
        </body>
        </html>
        """
        webView?.loadHTMLString(placeholderHTML, baseURL: nil)
    }

    // MARK: - Show / Hide

    func showPanel(relativeTo button: NSStatusBarButton) {
        guard let panel = panel else { return }

        positionPanel(relativeTo: button)
        panel.alphaValue = 0
        panel.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            panel.animator().alphaValue = 1
        }
    }

    func hidePanel() {
        guard let panel = panel else { return }

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: {
            panel.orderOut(nil)
            panel.alphaValue = 1
        })
    }

    // MARK: - Positioning

    private func positionPanel(relativeTo button: NSStatusBarButton) {
        guard let panel = panel,
              let buttonWindow = button.window else { return }

        // Get the button's frame in screen coordinates
        let buttonFrameInWindow = button.convert(button.bounds, to: nil)
        let buttonFrameOnScreen = buttonWindow.convertToScreen(buttonFrameInWindow)

        // Find the screen containing the tray icon (handles multi-monitor correctly)
        let targetScreen = NSScreen.screens.first { screen in
            screen.frame.contains(buttonFrameOnScreen.origin)
        } ?? NSScreen.main ?? NSScreen.screens[0]

        let panelWidth = panel.frame.width
        let panelHeight = panel.frame.height
        let margin: CGFloat = 4

        // Position panel below the tray icon, centered horizontally on it
        var x = buttonFrameOnScreen.midX - panelWidth / 2
        let y = buttonFrameOnScreen.minY - panelHeight - margin

        // Keep panel within screen bounds
        let screenLeft = targetScreen.visibleFrame.minX
        let screenRight = targetScreen.visibleFrame.maxX
        x = max(screenLeft + margin, min(x, screenRight - panelWidth - margin))

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - NSWindowDelegate

extension PanelManager: NSWindowDelegate {
    func windowDidResignKey(_ notification: Notification) {
        // Panel auto-hides when it loses key status (hidesOnDeactivate handles most cases,
        // but this ensures consistent behavior)
        hidePanel()
    }
}

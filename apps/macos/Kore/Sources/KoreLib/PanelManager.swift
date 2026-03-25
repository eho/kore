import AppKit
import WebKit

public class PanelManager: NSObject {
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var bridgeHandler: BridgeHandler?

    public var isVisible: Bool {
        panel?.isVisible ?? false
    }

    public override init() {
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

        // Do NOT set hidesOnDeactivate — in .accessory mode the app is never
        // "active", so the panel would immediately hide after orderFrontRegardless().
        // We handle hiding manually via NSEvent global monitor instead.
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true

        // Setup WKWebView
        let bridgeHandler = BridgeHandler()
        self.bridgeHandler = bridgeHandler

        let userContentController = WKUserContentController()
        userContentController.add(bridgeHandler, name: "bridge")

        let config = WKWebViewConfiguration()
        config.userContentController = userContentController
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        bridgeHandler.webView = webView

        panel.contentView = webView
        panel.delegate = self

        self.webView = webView
        self.panel = panel

        loadWebContent()
    }

    // MARK: - Web Content Loading

    private func loadWebContent() {
        // Look for index.html in the main app bundle's Resources (packaged .app)
        if let bundleURL = Bundle.main.url(forResource: "index", withExtension: "html") {
            webView?.loadFileURL(bundleURL, allowingReadAccessTo: bundleURL.deletingLastPathComponent())
            return
        }

        // Fallback: load dist/index.html relative to the Swift package root (for development).
        // #file is Sources/KoreLib/PanelManager.swift; 4× up = apps/macos/
        let distURL = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()  // Sources/KoreLib/
            .deletingLastPathComponent()  // Sources/
            .deletingLastPathComponent()  // Kore/
            .deletingLastPathComponent()  // apps/macos/
            .appendingPathComponent("dist/index.html")

        if FileManager.default.fileExists(atPath: distURL.path) {
            webView?.loadFileURL(distURL, allowingReadAccessTo: distURL.deletingLastPathComponent())
            return
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

    public func showPanel(relativeTo button: NSStatusBarButton) {
        guard let panel = panel else { return }

        positionPanel(relativeTo: button)

        panel.alphaValue = 0
        panel.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            panel.animator().alphaValue = 1
        }

        installDismissMonitor()
    }

    public func hidePanel() {
        guard let panel = panel else { return }

        removeDismissMonitor()

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: {
            panel.orderOut(nil)
            panel.alphaValue = 1
        })
    }

    // MARK: - Outside-click dismiss

    private var dismissMonitor: Any?

    private func installDismissMonitor() {
        removeDismissMonitor()
        dismissMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePanel()
        }
    }

    private func removeDismissMonitor() {
        if let monitor = dismissMonitor {
            NSEvent.removeMonitor(monitor)
            dismissMonitor = nil
        }
    }

    // MARK: - Positioning

    private func positionPanel(relativeTo button: NSStatusBarButton) {
        guard let panel = panel else { return }

        guard let buttonWindow = button.window else {
            // Fallback: position near the mouse cursor
            let mouse = NSEvent.mouseLocation
            let x = mouse.x - panel.frame.width / 2
            let y = mouse.y - panel.frame.height - 4
            panel.setFrameOrigin(NSPoint(x: x, y: y))
            return
        }

        let buttonFrameInWindow = button.convert(button.bounds, to: nil)
        let buttonFrameOnScreen = buttonWindow.convertToScreen(buttonFrameInWindow)

        // Find the screen containing the tray icon (handles multi-monitor correctly)
        let targetScreen = NSScreen.screens.first { screen in
            screen.frame.contains(buttonFrameOnScreen.origin)
        } ?? NSScreen.main ?? NSScreen.screens[0]

        let panelWidth = panel.frame.width
        let panelHeight = panel.frame.height
        let margin: CGFloat = 4

        var x = buttonFrameOnScreen.midX - panelWidth / 2
        let y = buttonFrameOnScreen.minY - panelHeight - margin

        let screenLeft = targetScreen.visibleFrame.minX
        let screenRight = targetScreen.visibleFrame.maxX
        x = max(screenLeft + margin, min(x, screenRight - panelWidth - margin))

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - NSWindowDelegate

extension PanelManager: NSWindowDelegate {
    public func windowDidResignKey(_ notification: Notification) {
        // Panel is non-activating so this fires rarely, but hide if it does
        hidePanel()
    }
}

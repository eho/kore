import WebKit
import Foundation

/// Handles bidirectional JS ↔ Swift communication via WKScriptMessageHandler.
///
/// JS → Swift: `window.webkit.messageHandlers.bridge.postMessage({ type: 'ping' })`
/// Swift → JS: `window.bridgeCallback(data)` called via `webView.evaluateJavaScript`
class BridgeHandler: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }

        handleMessage(type: type, payload: body)
    }

    // MARK: - Message Routing

    private func handleMessage(type: String, payload: [String: Any]) {
        switch type {
        case "ping":
            sendToJS(["type": "pong", "ts": Date().timeIntervalSince1970])
        default:
            sendToJS(["type": "error", "message": "Unknown message type: \(type)"])
        }
    }

    // MARK: - Swift → JS

    func sendToJS(_ data: [String: Any]) {
        guard let webView = webView else { return }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: data)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? "{}"
            let js = "window.bridgeCallback && window.bridgeCallback(\(jsonString));"

            DispatchQueue.main.async {
                webView.evaluateJavaScript(js) { _, error in
                    if let error = error {
                        print("[BridgeHandler] JS evaluation error: \(error)")
                    }
                }
            }
        } catch {
            print("[BridgeHandler] JSON serialization error: \(error)")
        }
    }
}

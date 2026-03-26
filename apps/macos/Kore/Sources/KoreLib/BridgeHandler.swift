import WebKit
import Foundation

/// Handles bidirectional JS ↔ Swift communication via WKScriptMessageHandler.
///
/// JS → Swift: `window.webkit.messageHandlers.bridge.postMessage({ type: 'ping' })`
/// Swift → JS: `window.bridgeCallback(data)` called via `webView.evaluateJavaScript`
public class BridgeHandler: NSObject, WKScriptMessageHandler {
    public weak var webView: WKWebView?

    /// The daemon manager to use for daemon control messages. Set by the app delegate.
    public var daemonManager: DaemonManager?

    public override init() {
        super.init()
    }

    public func userContentController(
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

        case "resolveKoreHome":
            let home = ConfigManager.resolveKoreHome()
            let expanded = (home as NSString).expandingTildeInPath
            sendToJS(["type": "resolveKoreHome", "koreHome": home, "koreHomeExpanded": expanded])

        case "readConfig":
            handleReadConfig(payload: payload)

        case "writeConfig":
            handleWriteConfig(payload: payload)

        case "checkNotesAccess":
            let status = Permissions.checkNotesAccess()
            sendToJS(["type": "checkNotesAccess", "status": status.rawValue])

        case "openFDASettings":
            do {
                try Permissions.openFDASettings()
                sendToJS(["type": "openFDASettings", "success": true])
            } catch {
                sendToJS(["type": "openFDASettings", "success": false, "error": error.localizedDescription])
            }

        case "revealInFinder":
            let path = payload["path"] as? String ?? "~/.kore"
            let expanded = (path as NSString).expandingTildeInPath
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: expanded)
            sendToJS(["type": "revealInFinder", "success": true])

        case "chooseClonePath":
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseFiles = false
                panel.canChooseDirectories = true
                panel.allowsMultipleSelection = false
                panel.message = "Select the Kore clone directory"
                if panel.runModal() == .OK, let url = panel.url {
                    let path = url.path
                    let coreApiPath = url.appendingPathComponent("apps/core-api").path
                    if FileManager.default.fileExists(atPath: coreApiPath) {
                        self.sendToJS(["type": "chooseClonePath", "path": path])
                    } else {
                        self.sendToJS(["type": "chooseClonePath", "error": "Invalid directory: must contain apps/core-api/"])
                    }
                }
            }

        case "checkBunInstalled":
            do {
                let path = try checkBunInstalled()
                sendToJS(["type": "checkBunInstalled", "path": path])
            } catch {
                sendToJS(["type": "checkBunInstalled", "error": error.localizedDescription])
            }

        case "checkOllamaRunning":
            let url = payload["url"] as? String ?? "http://localhost:11434"
            Task {
                do {
                    let running = try await checkOllamaRunning(url: url)
                    self.sendToJS(["type": "checkOllamaRunning", "running": running])
                } catch {
                    self.sendToJS(["type": "checkOllamaRunning", "running": false, "error": error.localizedDescription])
                }
            }

        case "startDaemon":
            handleStartDaemon(payload: payload)

        case "stopDaemon":
            handleStopDaemon()

        case "restartDaemon":
            handleRestartDaemon()

        case "getDaemonStatus":
            handleGetDaemonStatus()

        case "checkClaudeDesktopConfig":
            let path = NSString("~/Library/Application Support/Claude/claude_desktop_config.json").expandingTildeInPath
            let detected = FileManager.default.fileExists(atPath: path)
            sendToJS(["type": "checkClaudeDesktopConfig", "detected": detected])

        case "checkClaudeCodeConfig":
            // Claude Code stores settings in ~/.claude/settings.json
            let path = NSString("~/.claude/settings.json").expandingTildeInPath
            let detected = FileManager.default.fileExists(atPath: path)
            sendToJS(["type": "checkClaudeCodeConfig", "detected": detected])

        case "installMCPConfig":
            handleInstallMCPConfig(payload: payload)

        case "setLaunchAtLogin":
            handleSetLaunchAtLogin(payload: payload)

        case "getLaunchAtLogin":
            let enabled = LoginItem.getLaunchAtLogin()
            sendToJS(["type": "getLaunchAtLogin", "enabled": enabled])

        case "closeOnboarding":
            DispatchQueue.main.async {
                self.webView?.window?.close()
            }

        default:
            sendToJS(["type": "error", "message": "Unknown message type: \(type)"])
        }
    }

    // MARK: - Config Handlers

    private func handleReadConfig(payload: [String: Any]) {
        let koreHome = payload["koreHome"] as? String ?? "~/.kore"
        do {
            let config = try ConfigManager.readConfig(koreHome: koreHome)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(config)
            let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            sendToJS(["type": "readConfig", "config": dict])
        } catch {
            sendToJS(["type": "readConfig", "error": error.localizedDescription])
        }
    }

    private func handleWriteConfig(payload: [String: Any]) {
        let koreHome = payload["koreHome"] as? String ?? "~/.kore"
        guard let configDict = payload["config"] as? [String: Any] else {
            sendToJS(["type": "writeConfig", "success": false, "error": "Missing 'config' field"])
            return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: configDict)
            let config = try JSONDecoder().decode(KoreConfig.self, from: data)
            try ConfigManager.writeConfig(koreHome: koreHome, config: config)
            sendToJS(["type": "writeConfig", "success": true])
        } catch {
            sendToJS(["type": "writeConfig", "success": false, "error": error.localizedDescription])
        }
    }

    // MARK: - Daemon Handlers

    private func handleStartDaemon(payload: [String: Any]) {
        guard let dm = daemonManager else {
            sendToJS(["type": "daemonStatus", "status": "error", "managed": false, "error": "DaemonManager not available."])
            return
        }
        let clonePath = payload["clonePath"] as? String ?? "~/dev/kore"
        let port = payload["port"] as? Int ?? 3000
        Task {
            await dm.startDaemon(clonePath: clonePath, port: port)
            let state = await dm.daemonStatus()
            let managed = await dm.isManaged()
            self.sendDaemonStatus(state, managed: managed)
        }
    }

    private func handleStopDaemon() {
        guard let dm = daemonManager else {
            sendToJS(["type": "daemonStatus", "status": "error", "managed": false, "error": "DaemonManager not available."])
            return
        }
        Task {
            await dm.stopDaemon()
            let state = await dm.daemonStatus()
            let managed = await dm.isManaged()
            self.sendDaemonStatus(state, managed: managed)
        }
    }

    private func handleRestartDaemon() {
        guard let dm = daemonManager else {
            sendToJS(["type": "daemonStatus", "status": "error", "managed": false, "error": "DaemonManager not available."])
            return
        }
        Task {
            await dm.restartDaemon()
            let state = await dm.daemonStatus()
            let managed = await dm.isManaged()
            self.sendDaemonStatus(state, managed: managed)
        }
    }

    private func handleGetDaemonStatus() {
        guard let dm = daemonManager else {
            sendToJS(["type": "daemonStatus", "status": "stopped", "managed": false])
            return
        }
        Task {
            let state = await dm.daemonStatus()
            let managed = await dm.isManaged()
            self.sendDaemonStatus(state, managed: managed)
        }
    }

    /// Pushes the current daemon state to the JS layer.
    public func sendDaemonStatus(_ state: DaemonState, managed: Bool = true) {
        var msg: [String: Any] = ["type": "daemonStatus", "status": state.statusKey, "managed": managed]
        if let errMsg = state.errorMessage {
            msg["error"] = errMsg
        }
        sendToJS(msg)
    }

    // MARK: - MCP Config Handlers

    private func handleInstallMCPConfig(payload: [String: Any]) {
        guard let target = payload["target"] as? String else {
            sendToJS(["type": "installMCPConfig", "success": false, "error": "Missing 'target' field"])
            return
        }
        let daemonURL = payload["daemonURL"] as? String ?? "http://localhost:\(payload["port"] as? Int ?? 3000)"
        let apiKey = payload["apiKey"] as? String ?? ""

        do {
            try MCPConfig.installMCPConfig(target: target, daemonURL: daemonURL, apiKey: apiKey)
            sendToJS(["type": "installMCPConfig", "success": true, "target": target])
        } catch {
            sendToJS(["type": "installMCPConfig", "success": false, "error": error.localizedDescription])
        }
    }

    // MARK: - Login Item Handlers

    private func handleSetLaunchAtLogin(payload: [String: Any]) {
        let enabled = payload["enabled"] as? Bool ?? false
        do {
            try LoginItem.setLaunchAtLogin(enabled: enabled)
            sendToJS(["type": "setLaunchAtLogin", "success": true, "enabled": enabled])
        } catch {
            sendToJS(["type": "setLaunchAtLogin", "success": false, "error": error.localizedDescription])
        }
    }

    // MARK: - Swift → JS

    public func sendToJS(_ data: [String: Any]) {
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

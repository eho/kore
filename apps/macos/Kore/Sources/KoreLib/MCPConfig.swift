import Foundation

/// Errors specific to MCP configuration operations.
public enum MCPConfigError: LocalizedError {
    case invalidTarget(String)
    case jsonParseError(String)
    case writeError(String)

    public var errorDescription: String? {
        switch self {
        case .invalidTarget(let target):
            return "Unknown MCP target: \(target). Expected 'claude-desktop' or 'claude-code'."
        case .jsonParseError(let detail):
            return "Failed to parse existing config: \(detail)"
        case .writeError(let detail):
            return "Failed to write config: \(detail)"
        }
    }
}

/// Manages MCP server configuration for Claude Desktop and Claude Code.
public struct MCPConfig {

    // MARK: - Config file paths

    static func claudeDesktopConfigPath() -> String {
        return NSString("~/Library/Application Support/Claude/claude_desktop_config.json").expandingTildeInPath
    }

    static func claudeCodeConfigPath() -> String {
        return NSString("~/.claude/settings.json").expandingTildeInPath
    }

    // MARK: - MCP server entry

    /// Builds the Kore MCP server entry for inclusion in config files.
    static func koreMCPEntry(daemonURL: String, apiKey: String) -> [String: Any] {
        return [
            "command": "kore",
            "args": ["mcp"],
            "env": [
                "KORE_API_KEY": apiKey,
                "KORE_API_URL": daemonURL
            ]
        ]
    }

    // MARK: - Public API

    /// Installs the Kore MCP server entry into the specified target's config file.
    ///
    /// - Parameters:
    ///   - target: Either `"claude-desktop"` or `"claude-code"`.
    ///   - daemonURL: The daemon URL (e.g. `"http://localhost:3000"`).
    ///   - apiKey: The API key for authenticating with the daemon.
    /// - Throws: `MCPConfigError` if the target is unknown or config I/O fails.
    public static func installMCPConfig(target: String, daemonURL: String, apiKey: String) throws {
        switch target {
        case "claude-desktop":
            try installClaudeDesktop(daemonURL: daemonURL, apiKey: apiKey)
        case "claude-code":
            try installClaudeCode(daemonURL: daemonURL, apiKey: apiKey)
        default:
            throw MCPConfigError.invalidTarget(target)
        }
    }

    // MARK: - Claude Desktop

    /// Reads/creates `claude_desktop_config.json` and adds/updates the `kore` MCP server entry.
    static func installClaudeDesktop(daemonURL: String, apiKey: String) throws {
        let path = claudeDesktopConfigPath()
        var root = try readJSONObject(at: path)

        // Ensure mcpServers dict exists
        var mcpServers = root["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["kore"] = koreMCPEntry(daemonURL: daemonURL, apiKey: apiKey)
        root["mcpServers"] = mcpServers

        try writeJSONObject(root, to: path)
    }

    // MARK: - Claude Code

    /// Reads/creates `~/.claude/settings.json` and adds/updates the `kore` MCP server entry.
    static func installClaudeCode(daemonURL: String, apiKey: String) throws {
        let path = claudeCodeConfigPath()
        var root = try readJSONObject(at: path)

        // Claude Code uses "mcpServers" at the top level of settings.json
        var mcpServers = root["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["kore"] = koreMCPEntry(daemonURL: daemonURL, apiKey: apiKey)
        root["mcpServers"] = mcpServers

        try writeJSONObject(root, to: path)
    }

    // MARK: - JSON Helpers

    /// Reads a JSON file and returns it as a dictionary. Returns an empty dict if the file doesn't exist.
    static func readJSONObject(at path: String) throws -> [String: Any] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else {
            return [:]
        }

        let url = URL(fileURLWithPath: path)
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw MCPConfigError.jsonParseError("Could not read file: \(error.localizedDescription)")
        }

        // Handle empty files
        if data.isEmpty {
            return [:]
        }

        do {
            guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw MCPConfigError.jsonParseError("Config is not a JSON object")
            }
            return dict
        } catch let error as MCPConfigError {
            throw error
        } catch {
            throw MCPConfigError.jsonParseError(error.localizedDescription)
        }
    }

    /// Writes a dictionary as pretty-printed JSON. Creates intermediate directories if needed.
    static func writeJSONObject(_ dict: [String: Any], to path: String) throws {
        let url = URL(fileURLWithPath: path)
        let dir = url.deletingLastPathComponent()

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw MCPConfigError.writeError("Could not create directory: \(error.localizedDescription)")
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
        } catch {
            throw MCPConfigError.writeError(error.localizedDescription)
        }
    }
}

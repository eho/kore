import Foundation

// MARK: - Config Schema

/// Mirrors the config.json schema written by the macOS app and read by the Bun daemon.
public struct KoreConfig: Codable {
    public var koreHome: String?
    public var port: Int?
    public var apiKey: String?
    public var llm: LlmConfig?
    public var appleNotes: AppleNotesConfig?
    public var consolidation: ConsolidationConfig?
    public var embedIntervalMs: Int?
    public var mcpEnabled: Bool?

    public struct LlmConfig: Codable {
        public var provider: String?
        public var geminiApiKey: String?
        public var geminiModel: String?
        public var ollamaBaseUrl: String?
        public var ollamaModel: String?

        public init(provider: String? = nil, geminiApiKey: String? = nil,
                    geminiModel: String? = nil, ollamaBaseUrl: String? = nil,
                    ollamaModel: String? = nil) {
            self.provider = provider
            self.geminiApiKey = geminiApiKey
            self.geminiModel = geminiModel
            self.ollamaBaseUrl = ollamaBaseUrl
            self.ollamaModel = ollamaModel
        }
    }

    public struct AppleNotesConfig: Codable {
        public var enabled: Bool?
        public var syncIntervalMs: Int?
        public var includeHandwriting: Bool?
        public var folderAllowlist: [String]?
        public var folderBlocklist: [String]?
        public var dbDirOverride: String?

        public init(enabled: Bool? = nil, syncIntervalMs: Int? = nil,
                    includeHandwriting: Bool? = nil, folderAllowlist: [String]? = nil,
                    folderBlocklist: [String]? = nil, dbDirOverride: String? = nil) {
            self.enabled = enabled
            self.syncIntervalMs = syncIntervalMs
            self.includeHandwriting = includeHandwriting
            self.folderAllowlist = folderAllowlist
            self.folderBlocklist = folderBlocklist
            self.dbDirOverride = dbDirOverride
        }
    }

    public struct ConsolidationConfig: Codable {
        public var intervalMs: Int?
        public var cooldownDays: Int?
        public var maxAttempts: Int?

        public init(intervalMs: Int? = nil, cooldownDays: Int? = nil, maxAttempts: Int? = nil) {
            self.intervalMs = intervalMs
            self.cooldownDays = cooldownDays
            self.maxAttempts = maxAttempts
        }
    }

    public init(koreHome: String? = nil, port: Int? = nil, apiKey: String? = nil,
                llm: LlmConfig? = nil, appleNotes: AppleNotesConfig? = nil,
                consolidation: ConsolidationConfig? = nil, embedIntervalMs: Int? = nil,
                mcpEnabled: Bool? = nil) {
        self.koreHome = koreHome
        self.port = port
        self.apiKey = apiKey
        self.llm = llm
        self.appleNotes = appleNotes
        self.consolidation = consolidation
        self.embedIntervalMs = embedIntervalMs
        self.mcpEnabled = mcpEnabled
    }

    /// A config populated with default values matching the TypeScript defaults.
    public static var defaults: KoreConfig {
        KoreConfig(
            koreHome: nil,
            port: 3000,
            apiKey: nil,
            llm: LlmConfig(
                provider: "ollama",
                geminiApiKey: nil,
                geminiModel: "gemini-2.5-flash-lite",
                ollamaBaseUrl: "http://localhost:11434",
                ollamaModel: "qwen2.5:7b"
            ),
            appleNotes: AppleNotesConfig(
                enabled: false,
                syncIntervalMs: 900_000,
                includeHandwriting: false,
                folderAllowlist: [],
                folderBlocklist: [],
                dbDirOverride: nil
            ),
            consolidation: ConsolidationConfig(
                intervalMs: 1_800_000,
                cooldownDays: 7,
                maxAttempts: 3
            ),
            embedIntervalMs: 300_000,
            mcpEnabled: true
        )
    }
}

// MARK: - ConfigManager

public enum ConfigError: LocalizedError {
    case invalidJSON(String)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON(let detail):
            return "config.json contains invalid JSON: \(detail)"
        }
    }
}

public struct ConfigManager {
    private static let configFileName = "config.json"

    private static func configURL(koreHome: String) -> URL {
        let expanded = (koreHome as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded).appendingPathComponent(configFileName)
    }

    /// Reads and parses config.json from `koreHome`. Returns defaults if file is missing.
    /// Throws `ConfigError.invalidJSON` if the file exists but cannot be parsed.
    public static func readConfig(koreHome: String) throws -> KoreConfig {
        let url = configURL(koreHome: koreHome)

        guard FileManager.default.fileExists(atPath: url.path) else {
            return .defaults
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw ConfigError.invalidJSON("Could not read file: \(error.localizedDescription)")
        }

        do {
            let decoder = JSONDecoder()
            return try decoder.decode(KoreConfig.self, from: data)
        } catch {
            throw ConfigError.invalidJSON(error.localizedDescription)
        }
    }

    /// Writes `config` to `koreHome/config.json` with pretty formatting.
    /// Creates intermediate directories if needed.
    public static func writeConfig(koreHome: String, config: KoreConfig) throws {
        let url = configURL(koreHome: koreHome)
        let dir = url.deletingLastPathComponent()

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: url, options: .atomic)
    }
}

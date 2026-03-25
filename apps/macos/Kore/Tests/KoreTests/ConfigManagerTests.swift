import XCTest
@testable import KoreLib

final class ConfigManagerTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreConfigTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - readConfig

    func testReadValidJSON() throws {
        let json = """
        {
          "port": 4000,
          "apiKey": "test-key",
          "llm": {
            "provider": "gemini",
            "geminiApiKey": "AIza-test",
            "geminiModel": "gemini-2.0-flash",
            "ollamaBaseUrl": "http://localhost:9999",
            "ollamaModel": "llama3"
          },
          "appleNotes": { "enabled": true },
          "mcpEnabled": false
        }
        """
        try json.write(to: tmpDir.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)

        let config = try ConfigManager.readConfig(koreHome: tmpDir.path)

        XCTAssertEqual(config.port, 4000)
        XCTAssertEqual(config.apiKey, "test-key")
        XCTAssertEqual(config.llm?.provider, "gemini")
        XCTAssertEqual(config.llm?.geminiApiKey, "AIza-test")
        XCTAssertEqual(config.llm?.geminiModel, "gemini-2.0-flash")
        XCTAssertEqual(config.llm?.ollamaBaseUrl, "http://localhost:9999")
        XCTAssertEqual(config.llm?.ollamaModel, "llama3")
        XCTAssertEqual(config.appleNotes?.enabled, true)
        XCTAssertEqual(config.mcpEnabled, false)
    }

    func testReadMissingFileReturnsDefaults() throws {
        // No config.json in tmpDir
        let config = try ConfigManager.readConfig(koreHome: tmpDir.path)

        XCTAssertEqual(config.port, 3000)
        XCTAssertNil(config.apiKey)
        XCTAssertEqual(config.llm?.provider, "ollama")
        XCTAssertEqual(config.llm?.ollamaBaseUrl, "http://localhost:11434")
        XCTAssertEqual(config.llm?.ollamaModel, "qwen2.5:7b")
        XCTAssertEqual(config.appleNotes?.enabled, false)
        XCTAssertEqual(config.mcpEnabled, true)
    }

    func testWriteThenReadRoundTrip() throws {
        var config = KoreConfig.defaults
        config.port = 7777
        config.apiKey = "round-trip-key"
        config.llm = KoreConfig.LlmConfig(
            provider: "gemini",
            geminiApiKey: "AIza-roundtrip",
            geminiModel: nil,
            ollamaBaseUrl: nil,
            ollamaModel: nil
        )

        try ConfigManager.writeConfig(koreHome: tmpDir.path, config: config)
        let loaded = try ConfigManager.readConfig(koreHome: tmpDir.path)

        XCTAssertEqual(loaded.port, 7777)
        XCTAssertEqual(loaded.apiKey, "round-trip-key")
        XCTAssertEqual(loaded.llm?.provider, "gemini")
        XCTAssertEqual(loaded.llm?.geminiApiKey, "AIza-roundtrip")
    }

    func testMalformedJSONReturnsError() throws {
        try "{ not valid json }".write(
            to: tmpDir.appendingPathComponent("config.json"),
            atomically: true,
            encoding: .utf8
        )

        XCTAssertThrowsError(try ConfigManager.readConfig(koreHome: tmpDir.path)) { error in
            XCTAssertTrue(error.localizedDescription.contains("invalid JSON") ||
                          error.localizedDescription.contains("JSON"))
        }
    }

    func testWriteCreatesIntermediateDirectories() throws {
        let deepDir = tmpDir.appendingPathComponent("a/b/c")
        var config = KoreConfig.defaults
        config.port = 9090

        // Directory doesn't exist yet — writeConfig should create it
        XCTAssertNoThrow(try ConfigManager.writeConfig(koreHome: deepDir.path, config: config))

        let loaded = try ConfigManager.readConfig(koreHome: deepDir.path)
        XCTAssertEqual(loaded.port, 9090)
    }
}

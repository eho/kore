import XCTest
@testable import KoreLib

final class MCPConfigTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreMCPConfigTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - koreMCPEntry

    func testKoreMCPEntryStructure() {
        let entry = MCPConfig.koreMCPEntry(daemonURL: "http://localhost:3000", apiKey: "test-key")

        XCTAssertEqual(entry["command"] as? String, "kore")
        XCTAssertEqual(entry["args"] as? [String], ["mcp"])

        let env = entry["env"] as? [String: String]
        XCTAssertEqual(env?["KORE_API_KEY"], "test-key")
        XCTAssertEqual(env?["KORE_API_URL"], "http://localhost:3000")
    }

    // MARK: - JSON Helpers

    func testReadJSONObjectMissingFileReturnsEmpty() throws {
        let result = try MCPConfig.readJSONObject(at: tmpDir.appendingPathComponent("nonexistent.json").path)
        XCTAssertTrue(result.isEmpty)
    }

    func testReadJSONObjectEmptyFileReturnsEmpty() throws {
        let path = tmpDir.appendingPathComponent("empty.json").path
        FileManager.default.createFile(atPath: path, contents: Data())

        let result = try MCPConfig.readJSONObject(at: path)
        XCTAssertTrue(result.isEmpty)
    }

    func testReadJSONObjectValidJSON() throws {
        let path = tmpDir.appendingPathComponent("test.json").path
        let json = """
        {"existing": "value", "nested": {"key": 42}}
        """
        try json.write(toFile: path, atomically: true, encoding: .utf8)

        let result = try MCPConfig.readJSONObject(at: path)
        XCTAssertEqual(result["existing"] as? String, "value")
        let nested = result["nested"] as? [String: Any]
        XCTAssertEqual(nested?["key"] as? Int, 42)
    }

    func testReadJSONObjectInvalidJSONThrows() {
        let path = tmpDir.appendingPathComponent("bad.json").path
        try! "{ not valid }".write(toFile: path, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try MCPConfig.readJSONObject(at: path))
    }

    func testWriteJSONObjectCreatesDirectories() throws {
        let deepPath = tmpDir.appendingPathComponent("a/b/c/test.json").path
        let dict: [String: Any] = ["key": "value"]

        try MCPConfig.writeJSONObject(dict, to: deepPath)

        let readBack = try MCPConfig.readJSONObject(at: deepPath)
        XCTAssertEqual(readBack["key"] as? String, "value")
    }

    // MARK: - installClaudeDesktop

    func testInstallClaudeDesktopCreatesNewFile() throws {
        let configPath = tmpDir.appendingPathComponent("claude_desktop_config.json").path

        // Temporarily override the config path by writing directly via the helper
        var root: [String: Any] = [:]
        var mcpServers = root["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["kore"] = MCPConfig.koreMCPEntry(daemonURL: "http://localhost:3000", apiKey: "my-key")
        root["mcpServers"] = mcpServers
        try MCPConfig.writeJSONObject(root, to: configPath)

        // Read back and verify
        let readBack = try MCPConfig.readJSONObject(at: configPath)
        let servers = readBack["mcpServers"] as? [String: Any]
        XCTAssertNotNil(servers)
        let kore = servers?["kore"] as? [String: Any]
        XCTAssertEqual(kore?["command"] as? String, "kore")
        XCTAssertEqual(kore?["args"] as? [String], ["mcp"])
        let env = kore?["env"] as? [String: String]
        XCTAssertEqual(env?["KORE_API_KEY"], "my-key")
        XCTAssertEqual(env?["KORE_API_URL"], "http://localhost:3000")
    }

    func testInstallPreservesExistingEntries() throws {
        let configPath = tmpDir.appendingPathComponent("config.json").path

        // Write initial config with existing entries
        let initial: [String: Any] = [
            "mcpServers": [
                "other-server": ["command": "other", "args": ["--flag"]]
            ],
            "otherSetting": true
        ]
        try MCPConfig.writeJSONObject(initial, to: configPath)

        // Add kore entry
        var root = try MCPConfig.readJSONObject(at: configPath)
        var mcpServers = root["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["kore"] = MCPConfig.koreMCPEntry(daemonURL: "http://localhost:4000", apiKey: "key2")
        root["mcpServers"] = mcpServers
        try MCPConfig.writeJSONObject(root, to: configPath)

        // Read back — both entries should exist
        let readBack = try MCPConfig.readJSONObject(at: configPath)
        let servers = readBack["mcpServers"] as? [String: Any]
        XCTAssertNotNil(servers?["other-server"])
        XCTAssertNotNil(servers?["kore"])
        XCTAssertEqual(readBack["otherSetting"] as? Bool, true)
    }

    func testInstallUpdatesExistingKoreEntry() throws {
        let configPath = tmpDir.appendingPathComponent("config.json").path

        // Write initial config with old kore entry
        let initial: [String: Any] = [
            "mcpServers": [
                "kore": ["command": "old-kore", "args": ["old"]]
            ]
        ]
        try MCPConfig.writeJSONObject(initial, to: configPath)

        // Update kore entry
        var root = try MCPConfig.readJSONObject(at: configPath)
        var mcpServers = root["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["kore"] = MCPConfig.koreMCPEntry(daemonURL: "http://localhost:5000", apiKey: "new-key")
        root["mcpServers"] = mcpServers
        try MCPConfig.writeJSONObject(root, to: configPath)

        // Read back — kore should be updated
        let readBack = try MCPConfig.readJSONObject(at: configPath)
        let servers = readBack["mcpServers"] as? [String: Any]
        let kore = servers?["kore"] as? [String: Any]
        XCTAssertEqual(kore?["command"] as? String, "kore")
        let env = kore?["env"] as? [String: String]
        XCTAssertEqual(env?["KORE_API_KEY"], "new-key")
        XCTAssertEqual(env?["KORE_API_URL"], "http://localhost:5000")
    }

    // MARK: - Invalid target

    func testInstallMCPConfigInvalidTargetThrows() {
        XCTAssertThrowsError(try MCPConfig.installMCPConfig(target: "invalid", daemonURL: "http://localhost:3000", apiKey: "key")) { error in
            XCTAssertTrue(error.localizedDescription.contains("Unknown MCP target"))
        }
    }
}

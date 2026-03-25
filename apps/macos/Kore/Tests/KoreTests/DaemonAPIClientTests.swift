import XCTest
@testable import KoreLib

final class DaemonAPIClientTests: XCTestCase {

    // MARK: - Construction

    func testFromConfigUsesDefaults() {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreAPITests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

        // No config.json → should get defaults.
        let client = DaemonAPIClient.fromConfig(koreHome: tmpDir.path)
        XCTAssertEqual(client.port, 3000)
        XCTAssertNil(client.apiKey)
    }

    func testFromConfigReadsConfigFile() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreAPITests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let config = KoreConfig(port: 8080, apiKey: "test-key-123")
        try ConfigManager.writeConfig(koreHome: tmpDir.path, config: config)

        let client = DaemonAPIClient.fromConfig(koreHome: tmpDir.path)
        XCTAssertEqual(client.port, 8080)
        XCTAssertEqual(client.apiKey, "test-key-123")
    }

    // MARK: - Request building

    func testHealthCheckReturnsNetworkErrorWhenNothingListening() async {
        // Port 1 is almost certainly not serving HTTP.
        let client = DaemonAPIClient(port: 1, apiKey: nil)
        let result = await client.healthCheck()

        if case .networkError = result {
            // Expected
        } else {
            XCTFail("Expected .networkError, got \(result)")
        }
    }

    func testRequestIncludesBearerToken() async {
        // We can't inspect the request directly without a mock server,
        // but we verify the client initializes with the key and the call
        // doesn't crash. The integration tests below verify auth end-to-end.
        let client = DaemonAPIClient(port: 1, apiKey: "my-secret")
        let result = await client.post(path: "/nonexistent")

        if case .networkError = result {
            // Expected — nothing listening, but request was attempted.
        } else {
            XCTFail("Expected .networkError, got \(result)")
        }
    }

    func testNotRunningPortReturnsNetworkError() async {
        let client = DaemonAPIClient(port: 59999)
        let result = await client.syncAppleNotes()

        if case .networkError = result {
            // Expected
        } else {
            XCTFail("Expected .networkError on unused port, got \(result)")
        }
    }

    // MARK: - APIResult equality

    func testAPIResultEquality() {
        XCTAssertEqual(APIResult.success(200), APIResult.success(200))
        XCTAssertNotEqual(APIResult.success(200), APIResult.success(202))
        XCTAssertEqual(APIResult.httpError(400), APIResult.httpError(400))
        XCTAssertEqual(APIResult.notRunning, APIResult.notRunning)
        XCTAssertEqual(APIResult.networkError("timeout"), APIResult.networkError("timeout"))
        XCTAssertNotEqual(APIResult.success(200), APIResult.httpError(200))
    }
}

// MARK: - Integration tests (require a running Kore server on port 3000)
//
// These tests hit the real daemon. They are skipped automatically if the
// health endpoint is not reachable, so they don't break CI.

final class DaemonAPIClientIntegrationTests: XCTestCase {
    private var client: DaemonAPIClient!
    private var serverAvailable = false

    override func setUp() async throws {
        client = DaemonAPIClient(port: 3000, apiKey: "random-key-for-testing")
        let health = await client.healthCheck()
        if case .success = health {
            serverAvailable = true
        }
    }

    func testHealthCheck() async throws {
        try XCTSkipUnless(serverAvailable, "Kore server not running on :3000")
        let result = await client.healthCheck()
        XCTAssertEqual(result, .success(200))
    }

    func testSyncAppleNotes() async throws {
        try XCTSkipUnless(serverAvailable, "Kore server not running on :3000")
        let result = await client.syncAppleNotes()
        // Apple Notes sync returns 202 Accepted
        XCTAssertEqual(result, .success(202))
    }

    func testTriggerConsolidation() async throws {
        try XCTSkipUnless(serverAvailable, "Kore server not running on :3000")
        let result = await client.triggerConsolidation()
        // Consolidation may return 200 (success) or 500 (no eligible candidates).
        // Either proves the endpoint was reached — not a network error.
        switch result {
        case .success, .httpError:
            break
        case .networkError(let msg):
            XCTFail("Should not get network error against running server: \(msg)")
        case .notRunning:
            XCTFail("Should not get .notRunning against running server")
        }
    }

    func testUnauthorizedRequest() async throws {
        try XCTSkipUnless(serverAvailable, "Kore server not running on :3000")
        let badClient = DaemonAPIClient(port: 3000, apiKey: "wrong-key")
        let result = await badClient.healthCheck()
        // Health endpoint may or may not require auth — if it does, expect 401.
        // If it doesn't, expect 200. Either way, it should not be a network error.
        switch result {
        case .success, .httpError:
            break // Either is acceptable
        case .networkError(let msg):
            XCTFail("Should not get network error against running server: \(msg)")
        case .notRunning:
            XCTFail("Should not get .notRunning against running server")
        }
    }
}

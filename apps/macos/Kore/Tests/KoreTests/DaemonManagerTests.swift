import XCTest
@testable import KoreLib

final class DaemonManagerTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreDaemonTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    /// Returns a `DaemonManager` with health polling disabled and a test spawn override.
    private func makeManager(
        spawn: @escaping (_ clonePath: String, _ port: Int) -> Process? = { _, _ in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sleep")
            p.arguments = ["60"]
            return p
        }
    ) -> DaemonManager {
        let mgr = DaemonManager(koreHome: tmpDir.path)
        mgr._disableHealthPolling = true
        mgr._testSpawn = spawn
        return mgr
    }

    // MARK: - Start writes PID file

    func testStartWritesPIDFile() async throws {
        let mgr = makeManager()

        await mgr.startDaemon(clonePath: tmpDir.path, port: 3000)

        let status = await mgr.daemonStatus()
        XCTAssertEqual(status, .running)

        let pidURL = await mgr.pidFileURL()
        XCTAssertTrue(FileManager.default.fileExists(atPath: pidURL.path))

        let pidString = try String(contentsOf: pidURL, encoding: .utf8)
        let pid = Int32(pidString.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertNotNil(pid, "PID file should contain a valid integer")
        XCTAssertGreaterThan(pid!, 0)

        await mgr.stopDaemon()
    }

    // MARK: - Stop cleans up PID file

    func testStopCleansPIDFile() async throws {
        let mgr = makeManager()

        await mgr.startDaemon(clonePath: tmpDir.path, port: 3000)

        let pidURL = await mgr.pidFileURL()
        XCTAssertTrue(FileManager.default.fileExists(atPath: pidURL.path))

        await mgr.stopDaemon()

        let status = await mgr.daemonStatus()
        XCTAssertEqual(status, .stopped)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "PID file should be deleted after stopDaemon()"
        )
    }

    // MARK: - Stale PID file on startup is cleaned up

    func testStalePIDFileCleanedUpOnAdoption() async throws {
        let mgr = DaemonManager(koreHome: tmpDir.path)

        // Write a PID file pointing to a dead process.
        // Use a very high PID that is almost certainly not alive on macOS.
        let deadPID: Int32 = 99_000_001
        guard kill(deadPID, 0) != 0 else {
            // Near-impossible edge case: skip if PID somehow exists.
            return
        }

        let pidURL = await mgr.pidFileURL()
        try FileManager.default.createDirectory(
            at: pidURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try String(deadPID).write(to: pidURL, atomically: true, encoding: .utf8)

        mgr._disableHealthPolling = true
        await mgr.adoptOrphanedProcess()

        let status = await mgr.daemonStatus()
        XCTAssertEqual(status, .stopped, "Daemon should be stopped when stale PID file is found")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "Stale PID file should be removed during startup adoption"
        )
    }

    // MARK: - Adoption of live process

    func testAdoptsLiveProcess() async throws {
        let mgr = DaemonManager(koreHome: tmpDir.path)

        // Write the test process's own PID — it is definitely alive.
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let pidURL = await mgr.pidFileURL()
        try FileManager.default.createDirectory(
            at: pidURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try String(ownPID).write(to: pidURL, atomically: true, encoding: .utf8)

        mgr._disableHealthPolling = true
        await mgr.adoptOrphanedProcess()

        let status = await mgr.daemonStatus()
        XCTAssertEqual(status, .running, "Should adopt a live PID as running")
    }

    // MARK: - Crash triggers single auto-restart

    func testCrashTriggersAutoRestart() async throws {
        // First spawn crashes; second spawn runs long (simulates successful restart).
        var spawnIndex = 0
        let mgr = makeManager(spawn: { _, _ in
            spawnIndex += 1
            let p = Process()
            if spawnIndex == 1 {
                p.executableURL = URL(fileURLWithPath: "/bin/sh")
                p.arguments = ["-c", "exit 1"]   // crash immediately
            } else {
                p.executableURL = URL(fileURLWithPath: "/bin/sleep")
                p.arguments = ["60"]              // stay alive
            }
            return p
        })

        await mgr.startDaemon(clonePath: tmpDir.path, port: 3000)

        // Wait for the auto-restart cycle to complete.
        // The state machine goes: running (spawn #1) → starting (crash) → running (spawn #2).
        // We must observe the intermediate .starting state to confirm a crash happened,
        // then wait for the second .running (restart complete).
        // Total expected time: ~3 seconds (DaemonManager's restart delay).
        let deadline = Date().addingTimeInterval(10)
        var observedCrash = false
        var finalState: DaemonState = .running

        while Date() < deadline {
            let current = await mgr.daemonStatus()
            if current == .starting {
                observedCrash = true  // Crash confirmed
            } else if current == .running && observedCrash {
                finalState = current
                break  // Restart complete
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        XCTAssertTrue(observedCrash, "State should have transitioned to .starting when process crashed")
        XCTAssertEqual(finalState, .running, "Daemon should be running after auto-restart")

        await mgr.stopDaemon()
    }

    // MARK: - Double crash within 30 seconds does not restart

    func testDoubleCrashWithin30sDoesNotAutoRestart() async throws {
        var spawnCount = 0

        // Both spawns crash immediately — simulates the second restart also failing.
        let mgr = makeManager(spawn: { _, _ in
            spawnCount += 1
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "exit 1"]
            return p
        })

        await mgr.startDaemon(clonePath: tmpDir.path, port: 3000)

        // First crash → 3s delay → auto-restart → second crash → error state.
        // Allow up to 10 seconds total.
        let deadline = Date().addingTimeInterval(10)
        var finalState: DaemonState = .starting
        while Date() < deadline {
            finalState = await mgr.daemonStatus()
            if case .error = finalState { break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        guard case .error(let msg) = finalState else {
            XCTFail("Expected .error state after double crash within 30s, got \(finalState)")
            return
        }

        XCTAssertTrue(
            msg.contains("30 seconds"),
            "Error message should mention the 30-second crash window. Got: \(msg)"
        )
        XCTAssertEqual(spawnCount, 2, "Should have spawned exactly twice before giving up")

        let pidURL = await mgr.pidFileURL()
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "PID file should be cleaned up after terminal error state"
        )
    }
}

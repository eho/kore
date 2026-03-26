import XCTest
@testable import KoreLib

final class ProcessManagerTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("KoreProcessTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    /// Returns a `ProcessManager` with health polling disabled and a test spawn override.
    private func makeManager(
        spawn: @escaping (_ clonePath: String, _ port: Int) -> Process? = { _, _ in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sleep")
            p.arguments = ["60"]
            return p
        }
    ) -> ProcessManager {
        let mgr = ProcessManager(koreHome: tmpDir.path)
        mgr._disableHealthPolling = true
        mgr._testSpawn = spawn
        return mgr
    }

    /// Returns a `ProcessManager` configured for health-check / reconnect tests
    /// (polling enabled, fast intervals, fake health endpoint).
    private func makeMonitoringManager(
        healthCheck: @escaping (_ port: Int) async -> Bool
    ) -> ProcessManager {
        let mgr = ProcessManager(koreHome: tmpDir.path)
        mgr._testHealthCheck = healthCheck
        mgr._testPollIntervalNs = 50_000_000  // 50 ms for fast tests
        return mgr
    }

    // MARK: - Process Lifecycle: Start writes PID file

    func testStartWritesPIDFile() async throws {
        let mgr = makeManager()

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)

        let status = await mgr.serverStatus()
        XCTAssertEqual(status, .running)

        let pidURL = await mgr.pidFileURL()
        XCTAssertTrue(FileManager.default.fileExists(atPath: pidURL.path))

        let pidString = try String(contentsOf: pidURL, encoding: .utf8)
        let pid = Int32(pidString.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertNotNil(pid, "PID file should contain a valid integer")
        XCTAssertGreaterThan(pid!, 0)

        await mgr.stopServer()
    }

    // MARK: - Process Lifecycle: Stop cleans up PID file

    func testStopCleansPIDFile() async throws {
        let mgr = makeManager()

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)

        let pidURL = await mgr.pidFileURL()
        XCTAssertTrue(FileManager.default.fileExists(atPath: pidURL.path))

        await mgr.stopServer()

        let status = await mgr.serverStatus()
        XCTAssertEqual(status, .stopped)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "PID file should be deleted after stopServer()"
        )
    }

    // MARK: - Process Lifecycle: Stale PID file cleanup

    func testStalePIDFileCleanedUpOnAdoption() async throws {
        let mgr = ProcessManager(koreHome: tmpDir.path)

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

        let status = await mgr.serverStatus()
        XCTAssertEqual(status, .stopped, "Server should be stopped when stale PID file is found")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "Stale PID file should be removed during startup adoption"
        )
    }

    // MARK: - Process Lifecycle: Adoption of live process

    func testAdoptsLiveProcess() async throws {
        let mgr = ProcessManager(koreHome: tmpDir.path)

        // Write the test process's own PID — it is definitely alive.
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let pidURL = await mgr.pidFileURL()
        try FileManager.default.createDirectory(
            at: pidURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try String(ownPID).write(to: pidURL, atomically: true, encoding: .utf8)

        mgr._disableHealthPolling = true
        await mgr.adoptOrphanedProcess()

        let status = await mgr.serverStatus()
        XCTAssertEqual(status, .running, "Should adopt a live PID as running")
    }

    // MARK: - Crash Recovery: Single auto-restart

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

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)

        // Wait for the auto-restart cycle to complete.
        // The state machine goes: running (spawn #1) → starting (crash) → running (spawn #2).
        let deadline = Date().addingTimeInterval(10)
        var observedCrash = false
        var finalState: ServerState = .running

        while Date() < deadline {
            let current = await mgr.serverStatus()
            if current == .starting {
                observedCrash = true
            } else if current == .running && observedCrash {
                finalState = current
                break
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        XCTAssertTrue(observedCrash, "State should have transitioned to .starting when process crashed")
        XCTAssertEqual(finalState, .running, "Server should be running after auto-restart")

        await mgr.stopServer()
    }

    // MARK: - Crash Recovery: Double crash gives up

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

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)

        // First crash → 3s delay → auto-restart → second crash → error state.
        let deadline = Date().addingTimeInterval(10)
        var finalState: ServerState = .starting
        while Date() < deadline {
            finalState = await mgr.serverStatus()
            if case .error = finalState { break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        guard case .error(let msg) = finalState else {
            XCTFail("Expected .error state after double crash within 30s, got \(finalState)")
            return
        }

        XCTAssertTrue(
            msg.contains("30s"),
            "Error message should mention the 30s crash window. Got: \(msg)"
        )
        XCTAssertEqual(spawnCount, 2, "Should have spawned exactly twice before giving up")

        let pidURL = await mgr.pidFileURL()
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: pidURL.path),
            "PID file should be cleaned up after terminal error state"
        )
    }

    // MARK: - Probe: Detects running server

    func testProbeDetectsRunningServer() async throws {
        let mgr = ProcessManager(koreHome: tmpDir.path)
        mgr._disableHealthPolling = true
        mgr._testHealthCheck = { _ in true }

        await mgr.probeForRunningServer(port: 4000)

        let status = await mgr.serverStatus()
        XCTAssertEqual(status, .running, "Probe should transition to .running when health check passes")

        let port = await mgr.currentPort()
        XCTAssertEqual(port, 4000, "currentPort should reflect the probed port")
    }

    // MARK: - Probe: No-op when already running

    func testProbeNoopWhenAlreadyRunning() async throws {
        let mgr = makeManager()
        await mgr.startServer(clonePath: tmpDir.path, port: 3000)
        let statusBefore = await mgr.serverStatus()
        XCTAssertEqual(statusBefore, .running)

        // Probe at a different port — should be ignored.
        mgr._testHealthCheck = { _ in true }
        await mgr.probeForRunningServer(port: 9999)

        let port = await mgr.currentPort()
        XCTAssertEqual(port, 3000, "Port should not change when probe is no-op")

        await mgr.stopServer()
    }

    // MARK: - Probe: Recovers from .error state

    func testProbeRecoversFromErrorState() async throws {
        // Get into an error state via double-crash.
        var spawnCount = 0
        let mgr = makeManager(spawn: { _, _ in
            spawnCount += 1
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "exit 1"]
            return p
        })

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)

        // Wait for .error state.
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let s = await mgr.serverStatus()
            if case .error = s { break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        let errorState = await mgr.serverStatus()
        guard case .error = errorState else {
            XCTFail("Expected .error state, got \(errorState)")
            return
        }

        // Now probe with a healthy endpoint — should recover.
        mgr._testHealthCheck = { _ in true }
        await mgr.probeForRunningServer(port: 5000)

        let recovered = await mgr.serverStatus()
        XCTAssertEqual(recovered, .running, "Probe should recover from .error to .running")
    }

    // MARK: - Probe: Starts reconnect loop when server not found

    func testProbeStartsReconnectLoopWhenServerNotFound() async throws {
        // Health check starts false, then switches to true.
        let healthy = LockedValue(false)
        let mgr = makeMonitoringManager { _ in healthy.get() }

        // Probe — server not found, reconnect loop should start.
        await mgr.probeForRunningServer(port: 3000)
        let initial = await mgr.serverStatus()
        XCTAssertEqual(initial, .stopped, "Should stay stopped when server not found")

        // Simulate daemon starting — reconnect loop should detect it.
        healthy.set(true)

        let deadline = Date().addingTimeInterval(2)
        var finalState: ServerState = .stopped
        while Date() < deadline {
            finalState = await mgr.serverStatus()
            if finalState == .running { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(finalState, .running, "Reconnect loop should detect the server and transition to .running")
    }

    // MARK: - Reconnect: Recovery from error state

    func testReconnectLoopRecoversFromErrorState() async throws {
        // Start with a healthy daemon, then make it fail, then recover.
        let healthy = LockedValue(true)
        let mgr = makeMonitoringManager { _ in healthy.get() }

        await mgr.probeForRunningServer(port: 3000)
        let initial = await mgr.serverStatus()
        XCTAssertEqual(initial, .running)

        // Make health checks fail — after 3 consecutive failures, goes to .error.
        healthy.set(false)

        let errorDeadline = Date().addingTimeInterval(2)
        while Date() < errorDeadline {
            let s = await mgr.serverStatus()
            if s.isIdle { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let errorState = await mgr.serverStatus()
        XCTAssertTrue(errorState.isIdle, "Should be in an idle state after health failures, got \(errorState)")

        // Restore health — reconnect loop should bring it back to .running.
        healthy.set(true)

        let recoverDeadline = Date().addingTimeInterval(2)
        var recovered: ServerState = errorState
        while Date() < recoverDeadline {
            recovered = await mgr.serverStatus()
            if recovered == .running { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(recovered, .running, "Reconnect loop should recover from error to running")
    }

    // MARK: - Callbacks: onStateChange fires

    func testStateChangeCallbackFires() async throws {
        let mgr = makeManager()
        let states = LockedValue<[ServerState]>([])

        await mgr.setStateChangeCallback { state in
            states.mutate { $0.append(state) }
        }

        await mgr.startServer(clonePath: tmpDir.path, port: 3000)
        await mgr.stopServer()

        // Allow main-queue dispatches to land.
        try await Task.sleep(nanoseconds: 100_000_000)

        let observed = states.get()
        // Expected: .starting → .running → .stopping → .stopped
        XCTAssertTrue(observed.contains(.starting), "Should have observed .starting, got \(observed)")
        XCTAssertTrue(observed.contains(.running), "Should have observed .running, got \(observed)")
        XCTAssertTrue(observed.contains(.stopping), "Should have observed .stopping, got \(observed)")
        XCTAssertTrue(observed.contains(.stopped), "Should have observed .stopped, got \(observed)")
    }

    // MARK: - Callbacks: onHealthPoll fires

    func testHealthPollCallbackFires() async throws {
        let mgr = makeMonitoringManager { _ in true }
        let received = LockedValue<[ServerHealthInfo]>([])

        await mgr.setHealthPollCallback { info in
            received.mutate { $0.append(info) }
        }

        // Probe to get into .running, which starts health polling.
        await mgr.probeForRunningServer(port: 4000)

        // Wait for at least one health poll to fire.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if !received.get().isEmpty { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        let infos = received.get()
        XCTAssertFalse(infos.isEmpty, "onHealthPoll should have been called at least once")
        XCTAssertEqual(infos.first?.port, 4000, "Health info should contain the correct port")
    }

    // MARK: - Port: currentPort reflects last configuration

    func testCurrentPortReflectsLastStart() async throws {
        let mgr = makeManager()

        let defaultPort = await mgr.currentPort()
        XCTAssertEqual(defaultPort, 3000, "Default port should be 3000")

        await mgr.startServer(clonePath: tmpDir.path, port: 8080)
        let portAfterStart = await mgr.currentPort()
        XCTAssertEqual(portAfterStart, 8080, "Port should update to 8080 after starting on that port")

        await mgr.stopServer()
    }

    // MARK: - ServerState.isIdle

    func testIsIdle() {
        XCTAssertTrue(ServerState.stopped.isIdle)
        XCTAssertTrue(ServerState.error("something").isIdle)
        XCTAssertFalse(ServerState.running.isIdle)
        XCTAssertFalse(ServerState.starting.isIdle)
        XCTAssertFalse(ServerState.stopping.isIdle)
    }
}

// MARK: - Thread-safe value wrapper for test assertions

private final class LockedValue<T>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()

    init(_ value: T) { self.value = value }

    func get() -> T {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: T) {
        lock.lock()
        defer { lock.unlock() }
        value = newValue
    }

    func mutate(_ transform: (inout T) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        transform(&value)
    }
}

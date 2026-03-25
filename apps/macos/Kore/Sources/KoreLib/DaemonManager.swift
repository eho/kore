import Foundation
#if canImport(Darwin)
import Darwin
#endif

// MARK: - Daemon State

/// The lifecycle state of the Bun daemon child process.
public enum DaemonState: Equatable, Sendable {
    case stopped
    case starting
    case running
    case stopping
    case error(String)

    public static func == (lhs: DaemonState, rhs: DaemonState) -> Bool {
        switch (lhs, rhs) {
        case (.stopped, .stopped), (.starting, .starting), (.running, .running), (.stopping, .stopping):
            return true
        case (.error(let a), .error(let b)):
            return a == b
        default:
            return false
        }
    }

    /// Short status key for the JS bridge (`"running"`, `"stopped"`, etc.).
    public var statusKey: String {
        switch self {
        case .stopped:  return "stopped"
        case .starting: return "starting"
        case .running:  return "running"
        case .stopping: return "stopping"
        case .error:    return "error"
        }
    }

    /// The error message for `.error` states, or `nil` for all other states.
    public var errorMessage: String? {
        if case .error(let msg) = self { return msg }
        return nil
    }
}

// MARK: - Log Capture

/// Thread-safe, append-only log writer for daemon stdout/stderr output.
private final class LogCapture: @unchecked Sendable {
    private let logURL: URL
    private let queue = DispatchQueue(label: "com.kore.daemon.log", qos: .utility)

    init(koreHome: String) {
        let expanded = (koreHome as NSString).expandingTildeInPath
        let logsDir = URL(fileURLWithPath: expanded).appendingPathComponent("logs")
        logURL = logsDir.appendingPathComponent("daemon.log")

        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
    }

    private let stderrLock = NSLock()
    private var _stderrBuffer = Data()

    var lastStderr: String {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        return String(data: _stderrBuffer, encoding: .utf8) ?? ""
    }

    func clearStderr() {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        _stderrBuffer.removeAll()
    }

    /// Attaches readability handlers to the given pipes to forward output to the log file.
    func attach(stdout: Pipe, stderr: Pipe) {
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.append(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty {
                self?.append(data)
                self?.appendStderr(data)
            }
        }
    }

    /// Removes readability handlers to stop forwarding output.
    func detach(stdout: Pipe, stderr: Pipe) {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
    }

    private func append(_ data: Data) {
        queue.async { [logURL] in
            guard let handle = try? FileHandle(forWritingTo: logURL) else { return }
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            handle.write(data)
        }
    }

    private func appendStderr(_ data: Data) {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        _stderrBuffer.append(data)
        // Keep last ~4KB to avoid unbounded memory growth
        if _stderrBuffer.count > 4096 {
            _stderrBuffer = _stderrBuffer.suffix(4096)
        }
    }
}

// MARK: - Health Info

/// Snapshot of a successful daemon health check, passed to `onHealthPoll`.
public struct DaemonHealthInfo: Sendable {
    public let date: Date
    public let port: Int
}

// MARK: - DaemonManager

/// Manages the Bun daemon child process lifecycle: start, stop, restart,
/// health polling, crash recovery, PID file tracking, and log capture.
///
/// All public methods are `async` and must be called with `await`. For synchronous
/// termination at app shutdown, use `terminateSync()`.
public actor DaemonManager {

    // MARK: - State

    /// The current lifecycle state of the daemon.
    private(set) public var state: DaemonState = .stopped

    private var process: Process?
    private var adoptedPID: pid_t?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?

    private var healthPollTask: Task<Void, Never>?
    private var consecutiveHealthFailures = 0

    /// Polls the health endpoint while stopped, waiting for an externally-started daemon.
    private var reconnectTask: Task<Void, Never>?

    /// Timestamp of the first unexpected crash in the current restart window.
    private var firstCrashTime: Date?

    private var lastClonePath: String?
    private var lastPort: Int = 3000

    let koreHome: String
    private let logCapture: LogCapture

    /// Called on every state transition, dispatched to the main queue.
    /// Assign this in `BridgeHandler` to push status updates to the JS layer.
    public var onStateChange: (@Sendable (DaemonState) -> Void)?

    /// Called on each successful health check, dispatched to the main queue.
    public var onHealthPoll: (@Sendable (DaemonHealthInfo) -> Void)?

    /// Internal: overrides the real process spawn for unit tests.
    /// The closure receives `(clonePath, port)` and returns a configured-but-not-yet-run `Process`.
    /// Set this before calling `startDaemon`. Safe because it is only written before actor
    /// isolation begins in tests.
    nonisolated(unsafe) var _testSpawn: ((_ clonePath: String, _ port: Int) -> Process?)? = nil

    /// Internal: disables health polling (5-second timer loop) for unit tests.
    /// Set this before calling `startDaemon`.
    nonisolated(unsafe) var _disableHealthPolling: Bool = false

    // MARK: - Init

    /// Creates a `DaemonManager` for the given `koreHome` directory.
    /// After calling `init`, call `adoptOrphanedProcess()` to pick up any running daemon
    /// left over from a previous app session.
    public init(koreHome: String) {
        self.koreHome = koreHome
        self.logCapture = LogCapture(koreHome: koreHome)
    }

    // MARK: - Startup Adoption

    /// Checks `$KORE_HOME/.daemon.pid` for a leftover daemon process.
    /// If the process is still alive, adopts it and begins health polling.
    /// If the PID file is stale (process dead), removes it.
    /// Call once after `init` (actors cannot run async work in their initializer).
    public func adoptOrphanedProcess() {
        let pidURL = pidFileURL()

        guard
            let pidString = try? String(contentsOf: pidURL, encoding: .utf8),
            let pid = pid_t(pidString.trimmingCharacters(in: .whitespacesAndNewlines))
        else {
            return
        }

        if kill(pid, 0) == 0 {
            // Process is alive — adopt it and begin health polling.
            adoptedPID = pid
            transition(to: .running)
            startHealthPolling()
        } else {
            // Stale PID file — remove it.
            try? FileManager.default.removeItem(at: pidURL)
        }
    }

    /// Probes the health endpoint at `port` to detect a daemon that was started
    /// outside of the macOS app (no PID file). If responsive, transitions to
    /// `.running` and begins health polling.
    ///
    /// No-op if the daemon is already in a non-stopped state.
    public func probeForRunningDaemon(port: Int) async {
        guard case .stopped = state else { return }
        lastPort = port
        let healthy = await checkHealthEndpoint(port: port)
        guard case .stopped = state else { return }  // recheck after await
        if healthy {
            transition(to: .running)
            startHealthPolling()
        } else {
            // Daemon not found yet — start background probing so the icon
            // updates automatically when the daemon is started later.
            startReconnectProbing()
        }
    }

    // MARK: - Public API

    /// Starts the daemon by spawning `bun run start` at `clonePath` on `port`.
    /// No-op if the daemon is already running or starting.
    public func startDaemon(clonePath: String, port: Int) async {
        guard case .stopped = state else { return }

        lastClonePath = clonePath
        lastPort = port

        transition(to: .starting)
        await spawnDaemon(clonePath: clonePath, port: port, isRestart: false)
    }

    /// Sends SIGTERM to the daemon (then SIGKILL after 5 seconds if needed),
    /// cancels health polling, removes the PID file, and transitions to `.stopped`.
    /// No-op if the daemon is already stopped.
    public func stopDaemon() async {
        guard state == .running || state == .starting else { return }

        healthPollTask?.cancel()
        healthPollTask = nil
        firstCrashTime = nil

        transition(to: .stopping)
        await terminateActiveProcess()
        deletePIDFile()
        transition(to: .stopped)
    }

    /// Stops, then restarts the daemon with the last-used `clonePath` and `port`.
    public func restartDaemon() async {
        await stopDaemon()
        guard let clonePath = lastClonePath else {
            transition(to: .error("Cannot restart: no previous clone path recorded."))
            return
        }
        await startDaemon(clonePath: clonePath, port: lastPort)
    }

    /// Returns the current daemon lifecycle state.
    public func daemonStatus() -> DaemonState {
        state
    }

    /// Returns the port the daemon is (or was last) listening on.
    public func currentPort() -> Int { lastPort }

    /// Registers the state-change callback (actor-safe alternative to direct property assignment).
    public func setStateChangeCallback(_ callback: (@Sendable (DaemonState) -> Void)?) {
        onStateChange = callback
    }

    /// Registers the health-poll callback (actor-safe alternative to direct property assignment).
    public func setHealthPollCallback(_ callback: (@Sendable (DaemonHealthInfo) -> Void)?) {
        onHealthPoll = callback
    }

    /// Synchronously stops the daemon. Safe to call from `applicationWillTerminate`
    /// where an async context is unavailable.
    public nonisolated func terminateSync() {
        let sema = DispatchSemaphore(value: 0)
        Task {
            await self.stopDaemon()
            sema.signal()
        }
        _ = sema.wait(timeout: .now() + 8)
    }

    // MARK: - Private: Spawning

    private func spawnDaemon(clonePath: String, port: Int, isRestart: Bool) async {

        if let testSpawn = _testSpawn {
            // Test override: bypass bun/clone-path validation entirely.
            guard let proc = testSpawn(clonePath, port) else {
                transition(to: .error("Test spawn returned nil."))
                return
            }
            attachAndRun(proc, port: port, isRestart: isRestart)
            return
        }

        // Resolve the bun binary via common paths or login-shell fallback.
        let bunPath: String
        do {
            bunPath = try checkBunInstalled()
        } catch {
            transition(to: .error("Bun is not installed. Install it from bun.sh."))
            return
        }

        // Validate that the clone path contains apps/core-api/.
        let expanded = (clonePath as NSString).expandingTildeInPath
        let coreAPI = URL(fileURLWithPath: expanded).appendingPathComponent("apps/core-api")
        guard FileManager.default.fileExists(atPath: coreAPI.path) else {
            transition(to: .error(
                "Kore clone not found at \(clonePath). Update the clone path in Settings."
            ))
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Use a login shell so ~/.zshrc / ~/.bash_profile are sourced and PATH is inherited.
        proc.arguments = ["-l", "-c", "\"\(bunPath)\" run start"]
        proc.currentDirectoryURL = coreAPI

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        proc.environment = env

        attachAndRun(proc, port: port, isRestart: isRestart)
    }

    /// Attaches stdout/stderr pipes, registers a termination handler, runs the
    /// process, writes the PID file, and transitions to `.running`.
    private func attachAndRun(_ proc: Process, port: Int, isRestart: Bool) {
        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr

        logCapture.clearStderr()
        logCapture.attach(stdout: stdout, stderr: stderr)

        proc.terminationHandler = { [weak self] terminated in
            guard let self else { return }
            Task { await self.handleTermination(of: terminated, isRestart: isRestart) }
        }

        do {
            try proc.run()
        } catch {
            logCapture.detach(stdout: stdout, stderr: stderr)
            transition(to: .error("Failed to launch process: \(error.localizedDescription)"))
            return
        }

        process = proc
        stdoutPipe = stdout
        stderrPipe = stderr

        writePIDFile(pid: proc.processIdentifier)
        transition(to: .running)
        startHealthPolling()
    }

    // MARK: - Private: Termination Handling

    private func handleTermination(of proc: Process, isRestart: Bool) async {
        // Intentional stop in progress — `stopDaemon()` manages the state transition.
        if case .stopping = state { return }

        healthPollTask?.cancel()
        healthPollTask = nil
        consecutiveHealthFailures = 0

        if let out = stdoutPipe, let err = stderrPipe {
            logCapture.detach(stdout: out, stderr: err)
        }
        stdoutPipe = nil
        stderrPipe = nil
        process = nil

        let exitCode = proc.terminationStatus
        let now = Date()

        // Double-crash guard: if the daemon crashed again within 30 seconds of the
        // first restart attempt, give up — no infinite restart loops.
        if let firstCrash = firstCrashTime, now.timeIntervalSince(firstCrash) < 30 {
            firstCrashTime = nil
            deletePIDFile()
            
            let stderrStr = logCapture.lastStderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let errSuffix = stderrStr.isEmpty ? "" : "\n\nError output:\n\(stderrStr)"
            
            transition(to: .error(
                "Daemon crashed again within 30 seconds (exit \(exitCode)). " +
                "Not restarting automatically." + errSuffix
            ))
            return
        }

        // Record the first unexpected crash time for the 30-second window check.
        if firstCrashTime == nil {
            firstCrashTime = now
        }

        deletePIDFile()
        transition(to: .starting)

        // Wait 3 seconds before the single auto-restart attempt.
        try? await Task.sleep(nanoseconds: 3_000_000_000)

        guard let clonePath = lastClonePath else {
            transition(to: .error("Cannot auto-restart: clone path is missing."))
            return
        }

        await spawnDaemon(clonePath: clonePath, port: lastPort, isRestart: true)
    }

    // MARK: - Private: Health Polling

    private func startHealthPolling() {
        guard !_disableHealthPolling else { return }

        healthPollTask?.cancel()
        consecutiveHealthFailures = 0

        let port = self.lastPort

        healthPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)  // 5 seconds
                guard !Task.isCancelled, let self else { break }
                await self.performHealthCheck(port: port)
            }
        }
    }

    private func performHealthCheck(port: Int) async {
        guard case .running = state else { return }

        let healthy = await checkHealthEndpoint(port: port)

        if healthy {
            consecutiveHealthFailures = 0
            firstCrashTime = nil  // Clear crash history once the daemon is confirmed healthy.
            let info = DaemonHealthInfo(date: Date(), port: lastPort)
            let cb = onHealthPoll
            DispatchQueue.main.async { cb?(info) }
        } else {
            consecutiveHealthFailures += 1
            if consecutiveHealthFailures >= 3 {
                await handleHealthFailure()
            }
        }
    }

    private nonisolated func checkHealthEndpoint(port: Int) async -> Bool {
        guard let url = URL(string: "http://localhost:\(port)/api/v1/health") else { return false }

        var request = URLRequest(url: url)
        request.timeoutInterval = 5

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
        } catch {
            return false
        }
    }

    private func handleHealthFailure() async {
        healthPollTask?.cancel()
        healthPollTask = nil
        consecutiveHealthFailures = 0

        transition(to: .error("Daemon not responding (3 consecutive health check failures)."))

        // Attempt a graceful stop-then-restart.
        await terminateActiveProcess()
        deletePIDFile()

        guard let clonePath = lastClonePath else { return }

        transition(to: .starting)
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await spawnDaemon(clonePath: clonePath, port: lastPort, isRestart: true)
    }

    // MARK: - Private: Process Termination

    private func terminateActiveProcess() async {
        if let proc = process, proc.isRunning {
            proc.terminate()  // SIGTERM

            let deadline = Date().addingTimeInterval(5)
            while proc.isRunning && Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)  // 100 ms poll
            }
            if proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
            process = nil

        } else if let pid = adoptedPID {
            kill(pid, SIGTERM)
            let deadline = Date().addingTimeInterval(5)
            while kill(pid, 0) == 0 && Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
            adoptedPID = nil
        }
    }

    // MARK: - Private: Reconnect Probing

    /// Starts a loop that probes the health endpoint every 10 seconds while the
    /// daemon is stopped, so a daemon started after the app launches is detected.
    private func startReconnectProbing() {
        guard !_disableHealthPolling else { return }

        reconnectTask?.cancel()
        let port = lastPort

        reconnectTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)  // 10 seconds
                guard !Task.isCancelled, let self else { break }
                await self.performReconnectProbe(port: port)
            }
        }
    }

    private func performReconnectProbe(port: Int) async {
        // Continue probing from both .stopped and .error (externally-managed daemon
        // that stopped responding may be restarted by the user at any time).
        switch state {
        case .stopped, .error: break
        default:
            reconnectTask?.cancel()
            reconnectTask = nil
            return
        }
        let healthy = await checkHealthEndpoint(port: port)
        switch state {
        case .stopped, .error: break
        default: return
        }
        if healthy {
            reconnectTask?.cancel()
            reconnectTask = nil
            transition(to: .running)
            startHealthPolling()
        }
    }

    // MARK: - Private: State Transitions

    private func transition(to newState: DaemonState) {
        state = newState
        // Start reconnect probing when idle or errored; cancel when daemon is active.
        switch newState {
        case .stopped, .error:
            startReconnectProbing()
        default:
            reconnectTask?.cancel()
            reconnectTask = nil
        }
        let callback = onStateChange
        DispatchQueue.main.async {
            callback?(newState)
        }
    }

    // MARK: - PID File (internal visibility for unit tests)

    func pidFileURL() -> URL {
        let expanded = (koreHome as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded).appendingPathComponent(".daemon.pid")
    }

    private func writePIDFile(pid: Int32) {
        let url = pidFileURL()
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? String(pid).write(to: url, atomically: true, encoding: .utf8)
    }

    func deletePIDFile() {
        try? FileManager.default.removeItem(at: pidFileURL())
    }
}

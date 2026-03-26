import Foundation
#if canImport(Darwin)
import Darwin
#endif

// MARK: - Server State

/// The lifecycle state of the Bun server child process.
public enum ServerState: Equatable, Sendable {
    case stopped
    case starting
    case running
    case stopping
    case error(String)

    public static func == (lhs: ServerState, rhs: ServerState) -> Bool {
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

    /// SF Symbol name for the menu bar icon.
    public var symbolName: String {
        switch self {
        case .running:              return "circle.fill"
        case .stopped:              return "circle"
        case .starting, .stopping:  return "ellipsis.circle"
        case .error:                return "exclamationmark.circle"
        }
    }

    /// `true` when the server is idle (`.stopped` or `.error`) and eligible
    /// for reconnect probing. Centralizes the state guard used by the
    /// reconnect loop and probe logic.
    public var isIdle: Bool {
        switch self {
        case .stopped, .error: return true
        default: return false
        }
    }
}

// MARK: - Log Capture

/// Thread-safe, append-only log writer for server stdout/stderr output.
private final class LogCapture: @unchecked Sendable {
    private let logURL: URL
    private let queue = DispatchQueue(label: "com.kore.server.log", qos: .utility)

    init(koreHome: String) {
        let expanded = (koreHome as NSString).expandingTildeInPath
        let logsDir = URL(fileURLWithPath: expanded).appendingPathComponent("logs")
        logURL = logsDir.appendingPathComponent("server.log")

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

// MARK: - Process Ownership

/// How the app relates to the running server process.
public enum ProcessOwnership: Equatable, Sendable {
    /// We spawned this process — we own it, will kill on quit.
    case spawned

    /// Found via PID file from a previous app session — treat as owned.
    /// Adoption requires BOTH: (1) kill(pid, 0) confirms process alive,
    /// AND (2) health endpoint responds with valid Kore status.
    /// This prevents adopting a random process after PID reuse (e.g., reboot).
    case adopted

    /// Found via health probe only (no PID file) — monitor, don't kill.
    case observed

    /// No server detected.
    case none

    /// Short key for the JS bridge.
    public var statusKey: String {
        switch self {
        case .spawned:  return "spawned"
        case .adopted:  return "adopted"
        case .observed: return "observed"
        case .none:     return "none"
        }
    }
}

// MARK: - Health Info

/// Snapshot of a successful server health check, passed to `onHealthPoll`.
public struct ServerHealthInfo: Sendable {
    public let date: Date
    public let port: Int
}

// MARK: - ProcessManager

/// Manages the Bun server child process lifecycle: start, stop, restart,
/// health polling, crash recovery, PID file tracking, and log capture.
///
/// All public methods are `async` and must be called with `await`. For synchronous
/// termination at app shutdown, use `terminateSync()`.
public actor ProcessManager {

    // MARK: - Constants

    /// Interval between health endpoint polls while the server is running.
    private static let healthPollInterval: UInt64 = 5_000_000_000      // 5 seconds

    /// Interval between reconnect probes while the server is idle.
    private static let reconnectInterval: UInt64 = 10_000_000_000      // 10 seconds

    /// Delay before auto-restart after an unexpected crash.
    private static let restartDelay: UInt64 = 3_000_000_000            // 3 seconds

    /// If the server crashes again within this window after a restart,
    /// auto-restart is abandoned to avoid infinite loops.
    private static let crashWindowSeconds: TimeInterval = 30

    /// Number of consecutive health check failures before declaring the server
    /// unresponsive and triggering recovery.
    private static let maxHealthFailures = 3

    // MARK: - State

    /// The current lifecycle state of the server.
    private(set) public var state: ServerState = .stopped

    /// How the app relates to the current server process.
    private(set) public var ownership: ProcessOwnership = .none

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
    public var onStateChange: (@Sendable (ServerState) -> Void)?

    /// Called on each successful health check, dispatched to the main queue.
    public var onHealthPoll: (@Sendable (ServerHealthInfo) -> Void)?

    /// Internal: overrides the real process spawn for unit tests.
    /// The closure receives `(clonePath, port)` and returns a configured-but-not-yet-run `Process`.
    /// Set this before calling `startServer`. Safe because it is only written before actor
    /// isolation begins in tests.
    nonisolated(unsafe) var _testSpawn: ((_ clonePath: String, _ port: Int) -> Process?)? = nil

    /// Internal: disables health polling and reconnect probing for unit tests
    /// that only care about process lifecycle, not monitoring.
    nonisolated(unsafe) var _disableHealthPolling: Bool = false

    /// Internal: overrides `checkHealthEndpoint` for unit tests so probing and
    /// health polling work without a real HTTP server.
    nonisolated(unsafe) var _testHealthCheck: ((_ port: Int) async -> Bool)? = nil

    /// Internal: overrides the poll/reconnect sleep intervals for fast tests.
    /// Defaults to `nil`, which uses the production intervals (5s health, 10s reconnect).
    nonisolated(unsafe) var _testPollIntervalNs: UInt64? = nil

    // MARK: - Init

    /// Creates a `ProcessManager` for the given `koreHome` directory.
    /// After calling `init`, call `adoptOrphanedProcess()` to pick up any running server
    /// left over from a previous app session.
    public init(koreHome: String) {
        self.koreHome = koreHome
        self.logCapture = LogCapture(koreHome: koreHome)
    }

    // MARK: - Startup Adoption

    /// Checks `$KORE_HOME/.kore.pid` for a leftover server process.
    /// If the process is still alive AND the health endpoint responds, adopts it
    /// (ownership = `.adopted`) and begins health polling.
    /// If the PID file points to a live process but health fails, deletes the PID
    /// file as stale (PID reuse safety).
    /// If the PID is dead, removes the PID file.
    /// Call once after `init` (actors cannot run async work in their initializer).
    public func adoptOrphanedProcess(port: Int? = nil) async {
        let pidURL = pidFileURL()
        let healthPort = port ?? lastPort

        guard
            let pidString = try? String(contentsOf: pidURL, encoding: .utf8),
            let pid = pid_t(pidString.trimmingCharacters(in: .whitespacesAndNewlines))
        else {
            return
        }

        if kill(pid, 0) == 0 {
            // Process is alive — verify via health endpoint before adopting.
            let healthy = await checkHealthEndpoint(port: healthPort)
            if healthy {
                adoptedPID = pid
                ownership = .adopted
                transition(to: .running)
                startHealthPolling()
                print("[Kore] Ownership: adopted (source: PID file)")
            } else {
                // PID alive but not a Kore server — stale PID file (PID reuse).
                try? FileManager.default.removeItem(at: pidURL)
                print("[Kore] Stale PID file removed (pid \(pid) not Kore — health check failed)")
            }
        } else {
            // Stale PID file — process is dead, remove it.
            try? FileManager.default.removeItem(at: pidURL)
        }
    }

    /// Probes the health endpoint at `port` to detect a server that was started
    /// outside of the macOS app (no PID file). If responsive, transitions to
    /// `.running` and begins health polling.
    ///
    /// No-op if the server is already in a non-stopped state.
    /// Probes the health endpoint at `port` to detect a server that was started
    /// outside of the macOS app (no PID file). If responsive, transitions to
    /// `.running` and begins health polling. If not, starts the background
    /// reconnect loop so the server is detected when it appears later.
    ///
    /// No-op if the server is already in an active state (`.running`, `.starting`, `.stopping`).
    public func probeForRunningServer(port: Int) async {
        guard state.isIdle else { return }
        lastPort = port
        let healthy = await checkHealthEndpoint(port: port)
        guard state.isIdle else { return }  // recheck after async gap
        if healthy {
            ownership = .observed
            transition(to: .running)
            startHealthPolling()
            print("[Kore] External server detected on :\(port) (monitoring only)")
        } else {
            // Server not found yet — start background probing so the icon
            // updates automatically when the server is started later.
            startReconnectProbing()
        }
    }

    // MARK: - Public API

    /// Starts the server by spawning `bun run start` at `clonePath` on `port`.
    /// No-op if the server is already running or starting.
    public func startServer(clonePath: String, port: Int) async {
        guard case .stopped = state else { return }

        lastClonePath = clonePath
        lastPort = port

        transition(to: .starting)
        await spawnServer(clonePath: clonePath, port: port, isRestart: false)
    }

    /// Stops the server with ownership-aware behavior:
    /// - `.spawned`/`.adopted`: sends SIGTERM/SIGKILL, deletes PID file
    /// - `.observed`: transitions to `.stopped` without sending any signal
    /// - `.none`: no-op
    /// Resets `ownership` to `.none` in all cases.
    public func stopServer() async {
        guard state == .running || state == .starting else { return }

        healthPollTask?.cancel()
        healthPollTask = nil
        firstCrashTime = nil

        switch ownership {
        case .spawned, .adopted:
            transition(to: .stopping)
            await terminateActiveProcess()
            deletePIDFile()
            ownership = .none
            transition(to: .stopped)

        case .observed:
            ownership = .none
            transition(to: .stopped)

        case .none:
            break
        }
    }

    /// Stops, then restarts the server with the last-used `clonePath` and `port`.
    public func restartServer() async {
        await stopServer()
        guard let clonePath = lastClonePath else {
            transition(to: .error("Cannot restart: no previous clone path recorded."))
            return
        }
        await startServer(clonePath: clonePath, port: lastPort)
    }

    /// Returns the current server lifecycle state.
    public func serverStatus() -> ServerState {
        state
    }

    /// Returns the port the server is (or was last) listening on.
    public func currentPort() -> Int { lastPort }

    /// Whether the server was started or adopted by this app.
    /// When `false`, the server was detected via health probe only — Stop/Restart won't work.
    public func isManaged() -> Bool {
        ownership == .spawned || ownership == .adopted
    }

    /// Registers the state-change callback (actor-safe alternative to direct property assignment).
    public func setStateChangeCallback(_ callback: (@Sendable (ServerState) -> Void)?) {
        onStateChange = callback
    }

    /// Registers the health-poll callback (actor-safe alternative to direct property assignment).
    public func setHealthPollCallback(_ callback: (@Sendable (ServerHealthInfo) -> Void)?) {
        onHealthPoll = callback
    }

    /// Synchronously stops the server. Safe to call from `applicationWillTerminate`
    /// where an async context is unavailable.
    /// Skips termination when `ownership == .observed` — the external server continues running.
    public nonisolated func terminateSync() {
        let sema = DispatchSemaphore(value: 0)
        Task {
            let own = await self.ownership
            if own == .observed {
                print("[Kore] Quitting — leaving external server running")
                sema.signal()
                return
            }
            await self.stopServer()
            sema.signal()
        }
        _ = sema.wait(timeout: .now() + 8)
    }

    // MARK: - Private: Spawning

    private func spawnServer(clonePath: String, port: Int, isRestart: Bool) async {

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
        ownership = .spawned
        transition(to: .running)
        startHealthPolling()
    }

    // MARK: - Private: Termination Handling

    private func handleTermination(of proc: Process, isRestart: Bool) async {
        // Intentional stop in progress — `stopServer()` manages the state transition.
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

        // Double-crash guard: if the server crashed again within the crash window
        // of the first restart attempt, give up — no infinite restart loops.
        if let firstCrash = firstCrashTime, now.timeIntervalSince(firstCrash) < Self.crashWindowSeconds {
            firstCrashTime = nil
            deletePIDFile()
            ownership = .none

            let stderrStr = logCapture.lastStderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let errSuffix = stderrStr.isEmpty ? "" : "\n\nError output:\n\(stderrStr)"
            
            transition(to: .error(
                "Server crashed again within \(Int(Self.crashWindowSeconds))s (exit \(exitCode)). " +
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
        try? await Task.sleep(nanoseconds: Self.restartDelay)

        guard let clonePath = lastClonePath else {
            transition(to: .error("Cannot auto-restart: clone path is missing."))
            return
        }

        await spawnServer(clonePath: clonePath, port: lastPort, isRestart: true)
    }

    // MARK: - Private: Health Polling

    private func startHealthPolling() {
        guard !_disableHealthPolling else { return }

        healthPollTask?.cancel()
        consecutiveHealthFailures = 0

        let port = self.lastPort
        let interval = _testPollIntervalNs ?? Self.healthPollInterval

        healthPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval)
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
            firstCrashTime = nil  // Clear crash history once the server is confirmed healthy.
            let info = ServerHealthInfo(date: Date(), port: lastPort)
            let cb = onHealthPoll
            DispatchQueue.main.async { cb?(info) }
        } else {
            consecutiveHealthFailures += 1
            if consecutiveHealthFailures >= Self.maxHealthFailures {
                await handleHealthFailure()
            }
        }
    }

    private nonisolated func checkHealthEndpoint(port: Int) async -> Bool {
        if let testCheck = _testHealthCheck {
            return await testCheck(port)
        }

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

        transition(to: .error("Server not responding (3 consecutive health check failures)."))

        // Attempt a graceful stop-then-restart.
        await terminateActiveProcess()
        deletePIDFile()

        guard let clonePath = lastClonePath else { return }

        transition(to: .starting)
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await spawnServer(clonePath: clonePath, port: lastPort, isRestart: true)
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
    /// server is stopped, so a server started after the app launches is detected.
    private func startReconnectProbing() {
        guard !_disableHealthPolling else { return }

        reconnectTask?.cancel()
        let port = lastPort
        let interval = _testPollIntervalNs ?? Self.reconnectInterval

        reconnectTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval)
                guard !Task.isCancelled, let self else { break }
                await self.performReconnectProbe(port: port)
            }
        }
    }

    private func performReconnectProbe(port: Int) async {
        guard state.isIdle else {
            reconnectTask?.cancel()
            reconnectTask = nil
            return
        }
        let healthy = await checkHealthEndpoint(port: port)
        guard state.isIdle else { return }  // recheck after async gap
        if healthy {
            reconnectTask?.cancel()
            reconnectTask = nil
            ownership = .observed
            transition(to: .running)
            startHealthPolling()
            print("[Kore] External server detected on :\(port) (monitoring only)")
        }
    }

    // MARK: - Private: State Transitions

    private func transition(to newState: ServerState) {
        state = newState
        // Start reconnect probing when idle; cancel when server is active.
        if newState.isIdle {
            startReconnectProbing()
        } else {
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
        return URL(fileURLWithPath: expanded).appendingPathComponent(".kore.pid")
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

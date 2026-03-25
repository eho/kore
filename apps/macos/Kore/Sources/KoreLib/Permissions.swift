import AppKit
import Foundation

// MARK: - Permission Status

public enum PermissionStatus: String {
    case granted
    case denied
    case unknown
}

// MARK: - Permissions

public struct Permissions {
    /// The Apple Notes TCC-protected database directory path.
    private static let notesDatabaseDir =
        "~/Library/Group Containers/group.com.apple.notes"

    /// Attempts to list the Apple Notes database directory to detect TCC status.
    /// Returns `.granted` if readable, `.denied` if access is blocked, `.unknown` otherwise.
    public static func checkNotesAccess() -> PermissionStatus {
        let path = (notesDatabaseDir as NSString).expandingTildeInPath
        let fm = FileManager.default

        // Attempt to list directory contents — this triggers TCC check.
        do {
            _ = try fm.contentsOfDirectory(atPath: path)
            return .granted
        } catch let error as NSError {
            // EPERM (1) or EACCES (13) indicate TCC denial.
            let posixCode = error.userInfo[NSUnderlyingErrorKey] as? NSError
            let code = posixCode?.code ?? error.code
            if code == Int(EPERM) || code == Int(EACCES) || error.domain == NSCocoaErrorDomain {
                return .denied
            }
            // Directory doesn't exist or other error — treat as unknown.
            return .unknown
        }
    }

    /// Opens the Full Disk Access pane in System Settings.
    public static func openFDASettings() throws {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllDiskAccess") else {
            throw PermissionsError.invalidURL
        }
        NSWorkspace.shared.open(url)
    }
}

// MARK: - System Checks

/// Checks whether Bun is installed by probing common installation paths.
/// Returns the resolved path to the `bun` binary, or throws if not found.
public func checkBunInstalled() throws -> String {
    let commonPaths = [
        ("~/.bun/bin/bun" as NSString).expandingTildeInPath,
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
        "/usr/bin/bun",
    ]

    let fm = FileManager.default
    for path in commonPaths {
        if fm.isExecutableFile(atPath: path) {
            return path
        }
    }

    // Fall back to `which bun` via login shell to handle non-standard installs.
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-l", "-c", "which bun"]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    try process.run()
    process.waitUntilExit()

    if process.terminationStatus == 0 {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !path.isEmpty {
            return path
        }
    }

    throw PermissionsError.bunNotFound
}

/// Checks whether Ollama is reachable at the given base URL.
/// Returns `true` if the API responds successfully, `false` otherwise.
public func checkOllamaRunning(url: String) async throws -> Bool {
    guard let baseURL = URL(string: url) else {
        throw PermissionsError.invalidURL
    }
    let endpoint = baseURL.appendingPathComponent("api/tags")

    var request = URLRequest(url: endpoint)
    request.httpMethod = "GET"
    request.timeoutInterval = 5

    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            return (200...299).contains(http.statusCode)
        }
        return false
    } catch {
        return false
    }
}

// MARK: - Errors

public enum PermissionsError: LocalizedError {
    case bunNotFound
    case invalidURL

    public var errorDescription: String? {
        switch self {
        case .bunNotFound:
            return "Bun is not installed. Install it from bun.sh."
        case .invalidURL:
            return "Invalid URL."
        }
    }
}

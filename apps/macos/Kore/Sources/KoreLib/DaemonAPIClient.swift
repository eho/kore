import Foundation

/// Result of a daemon API call.
public enum APIResult: Equatable, Sendable {
    case success(Int)       // HTTP status code
    case httpError(Int)     // Non-2xx status code
    case networkError(String)
    case notRunning         // Daemon state is not .running
}

/// Lightweight client for calling the Kore daemon's HTTP API.
///
/// All methods are `async` and safe to call from any context. The client is
/// a value type — create one with the current port and token, call it, done.
public struct DaemonAPIClient: Sendable {
    public let port: Int
    public let apiKey: String?

    public init(port: Int, apiKey: String? = nil) {
        self.port = port
        self.apiKey = apiKey
    }

    /// Convenience: builds a client from the current `ConfigManager` state.
    public static func fromConfig(koreHome: String) -> DaemonAPIClient {
        let config = (try? ConfigManager.readConfig(koreHome: koreHome)) ?? .defaults
        return DaemonAPIClient(port: config.port ?? 3000, apiKey: config.apiKey)
    }

    // MARK: - High-level Actions

    /// Triggers an Apple Notes sync cycle.
    /// Calls `POST /api/v1/plugins/apple-notes/sync`.
    public func syncAppleNotes() async -> APIResult {
        await post(path: "/api/v1/plugins/apple-notes/sync")
    }

    /// Triggers a consolidation cycle.
    /// Calls `POST /api/v1/consolidate`.
    public func triggerConsolidation() async -> APIResult {
        await post(path: "/api/v1/consolidate")
    }

    /// Checks whether the daemon health endpoint responds with 2xx.
    /// Calls `GET /api/v1/health`.
    public func healthCheck() async -> APIResult {
        await request(method: "GET", path: "/api/v1/health")
    }

    // MARK: - Transport

    /// Sends a POST request with an empty JSON body.
    public func post(path: String, body: [String: Any]? = nil) async -> APIResult {
        await request(method: "POST", path: path, body: body)
    }

    /// Sends an HTTP request to `http://localhost:{port}{path}`.
    public func request(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        timeout: TimeInterval = 10
    ) async -> APIResult {
        guard let url = URL(string: "http://localhost:\(port)\(path)") else {
            return .networkError("Invalid URL: \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout

        if let apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        if let body, method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .networkError("Non-HTTP response")
            }
            if (200...299).contains(http.statusCode) {
                return .success(http.statusCode)
            } else {
                return .httpError(http.statusCode)
            }
        } catch {
            return .networkError(error.localizedDescription)
        }
    }
}

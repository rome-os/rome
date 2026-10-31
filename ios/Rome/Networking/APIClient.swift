import Foundation

enum APIError: Error, Equatable, LocalizedError {
    /// The instance session is missing or expired.
    case unauthorized
    /// Concierge is turned off on this instance.
    case conciergeOff
    case notFound
    case server(status: Int, message: String?)
    case offline
    case network
    case decoding

    var errorDescription: String? {
        switch self {
        case .unauthorized: return String(localized: "Session expired")
        case .conciergeOff: return String(localized: "Concierge is off")
        case .notFound: return String(localized: "Not found")
        case .server(_, let message): return message ?? String(localized: "Server error")
        case .offline: return String(localized: "No network connection")
        case .network: return String(localized: "Could not reach your Rome")
        case .decoding: return String(localized: "Could not read the response")
        }
    }
}

/// HTTP to one Rome instance. It sends the instance session as the
/// `rome_session` cookie, only to its own origin, and never follows redirects.
final class APIClient: Sendable {
    let origin: URL
    private let token: @Sendable () -> String?
    private let session: URLSession
    private let onUnauthorized: @Sendable () -> Void

    init(origin: URL, token: @escaping @Sendable () -> String?, onUnauthorized: @escaping @Sendable () -> Void = {}) {
        self.origin = origin
        self.token = token
        self.onUnauthorized = onUnauthorized
        let configuration = URLSessionConfiguration.default
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        let data = try await send(request(path, query: query, method: "GET"))
        return try decode(data)
    }

    @discardableResult
    func post(_ path: String, json: JSONValue? = nil) async throws -> Data {
        var request = request(path, method: "POST")
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(json)
        }
        return try await send(request)
    }

    func post<T: Decodable>(_ path: String, json: JSONValue? = nil, as type: T.Type) async throws -> T {
        try decode(try await post(path, json: json))
    }

    @discardableResult
    func put(_ path: String, json: JSONValue) async throws -> Data {
        var request = request(path, method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(json)
        return try await send(request)
    }

    @discardableResult
    func patch(_ path: String, json: JSONValue) async throws -> Data {
        var request = request(path, method: "PATCH")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(json)
        return try await send(request)
    }

    /// A request carrying the session cookie, for the live-events socket.
    func socketRequest(_ path: String) -> URLRequest {
        var components = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false)!
        components.scheme = origin.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components.url!)
        if let token = token() {
            request.setValue("rome_session=\(token)", forHTTPHeaderField: "Cookie")
        }
        // The server takes a cookie on the socket only from its own origin.
        request.setValue(Self.originString(origin), forHTTPHeaderField: "Origin")
        return request
    }

    static func originString(_ url: URL) -> String {
        var text = "\(url.scheme ?? "https")://\(url.host() ?? "")"
        if let port = url.port { text += ":\(port)" }
        return text
    }

    private func request(_ path: String, query: [URLQueryItem] = [], method: String) -> URLRequest {
        var components = URLComponents(url: origin.appending(path: "api" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = token() {
            request.setValue("rome_session=\(token)", forHTTPHeaderField: "Cookie")
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                throw APIError.offline
            case .cancelled:
                throw CancellationError()
            default:
                throw APIError.network
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            onUnauthorized()
            throw APIError.unauthorized
        case 404:
            let message = Self.errorMessage(data)
            throw message == "Concierge is off" ? APIError.conciergeOff : APIError.notFound
        default:
            throw APIError.server(status: http.statusCode, message: Self.errorMessage(data))
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    private static func errorMessage(_ data: Data) -> String? {
        (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.string
    }
}

/// Refuses every redirect, so the session cookie never leaves its origin.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

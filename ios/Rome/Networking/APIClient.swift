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
    /// A file past the app's limit, such as an image of more than 20 MB.
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .unauthorized: return String(localized: "Session expired")
        case .conciergeOff: return String(localized: "Chat is off")
        case .notFound: return String(localized: "Not found")
        case .server(_, let message): return message ?? String(localized: "Server error")
        case .offline: return String(localized: "No network connection")
        case .network: return String(localized: "Could not reach your Rome")
        case .decoding: return String(localized: "Could not read the response")
        case .tooLarge: return String(localized: "Too large to show")
        }
    }
}

/// HTTP to one Rome instance. It sends the instance session as its cookie
/// (`rome_session` for the guardian, `rome_visitor` for a visitor, never both),
/// only to its own origin, and never follows redirects.
final class APIClient: Sendable {
    let origin: URL
    private let token: @Sendable () -> String?
    private let cookieName: @Sendable () -> String
    private let session: URLSession
    private let onUnauthorized: @Sendable () -> Void
    /// Renews the session after a 401, and says whether it worked; the
    /// request then goes once more with the new session.
    private let renew: (@Sendable () async -> Bool)?

    /// `configuration`: tests pass one with a stub protocol.
    init(origin: URL, token: @escaping @Sendable () -> String?, cookieName: @escaping @Sendable () -> String = { InstanceSession.guardianCookie }, configuration: URLSessionConfiguration = .default, onUnauthorized: @escaping @Sendable () -> Void = {}, renew: (@Sendable () async -> Bool)? = nil) {
        self.renew = renew
        self.origin = origin
        self.token = token
        self.cookieName = cookieName
        self.onUnauthorized = onUnauthorized
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        // Answers are this account's: never in the shared disk cache, which
        // no sign-out wipes. The app keeps what it needs in its own caches.
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    /// `reportsUnauthorized: false` for probes that expect a 401 now and then,
    /// such as an instance mid-restart; it still throws, but is not taken as an
    /// expired session.
    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self, reportsUnauthorized: Bool = true) async throws -> T {
        let data = try await send(request(path, query: query, method: "GET"), reportsUnauthorized: reportsUnauthorized)
        return try decode(data)
    }

    /// The raw bytes of a GET, for files. Query values are encoded strictly:
    /// a `+` would otherwise reach the server as a space.
    /// `limit`: stop past this many bytes.
    func getData(_ path: String, query: [URLQueryItem] = [], limit: Int? = nil) async throws -> Data {
        var request = request(path, method: "GET")
        if !query.isEmpty, let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.percentEncodedQueryItems = query.map { URLQueryItem(name: $0.name, value: Self.strictQueryValue($0.value ?? "")) }
            request.url = components.url
        }
        return try await send(request, limit: limit)
    }

    /// The bytes behind an `/api/…` URL a reply wrote, sent as written: the
    /// query is not decoded and encoded again.
    func getFile(apiPath: String, percentEncodedQuery: String?) async throws -> Data {
        guard let url = Self.fileURL(origin: origin, apiPath: apiPath, percentEncodedQuery: percentEncodedQuery) else { throw APIError.notFound }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        signIn(&request)
        return try await send(request, limit: Self.imageLimit)
    }

    /// Images past this are not shown: a reply can point at any file.
    static let imageLimit = 20 * 1024 * 1024

    /// A GET's body, stopped as soon as it passes `limit` bytes: the declared
    /// length decides first, the bytes received after.
    static func cappedData(for request: URLRequest, in session: URLSession, limit: Int) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        if response.expectedContentLength > Int64(limit) { throw APIError.tooLarge }
        var data = Data()
        if response.expectedContentLength > 0 { data.reserveCapacity(Int(response.expectedContentLength)) }
        var chunk: [UInt8] = []
        chunk.reserveCapacity(64 * 1024)
        for try await byte in bytes {
            chunk.append(byte)
            if chunk.count == 64 * 1024 {
                data.append(contentsOf: chunk)
                chunk.removeAll(keepingCapacity: true)
                if data.count > limit { throw APIError.tooLarge }
            }
        }
        data.append(contentsOf: chunk)
        if data.count > limit { throw APIError.tooLarge }
        return (data, response)
    }

    /// Always on this client's own origin, so the cookie never leaves it.
    static func fileURL(origin: URL, apiPath: String, percentEncodedQuery: String?) -> URL? {
        guard apiPath.hasPrefix("/") else { return nil }
        var text = originString(origin) + "/api" + apiPath
        if let percentEncodedQuery, !percentEncodedQuery.isEmpty { text += "?" + percentEncodedQuery }
        guard let url = URL(string: text), url.host() == origin.host() else { return nil }
        return url
    }

    /// Percent-encodes everything but unreserved characters and `/`.
    static func strictQueryValue(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
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

    @discardableResult
    func delete(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
        try await send(request(path, query: query, method: "DELETE"))
    }

    /// A request to an `/api/…` path on this instance that answers any status
    /// with its JSON body. The session cookie goes only here: the URL is built
    /// on the instance's origin, never taken whole from a server's answer.
    func exchange(method: String, apiPath: String, json: JSONValue?) async throws -> ConnectReply {
        guard let url = Self.instanceURL(origin: origin, apiPath: apiPath) else { throw APIError.notFound }
        // Built from `url` as it is: going through a path would encode an
        // already-encoded segment, such as a Store app's `@alice%2Fmeals`, twice.
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        signIn(&request)
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(json)
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        if http.statusCode == 401 {
            onUnauthorized()
            throw APIError.unauthorized
        }
        let body = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .object([:])
        return ConnectReply(ok: (200..<300).contains(http.statusCode), body: body)
    }

    /// `apiPath` on the instance, or nil for anything but a plain `/api/…` path.
    static func instanceURL(origin: URL, apiPath: String) -> URL? {
        guard apiPath.hasPrefix("/api/"), !apiPath.contains(".."), !apiPath.contains("//"), !apiPath.contains("?"), !apiPath.contains("#") else { return nil }
        guard let url = URL(string: originString(origin) + apiPath), url.host() == origin.host() else { return nil }
        return url
    }

    /// The live-events socket's upgrade was refused with a 401.
    func reportUnauthorized() { onUnauthorized() }

    /// A GET that finds its pooled connection dead is sent once more. The
    /// first request after the app was suspended often does: the system
    /// closed the connection while the app slept.
    static func data(for request: URLRequest, in session: URLSession) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError where error.code == .networkConnectionLost && request.httpMethod == "GET" {
            return try await session.data(for: request)
        }
    }

    /// The session as a cookie for a web view: scoped to this origin's host
    /// and path `/`, secure on https, so no other site ever receives it, and
    /// HttpOnly as the server sets it, so no page script can read it.
    func sessionCookie() -> HTTPCookie? {
        guard let token = token(), let host = origin.host() else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: host,
            .path: "/",
            .name: cookieName(),
            .value: token,
        ]
        if origin.scheme == "https" { properties[.secure] = "TRUE" }
        properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE"
        return HTTPCookie(properties: properties)
    }

    /// A request carrying the session cookie, for the live-events socket.
    func socketRequest(_ path: String) -> URLRequest {
        var components = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false)!
        components.scheme = origin.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components.url!)
        signIn(&request)
        // The phone app's socket: a chat it subscribes to counts as watched on
        // the guardian's phone, and the Concierge does not push what it says there.
        request.setValue(Self.phoneClient, forHTTPHeaderField: Self.clientHeader)
        return request
    }

    /// Every request to the instance: the session cookie, and the instance's
    /// own origin. The server takes a cookie on the socket, and a change on
    /// guarded routes (approvals, connections), only from its own origin, and
    /// a native request sends none of its own.
    private func signIn(_ request: inout URLRequest) {
        if let token = token() {
            request.setValue("\(cookieName())=\(token)", forHTTPHeaderField: "Cookie")
        }
        request.setValue(Self.originString(origin), forHTTPHeaderField: "Origin")
        DevAccess.stamp(&request)
    }

    /// The live-events upgrade header that marks the phone app's socket.
    static let clientHeader = "x-rome-client"
    static let phoneClient = "phone"

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
        signIn(&request)
        return request
    }

    private func send(_ request: URLRequest, reportsUnauthorized: Bool = true, limit: Int? = nil, retried: Bool = false) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            if let limit {
                (data, response) = try await Self.cappedData(for: request, in: session, limit: limit)
            } else {
                (data, response) = try await Self.data(for: request, in: session)
            }
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
            // A session past its time (a cached launch's, say): renewed, the
            // request goes once more, so a send or a read mark is never lost
            // to a session that was about to be replaced.
            if reportsUnauthorized, !retried, let renew {
                if await renew() {
                    var again = request
                    signIn(&again)
                    return try await send(again, reportsUnauthorized: reportsUnauthorized, limit: limit, retried: true)
                }
                throw APIError.unauthorized
            }
            if reportsUnauthorized { onUnauthorized() }
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

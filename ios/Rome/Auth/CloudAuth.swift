import CryptoKit
import Foundation
import UIKit

// Native sign-in, ported from packages/lib/src/native-auth (RFC 065). Rome Cloud
// signs the device in once (PKCE, ephemeral browser session) and returns a device
// credential. For each instance the app then asks the instance for an
// authorization request, has Cloud authorize it, and trades the code at the
// instance for a `rome_session`.

struct CloudCredential: Codable, Sendable {
    var accessToken: String
    var deviceSessionId: String
}

struct CloudInstance: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var slug: String
    var origin: String
    var status: String

    var isRunning: Bool { status == "running" }
    var host: String { URL(string: origin)?.host() ?? origin }
}

struct InstanceSession: Codable, Sendable {
    var token: String
    var expiresAt: String
    var origin: String

    var isFresh: Bool {
        guard let date = RomeDate.parse(expiresAt) else { return false }
        return date.timeIntervalSinceNow > 30
    }
}

enum AuthError: Error, Equatable, LocalizedError {
    case cancelled
    case cloudUnauthorized
    case instanceNotReady
    case accessDenied
    case sessionRejected
    case network
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .cancelled: return String(localized: "Sign-in canceled")
        case .cloudUnauthorized: return String(localized: "Rome Cloud sign-in expired")
        case .instanceNotReady: return String(localized: "This Rome is not ready yet")
        case .accessDenied: return String(localized: "No access to this Rome")
        case .sessionRejected: return String(localized: "Sign-in did not finish")
        case .network: return String(localized: "Could not reach Rome Cloud")
        case .invalidResponse: return String(localized: "Invalid sign-in response")
        }
    }
}

/// A started Cloud sign-in: the URL to open and what checks its callback.
struct CloudSignInRequest: Sendable {
    let authorizeURL: URL
    let callbackScheme: String
    fileprivate let verifier: String
    fileprivate let state: String
}

@MainActor
final class CloudAuth {
    nonisolated static let clientID = "rome-mobile-ios"
    nonisolated static let redirectURI = "cc.romeos.mobile:/oauth/callback"
    nonisolated static let callbackScheme = "cc.romeos.mobile"

    private enum Key {
        static let credential = "cloud.credential"
        static func session(_ origin: String) -> String { "instance.session.\(origin)" }
    }

    let origin: URL
    private let http: URLSession
    private var inFlight: [String: Task<InstanceSession, Error>] = [:]

    init(origin: URL) {
        self.origin = origin
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        http = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    static var configuredOrigin: URL {
        let value = Bundle.main.object(forInfoDictionaryKey: "RomeCloudOrigin") as? String
        return URL(string: value ?? "") ?? URL(string: "https://romeos.cc")!
    }

    var hasCredential: Bool { Keychain.data(for: Key.credential) != nil }

    // MARK: Cloud sign-in

    func beginSignIn() -> CloudSignInRequest {
        let verifier = Self.randomBase64URL(32)
        let state = Self.randomBase64URL(16)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var components = URLComponents(url: origin.appending(path: "oauth2/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: Self.clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "state", value: state),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "display_name", value: UIDevice.current.name),
        ]
        return CloudSignInRequest(
            authorizeURL: components.url!,
            callbackScheme: Self.callbackScheme,
            verifier: verifier,
            state: state
        )
    }

    /// Checks the browser callback and trades its code for the device credential.
    func completeSignIn(_ request: CloudSignInRequest, callback: URL) async throws {
        let code = try Self.code(from: callback, state: request.state, issuer: origin)
        var form = URLComponents()
        form.queryItems = [
            .init(name: "grant_type", value: "authorization_code"),
            .init(name: "code", value: code),
            .init(name: "code_verifier", value: request.verifier),
            .init(name: "client_id", value: Self.clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "device_model", value: UIDevice.current.model),
            .init(name: "os_version", value: UIDevice.current.systemVersion),
            .init(name: "app_version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String),
        ]
        var urlRequest = URLRequest(url: origin.appending(path: "oauth2/token"))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, status) = try await perform(urlRequest)
        guard (200..<300).contains(status) else { throw AuthError.sessionRejected }
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: data),
              let token = body["access_token"]?.string, !token.isEmpty,
              body["token_type"]?.string == "Bearer",
              let device = body["device_session_id"]?.string, !device.isEmpty
        else { throw AuthError.invalidResponse }
        Keychain.set(CloudCredential(accessToken: token, deviceSessionId: device), for: Key.credential)
    }

    nonisolated static func code(from callback: URL, state: String, issuer: URL) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              callback.scheme == callbackScheme,
              callback.path == "/oauth/callback" || components.path == "/oauth/callback"
        else { throw AuthError.invalidResponse }
        let items = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard items["state"] == state else { throw AuthError.invalidResponse }
        guard items["iss"] == issuer.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) else {
            throw AuthError.invalidResponse
        }
        if items["error"] != nil { throw AuthError.sessionRejected }
        guard let code = items["code"], !code.isEmpty else { throw AuthError.invalidResponse }
        return code
    }

    // MARK: Instances

    func listInstances() async throws -> [CloudInstance] {
        let data = try await cloudRequest("v1/instances")
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: data),
              let items = body["items"]?.array
        else { throw AuthError.invalidResponse }
        return items.compactMap { item in
            guard let instance = item.decoded(CloudInstance.self),
                  let url = URL(string: instance.origin), url.scheme == "https",
                  url.host() != origin.host()
            else { return nil }
            return instance
        }
    }

    /// A fresh session for `instance`: the stored one when it has time left, else a new one.
    func session(for instance: CloudInstance, forceRefresh: Bool = false) async throws -> InstanceSession {
        if !forceRefresh, let stored = Keychain.value(InstanceSession.self, for: Key.session(instance.origin)), stored.isFresh {
            return stored
        }
        if let running = inFlight[instance.origin] { return try await running.value }
        let task = Task { try await self.createSession(for: instance) }
        inFlight[instance.origin] = task
        defer { inFlight[instance.origin] = nil }
        return try await task.value
    }

    private func createSession(for instance: CloudInstance, retry: Bool = true) async throws -> InstanceSession {
        guard instance.isRunning else { throw AuthError.instanceNotReady }
        guard let instanceOrigin = URL(string: instance.origin) else { throw AuthError.invalidResponse }

        var start = URLRequest(url: instanceOrigin.appending(path: "api/auth/cloud/native/start"))
        start.httpMethod = "POST"
        start.setValue("application/json", forHTTPHeaderField: "Accept")
        let (startData, startStatus) = try await perform(start)
        guard (200..<300).contains(startStatus) else {
            throw startStatus == 404 || startStatus == 409 ? AuthError.sessionRejected : AuthError.network
        }
        guard let startBody = try? JSONDecoder().decode(JSONValue.self, from: startData),
              let authorizationRequest = startBody["authorization_request"],
              authorizationRequest["client_id"]?.string == "rome-instance",
              let state = authorizationRequest["state"]?.string,
              startBody["origin"]?.string == instance.origin
        else { throw AuthError.invalidResponse }

        let authorizationData = try await cloudRequest(
            "v1/instances/\(instance.id)/authorizations",
            method: "POST",
            body: .object(["authorization_request": authorizationRequest])
        )
        guard let authorization = try? JSONDecoder().decode(JSONValue.self, from: authorizationData),
              let code = authorization["code"]?.string,
              authorization["state"]?.string == state,
              let issuer = authorization["iss"]?.string
        else { throw AuthError.invalidResponse }

        var complete = URLRequest(url: instanceOrigin.appending(path: "api/auth/cloud/native/complete"))
        complete.httpMethod = "POST"
        complete.setValue("application/json", forHTTPHeaderField: "Accept")
        complete.setValue("application/json", forHTTPHeaderField: "Content-Type")
        complete.httpBody = try JSONEncoder().encode(JSONValue.object([
            "code": .string(code), "state": .string(state), "iss": .string(issuer),
        ]))
        let (sessionData, sessionStatus) = try await perform(complete)
        if sessionStatus == 400, retry { return try await createSession(for: instance, retry: false) }
        guard (200..<300).contains(sessionStatus) else {
            throw sessionStatus == 401 ? AuthError.sessionRejected : AuthError.network
        }
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: sessionData),
              body["cookie_name"]?.string == "rome_session",
              let token = body["session_token"]?.string,
              let expiresAt = body["expires_at"]?.string,
              body["origin"]?.string == instance.origin
        else { throw AuthError.invalidResponse }
        let session = InstanceSession(token: token, expiresAt: expiresAt, origin: instance.origin)
        guard session.isFresh else { throw AuthError.invalidResponse }
        Keychain.set(session, for: Key.session(instance.origin))
        return session
    }

    func signOut() async {
        if let credential = Keychain.value(CloudCredential.self, for: Key.credential) {
            var request = URLRequest(url: origin.appending(path: "v1/mobile/session"))
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
            _ = try? await perform(request)
        }
        Keychain.removeAll()
    }

    // MARK: Plumbing

    private func cloudRequest(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> Data {
        guard let credential = Keychain.value(CloudCredential.self, for: Key.credential) else {
            throw AuthError.cloudUnauthorized
        }
        var request = URLRequest(url: origin.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, status) = try await perform(request)
        switch status {
        case 200..<300: return data
        case 401:
            Keychain.remove(Key.credential)
            throw AuthError.cloudUnauthorized
        case 403: throw AuthError.accessDenied
        case 409: throw AuthError.instanceNotReady
        default: throw AuthError.sessionRejected
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await http.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw AuthError.network
        }
    }

    nonisolated private static func randomBase64URL(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return base64URL(Data(bytes))
    }

    nonisolated static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

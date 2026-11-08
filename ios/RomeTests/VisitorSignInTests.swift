import Foundation
import Testing
@testable import Rome

/// Answers by path, in turn per path; records every request.
final class RouteProtocol: URLProtocol, @unchecked Sendable {
    struct Reply { let status: Int; let body: String }
    nonisolated(unsafe) static var routes: [String: [Reply]] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []

    static func reset() { routes = [:]; seen = [] }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var recorded = request
        if recorded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            recorded.httpBody = data
        }
        Self.seen.append(recorded)
        let path = request.url!.path()
        var queue = Self.routes[path] ?? []
        let reply = queue.isEmpty ? Reply(status: 404, body: "{}") : (queue.count > 1 ? queue.removeFirst() : queue[0])
        Self.routes[path] = queue
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Secrets in memory, never the Mac's Keychain.
final class MemoryStore: SecretStore, @unchecked Sendable {
    var items: [String: Data] = [:]
    func data(for key: String) -> Data? { items[key] }
    func set(_ data: Data, for key: String) { items[key] = data }
    func remove(_ key: String) { items[key] = nil }
    func removeAll() { items = [:] }
    func keys() -> [String] { Array(items.keys) }
}

@MainActor
@Suite(.serialized) struct VisitorSignInTests {
    private static let cloud = URL(string: "https://romeos.cc")!
    private static let origin = "https://team.romeos.cc"
    private static let visitorInstance = CloudInstance(id: "i-team", name: "Team", slug: "team", origin: origin, status: "running", role: "visitor", ownerName: "Dev User")
    private static let ownInstance = CloudInstance(id: "i-me", name: "Mine", slug: "me", origin: "https://me.romeos.cc", status: "running", role: "owner")

    private func auth(_ store: MemoryStore = MemoryStore()) -> CloudAuth {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RouteProtocol.self]
        store.set(CloudCredential(accessToken: "phone-token", deviceSessionId: "d1"), for: "cloud.credential")
        return CloudAuth(origin: Self.cloud, configuration: configuration, store: store)
    }

    private static let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))

    private func visitorRoutes(complete: RouteProtocol.Reply? = nil) {
        RouteProtocol.reset()
        RouteProtocol.routes = [
            "/api/auth/visitor/native/start": [.init(status: 200, body: #"{"visitor_authorization_request":{"client_id":"rome-instance","redirect_uri":"https://team.romeos.cc/api/auth/visitor/callback","code_challenge":"c","code_challenge_method":"S256","state":"s-1","instance_name":"Team","intent":"signin"},"origin":"https://team.romeos.cc","expires_at":"x"}"#)],
            "/v1/instances/i-team/visitor-authorizations": [.init(status: 200, body: #"{"code":"code-1","state":"s-1","iss":"https://romeos.cc","expires_in":60}"#)],
            "/api/auth/visitor/native/complete": [complete ?? .init(status: 200, body: #"{"cookie_name":"rome_visitor","session_token":"visitor-token","expires_at":"\#(Self.future)","origin":"https://team.romeos.cc","role":"visitor"}"#)],
        ]
    }

    /// The visitor sign-in: the instance's start, Rome Cloud's code, the instance's complete.
    @Test func aVisitorGetsARomeVisitorSession() async throws {
        visitorRoutes()
        let store = MemoryStore()
        let session = try await auth(store).session(for: Self.visitorInstance)
        #expect(session.token == "visitor-token")
        #expect(session.cookie == "rome_visitor")
        #expect(RouteProtocol.seen.map { $0.url!.path() } == [
            "/api/auth/visitor/native/start",
            "/v1/instances/i-team/visitor-authorizations",
            "/api/auth/visitor/native/complete",
        ])
        // Rome Cloud gets the instance's own request, the instance gets the code back with its state.
        let relayed = try JSONDecoder().decode(JSONValue.self, from: RouteProtocol.seen[1].httpBody ?? Data())
        #expect(relayed["authorization_request"]?["intent"]?.string == "signin")
        #expect(RouteProtocol.seen[1].value(forHTTPHeaderField: "Authorization") == "Bearer phone-token")
        #expect(try JSONDecoder().decode(JSONValue.self, from: RouteProtocol.seen[2].httpBody ?? Data()) == .object(["state": .string("s-1"), "code": .string("code-1")]))
        // Kept apart from a guardian session for the same origin.
        #expect(store.items["instance.visitorSession.https://team.romeos.cc"] != nil)
        #expect(store.items["instance.session.https://team.romeos.cc"] == nil)
        // The stored one is reused while fresh.
        RouteProtocol.seen = []
        _ = try await auth(store).session(for: Self.visitorInstance)
        #expect(RouteProtocol.seen.isEmpty)
    }

    /// Off the allow-list: the instance refuses the code, and the phone is told it lost access.
    @Test func removedFromTheAllowListLosesAccess() async {
        visitorRoutes(complete: .init(status: 403, body: #"{"error":"not_allowed"}"#))
        await #expect(throws: AuthError.accessRevoked) { try await auth().session(for: Self.visitorInstance) }
        // Rome Cloud no longer lists the instance for this account.
        visitorRoutes()
        RouteProtocol.routes["/v1/instances/i-team/visitor-authorizations"] = [.init(status: 404, body: #"{"error":"instance_not_found"}"#)]
        await #expect(throws: AuthError.accessRevoked) { try await auth().session(for: Self.visitorInstance) }
        // A rate limit is not lost access.
        visitorRoutes()
        RouteProtocol.routes["/v1/instances/i-team/visitor-authorizations"] = [.init(status: 429, body: #"{"error":"rate_limit_exceeded"}"#)]
        await #expect(throws: AuthError.sessionRejected) { try await auth().session(for: Self.visitorInstance) }
    }

    /// A session answering anything but a visitor cookie for this origin is refused.
    @Test func aWrongSessionIsRefused() async {
        visitorRoutes(complete: .init(status: 200, body: #"{"cookie_name":"rome_session","session_token":"t","expires_at":"\#(Self.future)","origin":"https://team.romeos.cc","role":"visitor"}"#))
        await #expect(throws: AuthError.invalidResponse) { try await auth().session(for: Self.visitorInstance) }
        visitorRoutes(complete: .init(status: 200, body: #"{"cookie_name":"rome_visitor","session_token":"t","expires_at":"\#(Self.future)","origin":"https://evil.example","role":"visitor"}"#))
        await #expect(throws: AuthError.invalidResponse) { try await auth().session(for: Self.visitorInstance) }
    }

    /// A visitor's 401 runs the visitor sign-in again, never the owner's.
    @Test func refreshRunsTheVisitorFlowAgain() async throws {
        visitorRoutes()
        let store = MemoryStore()
        _ = try await auth(store).session(for: Self.visitorInstance)
        visitorRoutes()
        let again = try await auth(store).session(for: Self.visitorInstance, forceRefresh: true)
        #expect(again.cookie == "rome_visitor")
        #expect(RouteProtocol.seen.contains { $0.url!.path() == "/api/auth/visitor/native/start" })
        #expect(!RouteProtocol.seen.contains { $0.url!.path().contains("/api/auth/cloud/native") })
    }

    /// Instances read role and owner as optional; an older Rome Cloud's are the owner's.
    @Test func readsRoleAndOwner() async throws {
        RouteProtocol.reset()
        RouteProtocol.routes["/v1/instances"] = [.init(status: 200, body: #"{"items":[{"id":"i-me","name":"Mine","slug":"me","origin":"https://me.romeos.cc","status":"running"},{"id":"i-team","name":"Team","slug":"team","origin":"https://team.romeos.cc","status":"running","role":"visitor","ownerName":"Dev User"}]}"#)]
        let list = try await auth().listInstances()
        #expect(list.map(\.isVisitor) == [false, true])
        #expect(list[1].ownerName == "Dev User")
    }

    /// Plain http only when Rome Cloud itself is http: a Cloud on this Mac.
    @Test func httpInstancesOnlyBesideALocalCloud() {
        let https = URL(string: "https://romeos.cc")!
        let local = URL(string: "http://cloud.rome.localhost:3000")!
        #expect(CloudAuth.opens(URL(string: "https://me.romeos.cc")!, cloudOrigin: https))
        #expect(!CloudAuth.opens(URL(string: "http://me.romeos.cc")!, cloudOrigin: https))
        #expect(CloudAuth.opens(URL(string: "http://visitor-test.rome.localhost")!, cloudOrigin: local))
        #expect(!CloudAuth.opens(URL(string: "https://romeos.cc/x")!, cloudOrigin: https))
    }

    /// The client sends exactly one session cookie, named for the session.
    @Test func oneCookieNamedForTheSession() {
        let origin = URL(string: Self.origin)!
        let visitor = APIClient(origin: origin, token: { "v" }, cookieName: { InstanceSession.visitorCookie })
        let socket = visitor.socketRequest("/ws/events")
        #expect(socket.value(forHTTPHeaderField: "Cookie") == "rome_visitor=v")
        #expect(visitor.sessionCookie()?.name == "rome_visitor")
        // No page script in the Apps web view can read it.
        #expect(visitor.sessionCookie()?.isHTTPOnly == true)
        #expect(visitor.sessionCookie()?.isSecure == true)
        #expect(APIClient(origin: origin, token: { "g" }).socketRequest("/ws/events").value(forHTTPHeaderField: "Cookie") == "rome_session=g")
        // A session stored before visitors is the guardian's.
        let old = try? JSONDecoder().decode(InstanceSession.self, from: Data(#"{"token":"t","expiresAt":"x","origin":"o"}"#.utf8))
        #expect(old?.cookie == "rome_session")
    }

    /// The instance's owner seat records another account: the phone says to
    /// sign in once from a browser, never a generic failure.
    @Test func aStaleOwnerSeatAsksForABrowserSignIn() async {
        RouteProtocol.reset()
        RouteProtocol.routes = [
            "/api/auth/cloud/native/start": [.init(status: 200, body: #"{"authorization_request":{"client_id":"rome-instance","state":"s-1"},"origin":"https://me.romeos.cc"}"#)],
            "/v1/instances/i-me/authorizations": [.init(status: 200, body: #"{"code":"code-1","state":"s-1","iss":"https://romeos.cc"}"#)],
            "/api/auth/cloud/native/complete": [.init(status: 403, body: #"{"error":"not_owner"}"#)],
        ]
        await #expect(throws: AuthError.notOwner) { try await auth().session(for: Self.ownInstance) }
        #expect(AuthError.notOwner.errorDescription == "Sign in to this Rome once in a browser, then try again")
        // Any other refusal keeps its old meaning.
        #expect(CloudAuth.completeError(status: 403, body: Data(#"{"error":"forbidden"}"#.utf8)) == .network)
        #expect(CloudAuth.completeError(status: 403, body: Data()) == .network)
        #expect(CloudAuth.completeError(status: 401, body: Data(#"{"error":"not_owner"}"#.utf8)) == .sessionRejected)
    }

    /// A Rome from before the visitor sign-in says so, instead of claiming lost access.
    @Test func anOlderRomeAsksItsOwnerToUpdate() async {
        visitorRoutes()
        RouteProtocol.routes["/api/auth/visitor/native/start"] = [.init(status: 401, body: #"{"error":"Unauthorized"}"#)]
        await #expect(throws: AuthError.instanceTooOld) { try await auth().session(for: Self.visitorInstance) }
        #expect(CloudAuth.visitorStartError(status: 404, body: Data("404 Not Found".utf8)) == .instanceTooOld)
        #expect(CloudAuth.visitorStartError(status: 404, body: Data(#"{"error":"dashboard_not_cloud_email_restricted"}"#.utf8)) == .accessRevoked)
        #expect(CloudAuth.visitorStartError(status: 503, body: Data()) == .network)
    }

    /// A new Cloud credential may be another account's: every instance
    /// session goes, other secrets stay.
    @Test func aNewSignInForgetsInstanceSessions() async throws {
        visitorRoutes()
        let store = MemoryStore()
        _ = try await auth(store).session(for: Self.visitorInstance)
        store.set(Data("t".utf8), for: "instance.session.https://me.romeos.cc")
        store.set(Data("p".utf8), for: "push.token")
        auth(store).forgetInstanceSessions()
        #expect(!store.items.keys.contains { $0.hasPrefix("instance.") })
        #expect(store.items["push.token"] != nil)
        #expect(store.items["cloud.credential"] != nil)
    }

    /// Sign-out forgets visitor sessions with the rest.
    @Test func signOutForgetsVisitorSessions() async throws {
        visitorRoutes()
        let store = MemoryStore()
        _ = try await auth(store).session(for: Self.visitorInstance)
        RouteProtocol.routes["/v1/mobile/session"] = [.init(status: 204, body: "")]
        await auth(store).signOut()
        #expect(store.items.isEmpty)
    }
}

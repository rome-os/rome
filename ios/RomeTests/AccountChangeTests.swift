import Foundation
import Testing
import UIKit
@testable import Rome

/// Answers by path like `RouteProtocol`, but holds the instance's owner
/// `complete` while `holding`, until `release()`.
final class HeldProtocol: URLProtocol, @unchecked Sendable {
    struct Reply { let status: Int; let body: String }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var routes: [String: [Reply]] = [:]
    nonisolated(unsafe) private static var held: [(HeldProtocol, Reply)] = []
    nonisolated(unsafe) private static var holdPath: String?
    nonisolated(unsafe) static var seen: [URLRequest] = []

    static func reset(_ routes: [String: [Reply]], holding path: String? = nil) {
        lock.withLock { self.routes = routes; held = []; holdPath = path; seen = [] }
    }

    static func stopHolding() { lock.withLock { holdPath = nil } }
    static var heldCount: Int { lock.withLock { held.count } }
    static func requests(_ path: String) -> [URLRequest] { lock.withLock { seen.filter { $0.url?.path() == path } } }

    /// Answers every held request now, as if the instance had been slow.
    static func release() {
        let waiting = lock.withLock { () -> [(HeldProtocol, Reply)] in
            defer { held = [] }
            return held
        }
        for (request, reply) in waiting { request.answer(reply) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url!.path()
        let (reply, hold) = Self.lock.withLock { () -> (Reply, Bool) in
            Self.seen.append(request)
            var queue = Self.routes[path] ?? []
            let reply = queue.isEmpty ? Reply(status: 404, body: "{}") : (queue.count > 1 ? queue.removeFirst() : queue[0])
            Self.routes[path] = queue
            let hold = path == Self.holdPath
            if hold { Self.held.append((self, reply)) }
            return (reply, hold)
        }
        if !hold { answer(reply) }
    }

    private func answer(_ reply: Reply) {
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Work begun for one account never reaches the next: sign-out and a new
/// sign-in end the account, and everything stamped with it turns into a no-op.
@MainActor
@Suite(.serialized) struct AccountChangeTests {
    private static let cloud = URL(string: "https://romeos.cc")!
    private static let own = CloudInstance(id: "i-me", name: "Mine", slug: "me", origin: "https://me.romeos.cc", status: "running", role: "owner")
    private static let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
    private static let complete = "/api/auth/cloud/native/complete"

    private static func session(_ token: String) -> HeldProtocol.Reply {
        .init(status: 200, body: #"{"cookie_name":"rome_session","session_token":"\#(token)","expires_at":"\#(future)","origin":"https://me.romeos.cc"}"#)
    }

    /// A's refresh waits on the instance's `complete`; A signs out and B signs
    /// in meanwhile. B gets B's own cookie, A's never reaches B or the store.
    @Test func anOldAccountsSignInNeverReachesTheNext() async throws {
        HeldProtocol.reset([
            "/api/auth/cloud/native/start": [.init(status: 200, body: #"{"authorization_request":{"client_id":"rome-instance","state":"s-1"},"origin":"https://me.romeos.cc"}"#)],
            "/v1/instances/i-me/authorizations": [.init(status: 200, body: #"{"code":"code-1","state":"s-1","iss":"https://romeos.cc"}"#)],
            Self.complete: [Self.session("cookie-a"), Self.session("cookie-b")],
            "/v1/mobile/session": [.init(status: 204, body: "")],
            "/oauth2/token": [.init(status: 200, body: #"{"access_token":"token-b","token_type":"Bearer","device_session_id":"d-b"}"#)],
        ], holding: Self.complete)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldProtocol.self]
        let store = MemoryStore()
        store.set(CloudCredential(accessToken: "token-a", deviceSessionId: "d-a"), for: "cloud.credential")
        let auth = CloudAuth(origin: Self.cloud, configuration: configuration, store: store)
        let generation = auth.accountGeneration

        let a = Task { try await auth.session(for: Self.own, forceRefresh: true) }
        for _ in 0..<200 where HeldProtocol.heldCount == 0 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(HeldProtocol.heldCount == 1)

        await auth.signOut()
        #expect(store.items.isEmpty)
        let request = auth.beginSignIn()
        let state = URLComponents(url: request.authorizeURL, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        try await auth.completeSignIn(request, callback: URL(string: "cc.romeos.mobile:/oauth/callback?code=c&state=\(state)&iss=https://romeos.cc")!)
        #expect(auth.accountGeneration > generation)

        // A's instance answers late, then B asks for the same instance.
        HeldProtocol.stopHolding()
        HeldProtocol.release()
        await #expect(throws: (any Error).self) { try await a.value }
        let b = try await auth.session(for: Self.own)
        #expect(b.token == "cookie-b")
        try await Task.sleep(for: .milliseconds(100))
        #expect(store.value(InstanceSession.self, for: "instance.session.https://me.romeos.cc")?.token == "cookie-b")
        // B's Cloud step went with B's credential only.
        let authorizations = HeldProtocol.requests("/v1/instances/i-me/authorizations").compactMap { $0.value(forHTTPHeaderField: "Authorization") }
        #expect(authorizations.last == "Bearer token-b")
        #expect(authorizations.dropFirst().allSatisfy { $0 == "Bearer token-b" })
    }

    /// A late 401 for the old account leaves the new credential alone.
    @Test func anOldAccountsLate401KeepsTheNewCredential() async throws {
        HeldProtocol.reset([
            "/v1/instances": [.init(status: 401, body: "{}")],
        ], holding: "/v1/instances")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldProtocol.self]
        let store = MemoryStore()
        store.set(CloudCredential(accessToken: "token-a", deviceSessionId: "d-a"), for: "cloud.credential")
        let auth = CloudAuth(origin: Self.cloud, configuration: configuration, store: store)
        let list = Task { try await auth.listInstances() }
        for _ in 0..<200 where HeldProtocol.heldCount == 0 { try await Task.sleep(for: .milliseconds(10)) }
        auth.endAccount()
        store.set(CloudCredential(accessToken: "token-b", deviceSessionId: "d-b"), for: "cloud.credential")
        HeldProtocol.release()
        await #expect(throws: (any Error).self) { try await list.value }
        #expect(store.value(CloudCredential.self, for: "cloud.credential")?.accessToken == "token-b")
    }

    private let base = FileManager.default.temporaryDirectory.appending(path: "rome account \(UUID().uuidString)", directoryHint: .isDirectory)

    private func row(_ id: String) -> ChatMessage {
        ChatMessage(id: id, sessionId: "concierge", role: "assistant", content: #"[{"type":"text","content":"hi"}]"#, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
    }

    /// A messages fetch held over the sign-out wipe, released after it,
    /// writes nothing: no kept chat, no draft comes back.
    @Test func aFetchReleasedAfterTheWipeWritesNothing() async {
        defer { try? FileManager.default.removeItem(at: base) }
        let account = AccountGeneration()
        let stamp = account.stamp()
        let root = base.appending(path: "Transcripts", directoryHint: .isDirectory)
        let draftsRoot = base.appending(path: "Drafts", directoryHint: .isDirectory)
        let cache = TranscriptCache(root: root, instance: "me.romeos.cc", account: stamp)
        let drafts = DraftStore(root: draftsRoot, instance: "me.romeos.cc", account: stamp)
        let backend = FakeBackend()
        backend.stored = [row("m1")]
        backend.duringNewestFetch = {
            // Sign-out lands while the page is on its way.
            drafts.save(chat: "concierge", text: "half written", photos: [])
            account.end()
            TranscriptCache.removeAll(root: root)
            DraftStore.removeAll(root: draftsRoot)
        }
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.cache = cache
        await store.reload()
        #expect(store.messages.map(\.id) == ["m1"])
        cache.setMainChat("concierge")
        cache.flush()
        await drafts.flush()
        TranscriptCache.settle()
        #expect(!FileManager.default.fileExists(atPath: root.path(percentEncoded: false)))
        #expect(!FileManager.default.fileExists(atPath: draftsRoot.path(percentEncoded: false)))
        #expect(TranscriptCache(root: root, instance: "me.romeos.cc").messages(chat: "concierge") == nil)
    }

    /// An image fetched for an account that ended meanwhile is not stored.
    @Test func anImageFetchedAcrossTheWipeIsNotKept() async {
        defer { try? FileManager.default.removeItem(at: base) }
        let account = AccountGeneration()
        let cache = ImageDiskCache(root: base.appending(path: "Images", directoryHint: .isDirectory))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let fresh = await CachedImage.refresh(
            instance: "me.romeos.cc", key: "app-icon-a", version: "1", account: account.stamp(), cache: cache,
            fetch: {
                account.end()
                cache.removeAll()
                return image.pngData()!
            },
            draw: { UIImage(data: $0) }
        )
        #expect(fresh == nil)
        #expect(cache.entry(instance: "me.romeos.cc", key: "app-icon-a") == nil)
    }

    /// The apps list read for an ended account is not kept.
    @Test func appsReadForAnEndedAccountAreNotKept() async {
        let account = AccountGeneration()
        let client = APIClient(origin: URL(string: "https://me.romeos.cc")!, token: { nil })
        let workspace = Workspace(
            backend: LiveBackend(client: client, account: account.stamp()), instanceName: "Mine", host: "me.romeos.cc", accountLabel: "a",
            drafts: DraftStore(root: base.appending(path: "Drafts", directoryHint: .isDirectory), instance: "me.romeos.cc")
        )
        defer { try? FileManager.default.removeItem(at: base) }
        account.end()
        await workspace.shelve([InstalledApp(id: "a", displayName: "A")])
        #expect(workspace.apps.isEmpty)
    }

    /// The language seen on an instance belongs to the account that saw it.
    @Test func theLanguageSeenIsNotKeptForAnEndedAccount() async {
        let defaults = UserDefaults(suiteName: "language-\(UUID())")!
        let account = AccountGeneration()
        let stamp = account.stamp()
        account.end()
        await LanguageSync(defaults: defaults).check(host: "me.romeos.cc", current: "en", account: stamp, isGuardian: { true }) { _ in }
        #expect(defaults.string(forKey: LanguageSync.key(host: "me.romeos.cc")) == nil)
        defaults.set("en", forKey: LanguageSync.key(host: "me.romeos.cc"))
        LanguageSync.removeAll(defaults: defaults)
        #expect(defaults.string(forKey: LanguageSync.key(host: "me.romeos.cc")) == nil)
    }

    /// A's recent apps never show for B on the same instance: wiped with the
    /// account, and an app opened as the account ends is not recorded.
    @Test func recentAppsBelongToTheAccount() {
        let defaults = UserDefaults(suiteName: "recent-\(UUID())")!
        let account = AccountGeneration()
        let recent = RecentApps(host: "me.romeos.cc", account: account.stamp(), defaults: defaults)
        recent.record("habits")
        #expect(recent.ids() == ["habits"])
        account.end()
        recent.record("reading")
        #expect(recent.ids() == ["habits"])
        RecentApps(host: "team.romeos.cc", defaults: defaults).record("packing")
        UpdateBannerStore(defaults: defaults).dismiss("1.1.190", for: "i-me")
        defaults.set("dark", forKey: "appearance")
        RecentApps.removeAll(defaults: defaults)
        UpdateBannerStore.removeAll(defaults: defaults)
        #expect(RecentApps(host: "me.romeos.cc", defaults: defaults).ids().isEmpty)
        #expect(RecentApps(host: "team.romeos.cc", defaults: defaults).ids().isEmpty)
        #expect(UpdateBannerStore(defaults: defaults).dismissed("i-me") == nil)
        // Not the account's: stays.
        #expect(defaults.string(forKey: "appearance") == "dark")
    }
}

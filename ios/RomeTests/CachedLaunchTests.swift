import Foundation
import Testing
@testable import Rome

/// Rome Cloud and the instance for these tests alone, by path; `offline`
/// fails every request as a phone without a network does.
final class LaunchProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var offline = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if Self.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let (status, body) = Self.answers[request.url?.path() ?? ""] ?? (404, "{}")
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A launch with the last instance and its session kept opens it at once,
/// and catches up in the background.
@MainActor
@Suite(.serialized) struct CachedLaunchTests {
    private static let keys = ["lastInstanceID", "lastInstanceRecord", "keptIdentity.b"]
    private static let b = CloudInstance(id: "b", name: "B", slug: "b", origin: "https://b.example", status: "running")

    private func iso(_ seconds: TimeInterval) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(seconds)) }

    private func model(session: InstanceSession? = nil, kept: Bool = true) -> (AppModel, CloudAuth) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LaunchProtocol.self]
        let store = MemoryStore()
        store.set(CloudCredential(accessToken: "phone-token", deviceSessionId: "d1"), for: "cloud.credential")
        if let session { store.set(session, for: "instance.session.https://b.example") }
        if kept {
            UserDefaults.standard.set("b", forKey: "lastInstanceID")
            UserDefaults.standard.set(try? JSONEncoder().encode(Self.b), forKey: "lastInstanceRecord")
        }
        let cloud = CloudAuth(origin: URL(string: "https://romeos.cc")!, configuration: configuration, store: store)
        let app = AppModel(cloud: cloud, images: StoredImageCache(), instanceConfiguration: {
            let instance = URLSessionConfiguration.ephemeral
            instance.protocolClasses = [LaunchProtocol.self]
            return instance
        })
        return (app, cloud)
    }

    private var fresh: InstanceSession { InstanceSession(token: "kept", expiresAt: iso(3600), origin: "https://b.example") }

    private func list(_ status: String) {
        LaunchProtocol.answers["/v1/instances"] = (200, #"{"items":[{"id":"b","name":"B","slug":"b","origin":"https://b.example","status":"\#(status)"}]}"#)
    }

    private func clean(_ body: () async -> Void) async {
        let saved = Self.keys.map { UserDefaults.standard.object(forKey: $0) }
        for key in Self.keys { UserDefaults.standard.removeObject(forKey: key) }
        LaunchProtocol.answers = [:]
        LaunchProtocol.offline = false
        await body()
        LaunchProtocol.answers = [:]
        LaunchProtocol.offline = false
        for (key, value) in zip(Self.keys, saved) { UserDefaults.standard.set(value, forKey: key) }
    }

    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    /// Offline, the kept instance opens with its kept role, and stays.
    @Test func aCachedLaunchIsReadyWithoutANetwork() async {
        await clean {
            LaunchProtocol.offline = true
            KeptIdentity.save(KeptIdentity(guardian: false, name: "Ada", avatarURL: nil), for: "b")
            let (app, _) = model(session: fresh)
            await app.launch(skipSnapshot: true)
            #expect(app.phase == .ready)
            #expect(app.workspace?.isVisitor == true && app.workspace?.accountLabel == "Ada")
            try? await Task.sleep(for: .milliseconds(200))
            #expect(app.phase == .ready && app.workspace != nil)
        }
    }

    /// A session past its time opens the workspace, then is renewed quietly.
    @Test func anExpiredSessionIsRenewedInTheBackground() async {
        await clean {
            list("running")
            LaunchProtocol.answers["/api/auth/cloud/native/start"] = (200, #"{"authorization_request":{"client_id":"rome-instance","state":"s"},"origin":"https://b.example"}"#)
            LaunchProtocol.answers["/v1/instances/b/authorizations"] = (200, #"{"code":"c","state":"s","iss":"https://romeos.cc"}"#)
            LaunchProtocol.answers["/api/auth/cloud/native/complete"] = (200, #"{"cookie_name":"rome_session","session_token":"renewed","expires_at":"\#(iso(7200))","origin":"https://b.example"}"#)
            let (app, cloud) = model(session: InstanceSession(token: "old", expiresAt: iso(-60), origin: "https://b.example"))
            await app.launch(skipSnapshot: true)
            #expect(app.phase == .ready)
            #expect(await eventually { cloud.storedSession(for: Self.b)?.token == "renewed" })
            #expect(app.phase == .ready)
        }
    }

    /// Rome Cloud says it stopped: the stopped page replaces the chat.
    @Test func anInstanceStoppedAfterLaunchShowsItsPage() async {
        await clean {
            list("stopped")
            let (app, _) = model(session: fresh)
            await app.launch(skipSnapshot: true)
            #expect(await eventually { app.phase == .stopped(instanceName: "B") })
            #expect(app.workspace == nil)
        }
    }

    /// Below the minimum, the update page covers the chat when the check answers.
    @Test func belowTheMinimumAfterLaunchCoversTheChat() async {
        await clean {
            list("running")
            LaunchProtocol.answers["/api/system/upgrade/check"] = (200, #"{"current":{"version":"1.0.1"},"latest":{"version":"9.9.9"},"upgradeAvailable":true}"#)
            let (app, _) = model(session: fresh)
            await app.launch(skipSnapshot: true)
            #expect(app.phase == .ready)
            #expect(await eventually { app.update.blocking && app.update.belowMinimum })
        }
    }

    /// Rome Cloud no longer knows this phone: back to sign-in.
    @Test func aCloudSignOutAfterLaunchGoesToSignIn() async {
        await clean {
            LaunchProtocol.answers["/v1/instances"] = (401, #"{"error":"unauthorized"}"#)
            let (app, _) = model(session: fresh)
            await app.launch(skipSnapshot: true)
            #expect(await eventually { app.phase == .signedOut })
            #expect(app.workspace == nil)
        }
    }

    /// Nothing kept: the usual path, behind the loading screen.
    @Test func withNothingKeptTheLaunchWaitsForRomeCloud() async {
        await clean {
            LaunchProtocol.offline = true
            let (app, _) = model(session: nil, kept: false)
            await app.launch(skipSnapshot: true)
            // Offline with nothing kept: sign-in says what went wrong; no workspace opened.
            #expect(app.workspace == nil)
            #expect(app.phase != .ready)
        }
    }

    /// A push tap for the kept instance opens it at once, then its chat.
    @Test func aPushTapForTheKeptInstanceOpensItsChat() async {
        await clean {
            LaunchProtocol.offline = true
            let (app, _) = model(session: fresh)
            await app.openFromPush(PushTarget(instanceId: "b", chatId: "concierge"))
            await app.launch(skipSnapshot: true)
            #expect(app.phase == .ready)
            #expect(app.chatRequest.serial == 1)
        }
    }

    /// A push tap for another instance opens that one, not the kept one.
    @Test func aPushTapForAnotherInstanceOpensIt() async {
        await clean {
            LaunchProtocol.answers["/v1/instances"] = (200, #"{"items":[{"id":"b","name":"B","slug":"b","origin":"https://b.example","status":"running"},{"id":"c","name":"C","slug":"c","origin":"https://c.example","status":"stopped"}]}"#)
            let (app, _) = model(session: fresh)
            await app.openFromPush(PushTarget(instanceId: "c", chatId: "concierge"))
            await app.launch(skipSnapshot: true)
            // C is stopped: its page, not B's chat.
            #expect(app.phase == .stopped(instanceName: "C"))
        }
    }
}

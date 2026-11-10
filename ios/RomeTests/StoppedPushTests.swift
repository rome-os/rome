import Foundation
import Testing
@testable import Rome

/// Rome Cloud's instance list for these tests alone: `RouteProtocol` is
/// shared with suites that may run at the same time.
final class InstanceListProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var list = #"{"items":[]}"#
    /// Other paths, answered as given; anything else is a 404.
    nonisolated(unsafe) static var other: [String: (Int, String)] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path() ?? ""
        let (status, body) = path == "/v1/instances" ? (200, Self.list) : (Self.other[path] ?? (404, "{}"))
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Push taps while a stopped instance's page shows, through the whole model.
@MainActor
@Suite(.serialized) struct StoppedPushTests {
    private static let keys = ["lastInstanceID", "lastInstanceRecord"]

    private func model(sessionForB: Bool = true) -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [InstanceListProtocol.self]
        let store = MemoryStore()
        store.set(CloudCredential(accessToken: "phone-token", deviceSessionId: "d1"), for: "cloud.credential")
        // A fresh session for B, so opening it asks Rome Cloud for nothing more.
        let future = Date().addingTimeInterval(3600)
        if sessionForB {
            store.set(InstanceSession(token: "t", expiresAt: ISO8601DateFormatter().string(from: future), origin: "https://b.example"), for: "instance.session.https://b.example")
        }
        // Its own picture cache: the model resets it on every switch, which
        // must never reach a test using the app's.
        return AppModel(cloud: CloudAuth(origin: URL(string: "https://romeos.cc")!, configuration: configuration, store: store), images: StoredImageCache())
    }

    private func list(b: String, c: String = "stopped") {
        InstanceListProtocol.list = #"{"items":[{"id":"b","name":"B","slug":"b","origin":"https://b.example","status":"\#(b)"},{"id":"c","name":"C","slug":"c","origin":"https://c.example","status":"\#(c)"}]}"#
    }

    private func withCleanDefaults(_ body: () async -> Void) async {
        let saved = Self.keys.map { UserDefaults.standard.object(forKey: $0) }
        for key in Self.keys { UserDefaults.standard.removeObject(forKey: key) }
        await body()
        for (key, value) in zip(Self.keys, saved) { UserDefaults.standard.set(value, forKey: key) }
    }

    /// Fails before the change: the second and third taps left the first stopped page up.
    @Test func aTapOnAStoppedPageOpensItsInstance() async {
        await withCleanDefaults {
            list(b: "stopped")
            let app = model()
            // A cold launch from a push for B, which is stopped.
            await app.openFromPush(PushTarget(instanceId: "b"))
            await app.openInstance(preferring: "b")
            #expect(app.phase == .stopped(instanceName: "B"))
            // A push from C, stopped as well: its own page.
            await app.openFromPush(PushTarget(instanceId: "c"))
            #expect(app.phase == .stopped(instanceName: "C"))
            // B is started in Rome Cloud, then its push is tapped: B opens.
            list(b: "running")
            await app.openFromPush(PushTarget(instanceId: "b", chatId: "concierge"))
            #expect(app.currentInstanceID == "b")
            #expect(app.phase != .stopped(instanceName: "B"))
            #expect(app.phase != .stopped(instanceName: "C"))
            app.workspace?.stop()
        }
    }

    /// The stopped page waits on B's upgrade. A tap for B keeps that wait;
    /// a tap for another instance moves on. Fails before the change: the
    /// tap for B showed B's stopped page afresh, which ended the wait.
    @Test func aTapForTheUpgradingInstanceKeepsWaiting() async {
        await withCleanDefaults {
            UserDefaults.standard.set(try? JSONEncoder().encode(PendingUpgrade(target: "1.2.0", since: .now, from: "1.1.0")), forKey: "pendingUpgrade.b")
            defer {
                UserDefaults.standard.removeObject(forKey: "pendingUpgrade.b")
                InstanceListProtocol.other = [:]
            }
            // B restarts on its new release: Rome Cloud still lists it, but cannot sign in to it yet.
            InstanceListProtocol.other = [
                "/api/auth/cloud/native/start": (200, #"{"authorization_request":{"client_id":"rome-instance","state":"s-1"},"origin":"https://b.example"}"#),
                "/v1/instances/b/authorizations": (409, #"{"error":"instance_not_ready"}"#),
            ]
            list(b: "running")
            let app = model(sessionForB: false)
            await app.openInstance(preferring: "b")
            #expect(app.phase == .stopped(instanceName: "B"))
            #expect(app.update.waitingInstanceID == "b")
            // Rome Cloud now reports it stopped mid-restart; a push from B is tapped.
            list(b: "stopped")
            await app.openFromPush(PushTarget(instanceId: "b"))
            #expect(app.update.waitingInstanceID == "b")
            #expect(app.phase == .stopped(instanceName: "B"))
            // A push from C, stopped too, shows C's page instead.
            await app.openFromPush(PushTarget(instanceId: "c"))
            #expect(app.phase == .stopped(instanceName: "C"))
            #expect(app.update.waitingInstanceID == nil)
        }
    }

    /// The wait on B's upgrade times out: nothing reopens B now, so a tap
    /// for B opens it. Fails before the change: the tap waited on a wait
    /// that had ended, and did nothing.
    @Test func aTapAfterTheWaitTimedOutOpensTheInstance() async throws {
        await withCleanDefaults {
            UserDefaults.standard.set(try? JSONEncoder().encode(PendingUpgrade(target: "1.2.0", since: .now.addingTimeInterval(-UpdateGate.upgradeTimeout + 0.3), from: "1.1.0")), forKey: "pendingUpgrade.b")
            defer {
                UserDefaults.standard.removeObject(forKey: "pendingUpgrade.b")
                InstanceListProtocol.other = [:]
            }
            InstanceListProtocol.other = [
                "/api/auth/cloud/native/start": (200, #"{"authorization_request":{"client_id":"rome-instance","state":"s-1"},"origin":"https://b.example"}"#),
                "/v1/instances/b/authorizations": (409, #"{"error":"instance_not_ready"}"#),
            ]
            list(b: "running")
            let app = model(sessionForB: false)
            await app.openInstance(preferring: "b")
            #expect(app.update.waitingInstanceID == "b")
            // Rome Cloud reports B stopped until the wait gives up.
            list(b: "stopped")
            for _ in 0..<80 {
                if case .failed = app.update.state { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard case .failed(.timedOut) = app.update.state else { Issue.record("\(app.update.state)"); return }
            #expect(app.update.waitingInstanceID == nil)
            // B comes back; its push is tapped: B opens.
            let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
            InstanceListProtocol.other["/v1/instances/b/authorizations"] = (200, #"{"code":"code-1","state":"s-1","iss":"https://romeos.cc"}"#)
            InstanceListProtocol.other["/api/auth/cloud/native/complete"] = (200, #"{"cookie_name":"rome_session","session_token":"t","expires_at":"\#(future)","origin":"https://b.example"}"#)
            list(b: "running")
            await app.openFromPush(PushTarget(instanceId: "b"))
            #expect(app.currentInstanceID == "b")
            app.workspace?.stop()
        }
    }

    /// A retry that finds the pushed instance still stopped keeps its page,
    /// so the next retry still opens it, not the instance opened last.
    /// Fails before the change: the second retry opened C.
    @Test func aFailedRetryKeepsThePushedInstance() async {
        await withCleanDefaults {
            UserDefaults.standard.set("c", forKey: "lastInstanceID")
            list(b: "stopped")
            let app = model()
            await app.openFromPush(PushTarget(instanceId: "b"))
            await app.openInstance(preferring: "b")
            #expect(app.phase == .stopped(instanceName: "B"))
            // Both still stopped: the retry leaves B's page up.
            await app.retry()
            #expect(app.phase == .stopped(instanceName: "B"))
            // Both started in Rome Cloud: the retry opens B.
            list(b: "running", c: "running")
            await app.retry()
            #expect(app.currentInstanceID == "b")
            app.workspace?.stop()
        }
    }
}

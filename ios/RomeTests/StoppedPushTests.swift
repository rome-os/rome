import Foundation
import Testing
@testable import Rome

/// Rome Cloud's instance list for these tests alone: `RouteProtocol` is
/// shared with suites that may run at the same time.
final class InstanceListProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var list = #"{"items":[]}"#

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let found = request.url?.path() == "/v1/instances"
        let response = HTTPURLResponse(url: request.url!, statusCode: found ? 200 : 404, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((found ? Self.list : "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Push taps while a stopped instance's page shows, through the whole model.
@MainActor
@Suite(.serialized) struct StoppedPushTests {
    private static let keys = ["lastInstanceID", "lastInstanceRecord"]

    private func model() -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [InstanceListProtocol.self]
        let store = MemoryStore()
        store.set(CloudCredential(accessToken: "phone-token", deviceSessionId: "d1"), for: "cloud.credential")
        // A fresh session for B, so opening it asks Rome Cloud for nothing more.
        let future = Date().addingTimeInterval(3600)
        store.set(InstanceSession(token: "t", expiresAt: ISO8601DateFormatter().string(from: future), origin: "https://b.example"), for: "instance.session.https://b.example")
        return AppModel(cloud: CloudAuth(origin: URL(string: "https://romeos.cc")!, configuration: configuration, store: store))
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
            await app.openInstance(preferring: "b", showHint: false)
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

    /// A retry that finds the pushed instance still stopped keeps its page,
    /// so the next retry still opens it, not the instance opened last.
    /// Fails before the change: the second retry opened C.
    @Test func aFailedRetryKeepsThePushedInstance() async {
        await withCleanDefaults {
            UserDefaults.standard.set("c", forKey: "lastInstanceID")
            list(b: "stopped")
            let app = model()
            await app.openFromPush(PushTarget(instanceId: "b"))
            await app.openInstance(preferring: "b", showHint: false)
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

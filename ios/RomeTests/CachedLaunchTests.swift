import Foundation
import Testing
@testable import Rome

/// Rome Cloud and the instance for these tests alone, by path; `offline`
/// fails every request as a phone without a network does.
final class LaunchProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var offline = false
    /// A token the instance refuses, as it refuses one past its time.
    nonisolated(unsafe) static var refused: String?
    /// Instance requests that came with the refused token.
    nonisolated(unsafe) static var refusedPaths: [String] = []
    /// Paths answered only after this long.
    nonisolated(unsafe) static var slow: [String: Double] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let delay = Self.slow[request.url?.path() ?? ""] { Thread.sleep(forTimeInterval: delay) }
        if Self.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let path = request.url?.path() ?? ""
        if let refused = Self.refused, request.value(forHTTPHeaderField: "Cookie")?.hasSuffix("=\(refused)") == true {
            Self.refusedPaths.append(path)
            let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"error":"unauthorized"}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let (status, body) = Self.answers[path] ?? (404, "{}")
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A launch with the last instance and its session kept opens it at once,
/// and catches up in the background.
/// Suites that write the kept instance (`lastInstanceID`,
/// `lastInstanceRecord`) in the app's defaults run one at a time.
@Suite(.serialized) enum LastInstanceDefaults {}

extension LastInstanceDefaults {
    @MainActor
    @Suite(.serialized) struct CachedLaunchTests {
        private static let keys = ["lastInstanceID", "lastInstanceRecord", "keptIdentity.b"]
        private static let b = CloudInstance(id: "b", name: "B", slug: "b", origin: "https://b.example", status: "running")

        private func iso(_ seconds: TimeInterval) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(seconds)) }

        private func model(session: InstanceSession? = nil, kept: Bool = true, record: CloudInstance = b, others: [InstanceSession] = []) -> (AppModel, CloudAuth) {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [LaunchProtocol.self]
            let store = MemoryStore()
            store.set(CloudCredential(accessToken: "phone-token", deviceSessionId: "d1"), for: "cloud.credential")
            if let session { store.set(session, for: record.isVisitor ? "instance.visitorSession.https://b.example" : "instance.session.https://b.example") }
            for other in others { store.set(other, for: "instance.session.\(other.origin)") }
            if kept {
                UserDefaults.standard.set("b", forKey: "lastInstanceID")
                UserDefaults.standard.set(try? JSONEncoder().encode(record), forKey: "lastInstanceRecord")
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
            LaunchProtocol.refused = nil
            LaunchProtocol.refusedPaths = []
            LaunchProtocol.slow = [:]
            await body()
            LaunchProtocol.slow = [:]
            LaunchProtocol.answers = [:]
            LaunchProtocol.offline = false
            LaunchProtocol.refused = nil
            LaunchProtocol.refusedPaths = []
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
                // The widget files this instance's apps under its id; without
                // it a cached launch never wrote them.
                #expect(app.workspace?.instanceID == "b")
                try? await Task.sleep(for: .milliseconds(200))
                #expect(app.phase == .ready && app.workspace != nil)
            }
        }

        /// A session past its time shows the kept workspace, renews quietly, and
        /// only then starts what needs the session: no request goes out on the
        /// old token, and Chat works with nothing kept to show.
        @Test func anExpiredSessionIsRenewedBeforeTheChatStarts() async {
            await clean {
                list("running")
                LaunchProtocol.refused = "old"
                LaunchProtocol.answers["/api/concierge/session"] = (200, #"{"id":"main-1","unread":0}"#)
                LaunchProtocol.answers["/api/chat/sessions/main-1/messages"] = (200, #"{"messages":[],"hasMore":false}"#)
                LaunchProtocol.answers["/api/auth/cloud/native/start"] = (200, #"{"authorization_request":{"client_id":"rome-instance","state":"s"},"origin":"https://b.example"}"#)
                LaunchProtocol.answers["/v1/instances/b/authorizations"] = (200, #"{"code":"c","state":"s","iss":"https://romeos.cc"}"#)
                LaunchProtocol.answers["/api/auth/cloud/native/complete"] = (200, #"{"cookie_name":"rome_session","session_token":"renewed","expires_at":"\#(iso(7200))","origin":"https://b.example"}"#)
                let (app, cloud) = model(session: InstanceSession(token: "old", expiresAt: iso(-60), origin: "https://b.example"))
                await app.launch(skipSnapshot: true)
                #expect(app.phase == .ready)
                #expect(await eventually { cloud.storedSession(for: Self.b)?.token == "renewed" })
                #expect(await eventually { app.workspace?.mainChatServerID == "main-1" })
                #expect(app.workspace?.conciergeState == .ready)
                #expect(app.phase == .ready)
                #expect(LaunchProtocol.refusedPaths.isEmpty, "sent on the old token: \(LaunchProtocol.refusedPaths)")
            }
        }

        /// Taken off the kept instance's allow-list while the app was closed:
        /// another running instance opens in its place.
        @Test func accessRevokedAtLaunchOpensAnotherInstance() async {
            await clean {
                LaunchProtocol.answers["/v1/instances"] = (200, #"{"items":[{"id":"b","name":"B","slug":"b","origin":"https://b.example","status":"running","role":"visitor"},{"id":"c","name":"C","slug":"c","origin":"https://c.example","status":"running"}]}"#)
                // The visitor sign-in says the dashboard no longer lets this account in.
                LaunchProtocol.answers["/api/auth/visitor/native/start"] = (404, #"{"error":"dashboard_not_cloud_email_restricted"}"#)
                var visitorB = Self.b
                visitorB.role = "visitor"
                let (app, _) = model(
                    session: InstanceSession(token: "old", expiresAt: iso(-60), origin: "https://b.example", cookieName: InstanceSession.visitorCookie),
                    record: visitorB,
                    others: [InstanceSession(token: "c-token", expiresAt: iso(3600), origin: "https://c.example")]
                )
                await app.launch(skipSnapshot: true)
                #expect(await eventually { app.currentInstanceID == "c" })
            }
        }

        /// Signed out while Rome Cloud's list was on its way: the late answer
        /// changes nothing.
        @Test func aSignOutDuringTheCatchUpIsNotUndone() async {
            await clean {
                list("stopped")
                LaunchProtocol.slow["/v1/instances"] = 0.3
                let (app, _) = model(session: fresh)
                await app.launch(skipSnapshot: true)
                await app.signOut()
                try? await Task.sleep(for: .milliseconds(600))
                #expect(app.phase == .signedOut)
            }
        }

        /// The instance refused the kept session and Rome Cloud says it moved:
        /// it opens on its new origin, not the sign-in page.
        @Test func aMovedInstanceOpensOnItsNewOrigin() async {
            await clean {
                LaunchProtocol.answers["/api/auth/cloud/native/start"] = (404, "{}")
                LaunchProtocol.answers["/v1/instances"] = (200, #"{"items":[{"id":"b","name":"B","slug":"b","origin":"https://b2.example","status":"running"}]}"#)
                let (app, _) = model(
                    session: InstanceSession(token: "old", expiresAt: iso(-60), origin: "https://b.example"),
                    others: [InstanceSession(token: "b2", expiresAt: iso(3600), origin: "https://b2.example")]
                )
                await app.launch(skipSnapshot: true)
                #expect(await eventually { app.webURL?.host() == "b2.example" && app.workspace != nil })
                #expect(await eventually { app.phase == .ready })
            }
        }

        /// Two requests refused at once share one renewal, and both go again
        /// with the new token: the one that joined it too.
        @Test func twoRefusedRequestsBothGoAgainWithTheNewToken() async {
            await clean {
                list("running")
                LaunchProtocol.refused = "old"
                LaunchProtocol.answers["/api/auth/cloud/native/start"] = (200, #"{"authorization_request":{"client_id":"rome-instance","state":"s"},"origin":"https://b.example"}"#)
                LaunchProtocol.answers["/v1/instances/b/authorizations"] = (200, #"{"code":"c","state":"s","iss":"https://romeos.cc"}"#)
                LaunchProtocol.answers["/api/auth/cloud/native/complete"] = (200, #"{"cookie_name":"rome_session","session_token":"renewed","expires_at":"\#(iso(7200))","origin":"https://b.example"}"#)
                LaunchProtocol.answers["/api/concierge/session"] = (200, #"{"id":"main-1","unread":0}"#)
                LaunchProtocol.answers["/api/concierge/chats"] = (200, #"{"chats":[]}"#)
                // Looks fresh here; the instance no longer takes it.
                let (app, _) = model(session: InstanceSession(token: "old", expiresAt: iso(3600), origin: "https://b.example"))
                await app.launch(skipSnapshot: true)
                guard let backend = app.workspace?.backend else { Issue.record("no workspace"); return }
                async let first = try? backend.conciergeSession()
                async let second = try? backend.conciergeChats()
                let (session, chats) = await (first, second)
                #expect(session?.id == "main-1")
                #expect(chats != nil)
            }
        }

        /// A request on a session the instance refuses is sent once more after
        /// the renewal: a send is never left failed by a session about to change.
        @Test func aRefusedRequestGoesAgainAfterRenewal() async {
            await clean {
                LaunchProtocol.refused = "old"
                LaunchProtocol.answers["/api/concierge/session"] = (200, #"{"id":"main-1","unread":0}"#)
                let box = TokenBox()
                box.token = "old"
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [LaunchProtocol.self]
                let client = APIClient(origin: URL(string: "https://b.example")!, token: { box.token }, configuration: configuration, renew: {
                    box.token = "new"
                    return true
                })
                let info: ConciergeSessionInfo? = try? await client.get("/concierge/session")
                #expect(info?.id == "main-1")
                #expect(LaunchProtocol.refusedPaths == ["/api/concierge/session"])
            }
        }

        /// Rome Cloud renamed the kept instance: the name and the kept record follow.
        @Test func theKeptRecordCatchesUp() async {
            await clean {
                LaunchProtocol.answers["/v1/instances"] = (200, #"{"items":[{"id":"b","name":"Team B","slug":"b","origin":"https://b.example","status":"running"}]}"#)
                let (app, _) = model(session: fresh)
                await app.launch(skipSnapshot: true)
                #expect(await eventually { app.workspace?.instanceName == "Team B" })
                let kept = UserDefaults.standard.data(forKey: "lastInstanceRecord").flatMap { try? JSONDecoder().decode(CloudInstance.self, from: $0) }
                #expect(kept?.name == "Team B")
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
                #expect(await eventually { app.chatRequest.serial == 1 })
            }
        }

        /// A widget tap that launched the app is followed once the kept
        /// instance is open, by the shell of that instance only. Fails before
        /// the fix: the cached launch never routed it.
        @Test func aWidgetTapThatLaunchedTheAppIsFollowed() async {
            await clean {
                LaunchProtocol.offline = true
                let (app, _) = model(session: fresh)
                await app.openFromWidget(.newApp)
                await app.launch(skipSnapshot: true)
                #expect(await eventually { app.widgetRequest != nil })
                #expect(app.takeWidgetLink(for: "other") == nil)
                #expect(app.takeWidgetLink(for: "b") == .newApp)
                #expect(app.widgetRequest == nil)
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
}

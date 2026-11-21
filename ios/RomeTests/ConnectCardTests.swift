import Foundation
import Testing
@testable import Rome

@MainActor
private final class FakeBrowser: ConnectBrowser {
    var opened: [URL] = []
    var closed = 0
    func open(_ url: URL) { opened.append(url) }
    func close() { closed += 1 }
}

@MainActor
private func runner(_ backend: FakeBackend, _ browser: FakeBrowser, dashboard: @escaping (URL) -> Void = { _ in }, attempts: Int = 5) -> ConnectRunner {
    var runner = ConnectRunner(backend: backend, browser: browser, openDashboard: dashboard, origin: URL(string: "https://me.romeos.cc")!)
    runner.sleep = { _ in }
    runner.attempts = attempts
    return runner
}

private let oauth = MessagePart.ConnectEntry.romeOAuth(url: "https://romeos.cc/connect/github", available: true, unavailableReason: nil)
private let composio = MessagePart.ConnectEntry.composio(
    method: "POST", path: "/api/apps/connector/connect", body: .object(["provider": .string("gmail")]),
    needsLogin: true, login: (method: "POST", path: "/api/apps/connector/login/start")
)

@Suite @MainActor struct ConnectRunnerTests {
    /// Rome Cloud's sign-in: open its page, watch the list, then tell Chat.
    @Test func romeOAuthOpensTheSignInAndWaitsForTheService() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        backend.connectorReads = [
            [ConnectorState(service: "github", state: nil, connect: oauth)],
            [ConnectorState(service: "github", state: nil, connect: oauth)],
            [ConnectorState(service: "github", state: "working", account: "lin-dev")],
        ]
        let phase = await runner(backend, browser).run(service: "github", chatId: "c-1")
        #expect(phase == .connected(account: "lin-dev"))
        #expect(browser.opened.map(\.absoluteString) == ["https://romeos.cc/connect/github"])
        #expect(browser.closed == 1)
        #expect(backend.connectCalls.isEmpty)
        #expect(backend.notified.map(\.chatId) == ["c-1"])
        #expect(backend.notified.map(\.service) == ["github"])
    }

    /// Composio: sign in first, asking again while it says not yet, then start and open the link it answers.
    @Test func composioSignsInThenStarts() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        backend.connectorReads = [
            [ConnectorState(service: "gmail", state: nil, connect: composio)],
            [ConnectorState(service: "gmail", state: "working", account: "lin@example.com")],
        ]
        backend.replies = [
            "/api/apps/connector/login/start": [ConnectReply(ok: true, body: .object(["loginUrl": .string("https://composio.dev/login?x=1"), "cliKey": .string("k-9")]))],
            "/api/apps/connector/login/complete": [
                ConnectReply(ok: false, body: .object(["error": .string("login_not_authorized")])),
                ConnectReply(ok: true, body: .object([:])),
            ],
            "/api/apps/connector/connect": [ConnectReply(ok: true, body: .object(["authorizationUrl": .string("https://accounts.google.com/o/oauth2/auth?x")]))],
        ]
        let phase = await runner(backend, browser).run(service: "gmail", chatId: "c-1")
        #expect(phase == .connected(account: "lin@example.com"))
        #expect(backend.connectCalls.map(\.path) == [
            "/api/apps/connector/login/start",
            "/api/apps/connector/login/complete",
            "/api/apps/connector/login/complete",
            "/api/apps/connector/connect",
        ])
        #expect(backend.connectCalls[1].body == .object(["cliKey": .string("k-9")]))
        #expect(backend.connectCalls[3].body == .object(["provider": .string("gmail")]))
        #expect(browser.opened.map(\.host) == ["composio.dev", "accounts.google.com"])
    }

    /// The entry read now wins over the saved one: a sign-in done since is not asked again.
    @Test func composioAlreadySignedInAndConnected() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        let signedIn = MessagePart.ConnectEntry.composio(method: "POST", path: "/api/apps/connector/connect", body: .object(["provider": .string("gmail")]), needsLogin: false, login: nil)
        backend.connectorReads = [[ConnectorState(service: "gmail", state: nil, connect: signedIn)], [ConnectorState(service: "gmail", state: "working")]]
        backend.replies = ["/api/apps/connector/connect": [ConnectReply(ok: true, body: .object(["alreadyConnected": .bool(true)]))]]
        #expect(await runner(backend, browser).run(service: "gmail", chatId: "c-1") == .connected(account: nil))
        #expect(backend.connectCalls.map(\.path) == ["/api/apps/connector/connect"])
        #expect(browser.opened.isEmpty)
    }

    @Test func aSignInThatFailsSaysWhy() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        backend.connectorReads = [[ConnectorState(service: "gmail", state: nil, connect: composio)]]
        backend.replies = [
            "/api/apps/connector/login/start": [ConnectReply(ok: true, body: .object(["loginUrl": .string("https://composio.dev/login"), "cliKey": .string("k")]))],
            "/api/apps/connector/login/complete": [ConnectReply(ok: false, body: .object(["error": .string("expired"), "message": .string("The sign-in link expired")]))],
        ]
        #expect(await runner(backend, browser).run(service: "gmail", chatId: nil) == .failed("The sign-in link expired"))
        #expect(browser.closed == 1)
    }

    /// Only the dashboard can connect it: its Connections page on the instance.
    @Test func dashboardOpensSettingsOnTheWeb() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        var opened: [URL] = []
        backend.connectorReads = [[ConnectorState(service: "telegram", state: nil, connect: .dashboard)]]
        _ = await runner(backend, browser, dashboard: { opened.append($0) }, attempts: 1).run(service: "telegram", chatId: nil)
        #expect(opened.map(\.absoluteString) == ["https://me.romeos.cc/settings/connections"])
        #expect(browser.opened.isEmpty)
    }

    /// Working already when tapped: Connected, and Chat hears of it.
    @Test func alreadyWorkingConnectsAtOnce() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        backend.connectorReads = [[ConnectorState(service: "github", state: "working", account: "lin-dev")]]
        #expect(await runner(backend, browser).run(service: "github", chatId: "c-1") == .connected(account: "lin-dev"))
        #expect(browser.opened.isEmpty)
        #expect(backend.notified.count == 1)
    }

    /// Rome Cloud cannot connect it here: the reason, and nothing opens.
    @Test func unavailableShowsTheReason() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        let entry = MessagePart.ConnectEntry.romeOAuth(url: nil, available: false, unavailableReason: "Rome Cloud cannot connect Slack yet")
        backend.connectorReads = [[ConnectorState(service: "slack", state: nil, connect: entry)]]
        #expect(await runner(backend, browser).run(service: "slack", chatId: "c-1") == .failed("Rome Cloud cannot connect Slack yet"))
        #expect(browser.opened.isEmpty)
        #expect(backend.notified.isEmpty)
    }

    /// The guardian never finishes: after the last check, not connected yet, and nobody told.
    @Test func timesOutAfterTheLastCheck() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        backend.connectorReads = [[ConnectorState(service: "github", state: nil, connect: oauth)]]
        #expect(await runner(backend, browser, attempts: 3).run(service: "github", chatId: "c-1") == .failed(nil))
        // One read before starting, then one per check.
        #expect(backend.connectorReadCount == 4)
        #expect(backend.notified.isEmpty)
        #expect(browser.closed == 1)
    }

    @Test func aListThatCannotBeReadSaysSo() async {
        let backend = FakeBackend()
        backend.connectorReads = [nil]
        #expect(await runner(backend, FakeBrowser()).run(service: "github", chatId: nil) == .failed(String(localized: "Could not check the connection")))
    }

    /// A start call answering a script link opens nothing.
    @Test func aScriptLinkNeverOpens() async {
        let backend = FakeBackend()
        let browser = FakeBrowser()
        let entry = MessagePart.ConnectEntry.composio(method: "POST", path: "/api/apps/connector/connect", body: .object([:]), needsLogin: false, login: nil)
        backend.connectorReads = [[ConnectorState(service: "x", state: nil, connect: entry)]]
        backend.replies = ["/api/apps/connector/connect": [ConnectReply(ok: true, body: .object(["redirectUrl": .string("javascript:alert(1)")]))]]
        #expect(await runner(backend, browser).run(service: "x", chatId: nil) == .failed(String(localized: "Connection did not start")))
        #expect(browser.opened.isEmpty)
    }

    /// The card opens a link on the card's own check: an already working service shows Connected and tells nobody.
    @Test func aWorkingServiceShowsConnectedOnLoadWithoutTellingChat() async {
        let backend = FakeBackend()
        backend.connectorReads = [[ConnectorState(service: "github", state: "working", account: "lin-dev")]]
        let store = TranscriptStore(sessionId: "c-1", kind: .concierge, backend: backend)
        let part = MessagePart.ConnectCardPart(service: "github", label: "GitHub", icon: "brand:github", connect: oauth)
        await store.checkConnected(part, rowId: "m:0")
        #expect(store.connectPhases["m:0"] == .connected(account: "lin-dev"))
        #expect(backend.notified.isEmpty)
    }
}

@Suite struct ConnectRulesTests {
    private let origin = URL(string: "https://me.romeos.cc")!

    /// Only plain /api/ paths on the instance; the session cookie never leaves it.
    @Test func callsStayOnTheInstance() {
        #expect(ConnectRunner.apiPath("/api/apps/connector/connect") == "/api/apps/connector/connect")
        for bad in ["https://evil.example/api/x", "/apps/x", "/api/../auth/logout", "//evil.example/api/x", nil] {
            #expect(ConnectRunner.apiPath(bad) == nil)
        }
        #expect(APIClient.instanceURL(origin: origin, apiPath: "/api/apps/connector/connect")?.absoluteString == "https://me.romeos.cc/api/apps/connector/connect")
        #expect(APIClient.instanceURL(origin: origin, apiPath: "https://evil.example/api/x") == nil)
        #expect(APIClient.instanceURL(origin: origin, apiPath: "/api//evil.example") == nil)
        #expect(APIClient.instanceURL(origin: origin, apiPath: "/api/x?redirect=1") == nil)
    }

    /// Links open only on http or https; a relative one is on the instance.
    @Test func linksAreWebAddresses() {
        #expect(ConnectRunner.webURL("https://accounts.google.com/x", origin: origin)?.host == "accounts.google.com")
        #expect(ConnectRunner.webURL("/settings/connections", origin: origin)?.absoluteString == "https://me.romeos.cc/settings/connections")
        for bad in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "rome://app/x", ""] {
            #expect(ConnectRunner.webURL(bad, origin: origin) == nil)
        }
        // authorizationUrl, then redirectUrl, then loginUrl, as the web reads them.
        #expect(ConnectRunner.linkOf(.object(["redirectUrl": .string("https://b.example"), "authorizationUrl": .string("https://a.example")]), origin: origin)?.host == "a.example")
    }

    @Test func readsEveryEntryKind() throws {
        let card = MessagePart.parse(#"[{"type":"connect_card","service":"gmail","label":"Gmail","icon":"glyph:gmail","connect":{"kind":"composio","method":"POST","path":"/api/apps/connector/connect","body":{"provider":"gmail"},"needsLogin":true,"login":{"method":"POST","path":"/api/apps/connector/login/start"}}}]"#)
        guard case .connectCard(let part) = try #require(card.first) else { Issue.record("not a connect card"); return }
        #expect(part.service == "gmail" && part.label == "Gmail" && part.icon == "glyph:gmail")
        guard case .composio(_, let path, _, let needsLogin, let login) = part.connect else { Issue.record("not composio"); return }
        #expect(path == "/api/apps/connector/connect" && needsLogin && login?.path == "/api/apps/connector/login/start")
        // A card written before `icon` existed, and an unknown kind: the dashboard's way in.
        let old = MessagePart.parse(#"[{"type":"connect_card","service":"x","label":"X","connect":{"kind":"later"}}]"#)
        guard case .connectCard(let oldPart) = try #require(old.first) else { Issue.record("not a connect card"); return }
        #expect(oldPart.icon == nil && oldPart.connect == .dashboard)
    }
}

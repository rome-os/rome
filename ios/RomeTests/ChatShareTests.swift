import Foundation
import SwiftUI
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", turn: String?, at seconds: TimeInterval, session: String = "chat-1") -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, turnId: turn, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

/// Two turns, each the guardian's message and the replies to it.
private let twoTurns = [
    message("u1", role: "user", "Plan the trip", turn: "t1", at: 0),
    message("a1", "Here is a plan", turn: "t1", at: 10),
    message("a2", "Shall I book it?", turn: "t1", at: 11),
    message("u2", role: "user", "Check the weather", turn: "t2", at: 60),
    message("a3", "Mild, bring a jacket", turn: "t2", at: 70),
]

/// Picking turns in share mode, and what the share sheet then offers.
@MainActor
@Suite struct ChatShareTests {
    /// On an instance that makes links unless the test says otherwise.
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage], session: String = "chat-1") async -> TranscriptStore {
        backend.stored = messages
        if backend.buildVersion == nil { backend.buildVersion = ShareGate.minimumVersion }
        let store = TranscriptStore(sessionId: session, kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    @Test func rowsGroupIntoTurnsByTheirMessages() {
        let rows = TranscriptBuilder.rows(messages: twoTurns, pending: [], answers: [:], options: .init())
        let turns = ShareTurns(messages: twoTurns, rows: rows)
        #expect(turns.order == ["t1", "t2"])
        // Every bubble belongs to its turn; the time line belongs to none.
        for row in rows {
            switch row {
            case .separator: #expect(turns.turnOfRow[row.id] == nil)
            default: #expect(turns.turnOfRow[row.id] != nil)
            }
        }
        #expect(turns.turnOfRow["a2:0"] == "t1" && turns.turnOfRow["a3:0"] == "t2")
        // The check circle sits on each turn's first row: the guardian's message.
        #expect(turns.leadRows == ["u1:0", "u2:0"])
    }

    @Test func rowsOfNoStoredTurnAreLeftOut() {
        let messages = [message("old", role: "user", "Before turns", turn: nil, at: 0)] + twoTurns
        let pending = [PendingSend(id: "p1", text: "Sending", createdAt: Date(timeIntervalSince1970: 1_800_000_200), state: .sending)]
        let rows = TranscriptBuilder.rows(messages: messages, pending: pending, answers: [:], options: .init())
        let turns = ShareTurns(messages: messages, rows: rows)
        #expect(turns.order == ["t1", "t2"])
        #expect(turns.turnOfRow["old:0"] == nil && turns.turnOfRow["p1"] == nil)
    }

    /// The circle takes no space from the row that starts a turn: beside the
    /// guardian's bubble, left of an Agent bubble that moves over, or on a
    /// card's corner.
    @Test func everyKindOfRowPlacesTheCircle() {
        let rows = TranscriptBuilder.rows(messages: twoTurns, pending: [], answers: [:], options: .init())
        #expect(rows.first { if case .userText = $0 { true } else { false } }.map(ShareCirclePlacement.of) == .gutter)
        #expect(rows.first { if case .agentText = $0 { true } else { false } }.map(ShareCirclePlacement.of) == .shift)
        #expect(ShareCirclePlacement.of(.taskCard(id: "m:0", chatId: "c", title: "T")) == .corner)
        #expect(ShareCirclePlacement.of(.error(id: "m:0", text: "x")) == .corner)
        #expect(ShareCirclePlacement.of(.tools(id: "tools-m", traceMessageId: "m", count: 2)) == .corner)
    }

    @Test func aRowIdNamesItsMessage() {
        #expect(ShareTurns.messageId(ofRow: "m1:2") == "m1")
        #expect(ShareTurns.messageId(ofRow: "tools-m1") == "m1")
        #expect(ShareTurns.messageId(ofRow: "replies-m1") == "m1")
        #expect(ShareTurns.messageId(ofRow: "sep-m1") == nil)
    }

    @Test func aMessagesShareOpensShareModeOnItsTurn() async {
        let store = await chat(FakeBackend(), twoTurns)
        let share = store.share
        #expect(!share.isSelecting)
        // Share on a reply picks the whole turn it answers.
        share.begin(fromRow: "a2:0")
        #expect(share.isSelecting && share.selection == ["t1"])
        share.toggle("t2")
        #expect(share.count == 2)
        share.toggle("t1")
        #expect(share.selection == ["t2"])
        share.toggle("t2")
        // Nothing picked still is share mode, with Create link off.
        #expect(share.isSelecting && share.count == 0)
        share.cancel()
        #expect(!share.isSelecting)
    }

    @Test func shareModeClosesAnOpenThread() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        store.openThread(at: "a1", toReply: false)
        store.share.begin(fromRow: "a1:0")
        #expect(store.thread == nil)
    }

    @Test func createSendsThePickedTurnsInOrderAndOffersTheLink() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        let share = store.share
        share.begin(turn: "t2")
        share.toggle("t1")
        await share.create()
        #expect(backend.shareRequests.count == 1)
        #expect(backend.shareRequests.first?.sessionId == "chat-1")
        #expect(backend.shareRequests.first?.turnIds == ["t1", "t2"])
        // The share sheet gets the link on the instance, titled; share mode ends.
        #expect(share.outgoing?.url?.absoluteString == "https://test/share/tok1")
        #expect(share.outgoing?.title == "Trip")
        #expect(!share.isSelecting && !share.creating && share.error == nil)
    }

    @Test func theMainChatSharesByItsServerID() async {
        let backend = FakeBackend()
        let messages = twoTurns.map { m -> ChatMessage in var m = m; m.sessionId = "server-main"; return m }
        let store = await chat(backend, messages, session: conciergeChatID)
        store.share.begin(turn: "t2")
        await store.share.create()
        #expect(backend.shareRequests.first?.sessionId == "server-main")
    }

    @Test func absoluteLinksStayAsTheyAre() {
        let origin = URL(string: "https://me.romeos.cc")
        #expect(ChatShareFlow.absoluteURL("/share/x", origin: origin)?.absoluteString == "https://me.romeos.cc/share/x")
        #expect(ChatShareFlow.absoluteURL("https://other.example/share/x", origin: origin)?.absoluteString == "https://other.example/share/x")
        #expect(ChatShareFlow.absoluteURL("/share/x", origin: nil) == nil)
    }

    /// An instance before the gate would publish the work behind the turns:
    /// it is never asked for a link, and the turns' text is shared instead.
    @Test func anInstanceBeforeTheGateGetsTheTextShared() async {
        for version in ["1.1.190", "dev"] {
            let backend = FakeBackend()
            backend.buildVersion = version
            let store = await chat(backend, twoTurns)
            let share = store.share
            share.begin(turn: "t2")
            await share.create()
            #expect(backend.shareRequests.isEmpty, "\(version)")
            #expect(share.outgoing?.url == nil)
            #expect(share.outgoing?.text == "Check the weather\n\nMild, bring a jacket")
            #expect(!share.isSelecting && share.error == nil)
        }
    }

    @Test func onlyAKnownVersionAtTheGateMakesLinks() {
        #expect(!ShareGate.makesLinks(version: nil))
        #expect(!ShareGate.makesLinks(version: "dev"))
        #expect(!ShareGate.makesLinks(version: "1.1.190"))
        #expect(ShareGate.makesLinks(version: ShareGate.minimumVersion))
        #expect(ShareGate.makesLinks(version: "v1.2.0"))
    }

    /// Cancel while the version is read: no link is asked for, nothing to share.
    @Test func cancelBeforeTheLinkIsMadeSendsNothing() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        let share = store.share
        backend.duringBuildInfo = { share.cancel() }
        share.begin(turn: "t1")
        await share.create()
        #expect(backend.shareRequests.isEmpty)
        #expect(share.outgoing == nil && !share.isSelecting && share.error == nil)
    }

    /// Cancel once the link is being made: the link is revoked, unseen.
    @Test func cancelAfterTheLinkIsMadeRevokesIt() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        let share = store.share
        backend.duringShare = { share.cancel() }
        share.begin(turn: "t1")
        await share.create()
        #expect(backend.shareRequests.count == 1)
        #expect(backend.revoked == ["s1"])
        #expect(share.outgoing == nil && !share.isSelecting && share.error == nil)
    }

    /// Picks changed while the link was made: that link is revoked, and share
    /// mode stays with the new picks.
    @Test func picksChangedDuringCreateRevokeTheLink() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        let share = store.share
        backend.duringShare = { share.toggle("t2") }
        share.begin(turn: "t1")
        await share.create()
        #expect(backend.revoked == ["s1"])
        #expect(share.outgoing == nil && share.selection == ["t1", "t2"])
    }

    /// A version that cannot be read is no proof of an old instance: an
    /// error, share mode stays, and nothing is shared.
    @Test func aFailedVersionReadIsAnError() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        backend.buildVersion = nil
        store.share.begin(turn: "t1")
        await store.share.create()
        #expect(backend.shareRequests.isEmpty)
        #expect(store.share.outgoing == nil)
        #expect(store.share.isSelecting && store.share.selection == ["t1"] && store.share.error != nil)
    }

    /// Share mode leaves a quoted reply, and where its draft goes, as it was.
    @Test func shareModeKeepsAQuotedReply() async throws {
        let messages = twoTurns.map { m -> ChatMessage in var m = m; m.knowsThreads = true; return m }
        let store = await chat(FakeBackend(), messages)
        store.reply(to: "a3")
        let quote = try #require(store.quote)
        #expect(store.composerThread == quote)
        store.share.begin(fromRow: "a1:0")
        #expect(store.quote == quote)
        store.share.cancel()
        #expect(store.quote == quote && store.composerThread == quote)
    }

    /// Past the gate a refused share is an error, never a silent text share.
    @Test func aNotFoundPastTheGateIsAnError() async {
        let backend = FakeBackend()
        backend.shareAnswer = .failure(.notFound)
        let store = await chat(backend, twoTurns)
        store.share.begin(turn: "t1")
        await store.share.create()
        #expect(store.share.outgoing == nil)
        #expect(store.share.isSelecting && store.share.error != nil)
    }

    @Test func aFailedCreateStaysInShareModeWithALine() async {
        let backend = FakeBackend()
        backend.shareAnswer = .failure(.network)
        let store = await chat(backend, twoTurns)
        let share = store.share
        share.begin(turn: "t1")
        await share.create()
        #expect(share.outgoing == nil)
        #expect(share.isSelecting && share.selection == ["t1"])
        #expect(share.error != nil)
    }

    @Test func revokeRemovesTheLink() async {
        let backend = FakeBackend()
        backend.shareLinks = [
            ChatShareLink(id: "old", url: "/share/old", title: "Old", createdAt: "2026-11-01T10:00:00Z"),
            ChatShareLink(id: "new", url: "/share/new", title: "New", createdAt: "2026-11-09T10:00:00Z"),
        ]
        let store = await chat(backend, twoTurns)
        let share = store.share
        await share.loadLinks()
        // Newest first.
        #expect(share.links?.map(\.id) == ["new", "old"])
        await share.revoke(share.links![0])
        #expect(backend.revoked == ["new"])
        #expect(share.links?.map(\.id) == ["old"])
    }

    /// A refused revoke puts that link back into the list as it is by then,
    /// not the list from before: a link made meanwhile stays.
    @Test func aRefusedRevokePutsOnlyThatLinkBack() async {
        let backend = FakeBackend()
        let a = ChatShareLink(id: "a", url: "/share/a", createdAt: "2026-11-01T10:00:00Z")
        let b = ChatShareLink(id: "b", url: "/share/b", createdAt: "2026-11-05T10:00:00Z")
        let c = ChatShareLink(id: "c", url: "/share/c", createdAt: "2026-11-09T10:00:00Z")
        backend.shareLinks = [a, b]
        backend.revokeError = .network
        let store = await chat(backend, twoTurns)
        await store.share.loadLinks()
        backend.duringRevoke = {
            backend.shareLinks = [c, b]
            await store.share.loadLinks()
        }
        await store.share.revoke(a)
        #expect(store.share.links?.map(\.id) == ["c", "b", "a"])
        #expect(store.share.revokeFailed)
    }

    /// A link the instance no longer knows was revoked already.
    @Test func revokingAGoneLinkRemovesItQuietly() async {
        let backend = FakeBackend()
        backend.shareLinks = [ChatShareLink(id: "a", url: "/share/a")]
        backend.revokeError = .notFound
        let store = await chat(backend, twoTurns)
        await store.share.loadLinks()
        await store.share.revoke(store.share.links![0])
        #expect(store.share.links?.isEmpty == true)
        #expect(!store.share.revokeFailed)
    }

    @Test func aNewLinkJoinsTheLoadedList() async {
        let backend = FakeBackend()
        let store = await chat(backend, twoTurns)
        await store.share.loadLinks()
        #expect(store.share.links?.isEmpty == true)
        store.share.begin(turn: "t2")
        await store.share.create()
        #expect(store.share.links?.map(\.id) == ["s1"])
    }

    @Test func aShareLinkDecodesWithOrWithoutItsDate() throws {
        let listed = try JSONDecoder().decode([ChatShareLink].self, from: Data(#"[{"id":"a","title":"T","url":"/share/a","createdAt":"2026-11-09T10:00:00.000Z"}]"#.utf8))
        #expect(listed.first?.date != nil)
        let created = try JSONDecoder().decode(ChatShareLink.self, from: Data(#"{"id":"b","url":"/share/b","title":"T"}"#.utf8))
        #expect(created.date == nil && created.url == "/share/b")
    }
}

/// Where each row lies on screen, as the hosted transcript reports it.
@MainActor
private final class RowFrames {
    var frames: [String: CGRect] = [:]
}

/// A chat on a phone-sized screen with share mode's pieces: the rows and
/// a composer-sized bar under them.
private struct ShareModeHost: View {
    let store: TranscriptStore
    let log: RowFrames

    var body: some View {
        TranscriptList(store: store) { row, previous in
            bubble(row)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { log.frames[row.id] = $0 }
                .shareSelectable(row, share: store.share, top: TranscriptSpacing.top(row, after: previous))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Color.gray.frame(height: 52)
                .shareModeComposer(store.share)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func bubble(_ row: TranscriptRow) -> some View {
        switch row {
        case .userText(_, let text, _, let pending): UserBubble(text: text, pending: pending)
        case .agentText(_, let text, _, let forwarded, let position): AgentBubble(text: text, forwardedFrom: forwarded, position: position)
        case .separator(_, let date): TimeSeparator(date: date)
        default: EmptyView()
        }
    }
}

/// Entering and leaving share mode leaves every row where it was, the
/// tapped turn included: no row changes width or height, so text wraps
/// the same, and the space under the transcript stays the same.
@MainActor
@Suite struct ShareModeLayoutTests {
    @Test func rowsHoldStillAsShareModeComesAndGoes() async throws {
        // Long lines, so a narrower row would wrap differently and grow.
        let line = "Sure — here is the plan for the whole week, with the times, the places and who to call first."
        var messages: [ChatMessage] = []
        for index in 0..<24 {
            let at = TimeInterval(index * 30)
            messages.append(message("u\(index)", role: "user", "\(index). \(line)", turn: "t\(index)", at: at))
            messages.append(message("a\(index)", "\(line) \(line)", turn: "t\(index)", at: at + 5))
        }
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }

        let log = RowFrames()
        let host = UIHostingController(rootView: ShareModeHost(store: store, log: log))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        try await Task.sleep(for: .milliseconds(800))

        let screen = window.bounds
        func onScreen() -> [String: CGRect] { log.frames.filter { $0.value.intersects(screen) } }
        let before = onScreen()
        // A turn in the middle of the screen, entered from its reply's Share.
        let middle = try #require(before.filter { $0.key.hasPrefix("a") }.min { abs($0.value.midY - screen.midY) < abs($1.value.midY - screen.midY) })
        #expect(before.count > 4)

        store.share.begin(fromRow: middle.key)
        #expect(store.share.isSelecting)
        try await Task.sleep(for: .milliseconds(600))
        let selecting = log.frames
        for (id, frame) in before {
            let now = try #require(selecting[id])
            #expect(abs(now.minY - frame.minY) < 0.5, "\(id) moved from \(frame.minY) to \(now.minY)")
            #expect(abs(now.height - frame.height) < 0.5, "\(id) changed height from \(frame.height) to \(now.height)")
            // The same width, so the same line breaks.
            #expect(abs(now.width - frame.width) < 0.5, "\(id) changed width from \(frame.width) to \(now.width)")
        }

        store.share.cancel()
        try await Task.sleep(for: .milliseconds(600))
        for (id, frame) in before {
            let now = try #require(log.frames[id])
            #expect(abs(now.minY - frame.minY) < 0.5 && abs(now.height - frame.height) < 0.5 && abs(now.width - frame.width) < 0.5, "\(id) did not come back")
        }
    }
}

/// Records each request with its body, and answers a created share.
final class ShareRequestRecorder: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [(URLRequest, Data)] = []
    static var requests: [(URLRequest, Data)] { lock.withLock { recorded } }
    static func reset() { lock.withLock { recorded = [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        Self.lock.withLock { Self.recorded.append((request, body)) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"id":"s1","url":"/share/tok1","title":"Plan the trip"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// What a share request tells the instance.
@MainActor
@Suite(.serialized) struct ShareRequestTests {
    private func backend() -> LiveBackend {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ShareRequestRecorder.self]
        return LiveBackend(client: APIClient(origin: URL(string: "http://127.0.0.1:4141")!, token: { "t" }, configuration: configuration))
    }

    private func lastBody() throws -> [String: Any] {
        let (request, body) = try #require(ShareRequestRecorder.requests.last)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/chat/sessions/chat-1/share")
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test func aShareSendsTheTurnsAndTheAgentsNameButNoTitle() async throws {
        ShareRequestRecorder.reset()
        let link = try await backend().shareChat(sessionId: "chat-1", turnIds: ["t1", "t2"], agentName: "Milo")
        #expect(link.url == "/share/tok1")
        let body = try lastBody()
        #expect(body["turnIds"] as? [String] == ["t1", "t2"])
        #expect(body["agentName"] as? String == "Milo")
        // The instance names the share after the first turn.
        #expect(body["title"] == nil)
        // Turns only: never a chat's saved tiles, such as a project's files.
        #expect((body["layout"] as? [Any])?.isEmpty == true)
    }

    @Test func anUnknownAgentNameIsLeftOut() async throws {
        ShareRequestRecorder.reset()
        _ = try await backend().shareChat(sessionId: "chat-1", turnIds: ["t1"], agentName: nil)
        let body = try lastBody()
        #expect(body.keys.sorted() == ["layout", "turnIds"])
    }

    @Test func createLinkPassesTheAgentsName() async {
        let fake = FakeBackend()
        fake.stored = twoTurns
        fake.buildVersion = ShareGate.minimumVersion
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: fake)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        store.share.begin(turn: "t1")
        await store.share.create(agentName: "Milo")
        #expect(fake.shareRequests.first?.agentName == "Milo")
        store.stop()
    }
}

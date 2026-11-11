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
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage], session: String = "chat-1") async -> TranscriptStore {
        backend.stored = messages
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

    @Test func anInstanceThatCannotShareTheChatGetsTheTextShared() async {
        let backend = FakeBackend()
        backend.shareAnswer = .failure(.notFound)
        let store = await chat(backend, twoTurns)
        let share = store.share
        share.begin(turn: "t2")
        await share.create()
        #expect(share.outgoing?.url == nil)
        #expect(share.outgoing?.text == "Check the weather\n\nMild, bring a jacket")
        #expect(!share.isSelecting && share.error == nil)
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

    @Test func aRefusedRevokePutsTheLinkBack() async {
        let backend = FakeBackend()
        backend.shareLinks = [ChatShareLink(id: "a", url: "/share/a")]
        backend.revokeError = .network
        let store = await chat(backend, twoTurns)
        await store.share.loadLinks()
        await store.share.revoke(store.share.links![0])
        #expect(store.share.links?.map(\.id) == ["a"])
        #expect(store.share.revokeFailed)
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

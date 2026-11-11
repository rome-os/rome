import Foundation
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
        #expect(turns.latest == "t2")
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
        // Share chat starts on the newest turn.
        share.beginWithLatest()
        #expect(share.selection == ["t2"])
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
        store.share.beginWithLatest()
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
        store.share.beginWithLatest()
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

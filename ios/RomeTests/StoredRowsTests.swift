import Foundation
import Testing
@testable import Rome

private func message(
    _ id: String, role: String = "assistant", _ text: String = "hi", turn: String? = nil, at seconds: TimeInterval,
    thread: String? = nil, title: String? = nil, parts: [[String: Any]]? = nil
) -> ChatMessage {
    let json = (try? JSONSerialization.data(withJSONObject: parts ?? [["type": "text", "content": text]])) ?? Data()
    let created = RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    return ChatMessage(
        id: id, sessionId: "concierge", turnId: turn, role: role, content: String(bytes: json, encoding: .utf8) ?? "[]",
        createdAt: created, chatThreadId: thread, knowsThreads: true, chatThreadTitle: title
    )
}

/// A chat's rows are built when their inputs change, and what a read gives
/// is always what the builder makes of the inputs held now.
@MainActor
@Suite struct StoredRowsTests {
    private func settle(_ until: () -> Bool) async {
        for _ in 0..<60 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func chat(_ backend: FakeBackend) async -> TranscriptStore {
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle { store.loaded }
        return store
    }

    /// What the builder makes of the store's inputs, as a reader used to get it.
    private func built(_ store: TranscriptStore) -> [TranscriptRow] {
        TranscriptBuilder.rows(
            messages: store.visibleMessages,
            pending: store.pending,
            answers: store.answers,
            options: .init(showThreads: true, showNotices: true, typing: store.showsTyping)
        )
    }

    @Test func theRowsFollowEveryInput() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.stored = [
            message("u1", role: "user", "hi", turn: "t1", at: 0),
            message("a1", "hello", turn: "t1", at: 5)
        ]
        let store = await chat(backend)
        #expect(!store.rows.isEmpty)
        #expect(store.rows == built(store))
        // A live reply.
        let live = LiveTopic.chat("concierge")
        backend.bus.emit(live, .messageInsert(message("a2", "more", turn: "t1", at: 6)))
        #expect(store.rows.contains { $0.id == "a2:0" })
        #expect(store.rows == built(store))
        // A send waits as a pending bubble, then the stored message takes its place.
        store.send("and then?")
        #expect(store.pending.count == 1)
        guard case .userText(_, "and then?", _, .sending?)? = store.rows.last else {
            Issue.record("no pending bubble")
            return
        }
        #expect(store.rows == built(store))
        let id = store.pending[0].id
        backend.bus.emit(live, .messageInsert(message(id, role: "user", "and then?", turn: "t2", at: 20)))
        #expect(store.pending.isEmpty)
        #expect(store.rows == built(store))
        #expect(store.rows.filter { $0.messageId == id }.count == 1)
        store.stop()
    }

    @Test func theTypingDotsComeAndGoWithTheServersWord() async {
        let backend = FakeBackend()
        backend.stored = [message("a1", "hello", turn: "t0", at: 0)]
        let store = await chat(backend)
        let live = LiveTopic.chat("concierge")
        #expect(!store.showsTyping)
        backend.bus.emit(live, .messageWriting(sessionId: "concierge", turnId: "t9", mode: .exact, writing: true))
        #expect(store.showsTyping)
        #expect(store.rows.last == .typing)
        #expect(store.rows == built(store))
        // The server says it stopped: the dots go with it.
        backend.bus.emit(live, .messageWriting(sessionId: "concierge", turnId: "t9", mode: .exact, writing: false))
        #expect(!store.rows.contains(.typing))
        #expect(store.rows == built(store))
        store.stop()
    }

    /// A simulated turn's new message waits behind the dots, out of the rows, and comes in after.
    @Test func aHeldMessageIsOutOfTheRowsUntilItIsReleased() async {
        let backend = FakeBackend()
        backend.stored = [message("a1", "hello", turn: "t0", at: 0)]
        let store = await chat(backend)
        let live = LiveTopic.chat("concierge")
        backend.bus.emit(live, .messageWriting(sessionId: "concierge", turnId: "t9", mode: .simulated, writing: true))
        backend.bus.emit(live, .messageInsert(message("a2", "more", turn: "t9", at: 10)))
        #expect(!store.held.isEmpty)
        #expect(!store.rows.contains { $0.id == "a2:0" })
        #expect(store.rows.last == .typing)
        #expect(store.rows == built(store))
        for _ in 0..<200 where !store.held.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.held.isEmpty)
        #expect(store.rows.contains { $0.id == "a2:0" })
        #expect(store.rows == built(store))
        store.stop()
    }

    /// A message sent again gives way to its copy, and comes back when the copy is dropped.
    @Test func aResendTakesTheOriginalsPlace() async {
        let backend = FakeBackend()
        var failed = message("in-1", role: "user", "lost", at: 0)
        failed.inputState = "failed"
        backend.stored = [failed]
        let store = await chat(backend)
        #expect(store.rows.contains { $0.id == "in-1:0" })
        store.retry("in-1:0")
        #expect(store.resends["in-1"] != nil)
        #expect(!store.rows.contains { $0.id == "in-1:0" })
        #expect(store.rows.contains { $0.id == store.pending.first?.id })
        #expect(store.rows == built(store))
        store.removePending(store.pending[0].id)
        #expect(store.rows.contains { $0.id == "in-1:0" })
        #expect(store.rows == built(store))
        store.stop()
    }

    @Test func aRowKnowsItsMessage() async {
        let backend = FakeBackend()
        backend.stored = [
            message("u1", role: "user", "hi", turn: "t1", at: 0),
            message("a1", "sunny", turn: "t1", at: 5),
            message("u2", role: "user", at: 10, parts: [
                ["type": "reply_to", "messageId": "a1", "author": "agent", "text": "sunny"],
                ["type": "text", "content": "and tomorrow?"]
            ]),
            message("u3", role: "user", at: 20, parts: [
                ["type": "reply_to", "messageId": "gone", "author": "agent", "text": "old"],
                ["type": "text", "content": "and before?"]
            ])
        ]
        let store = await chat(backend)
        func info(_ id: String) -> RowInfo { store.info(for: store.rows.first { $0.id == id }!) }
        #expect(info("u1:0").date == store.message("u1")?.date)
        #expect(info("u1:0").canShare)
        #expect(!info("u2:1").canShare)
        #expect(!info("u1:0").isPending)
        #expect(info("a1:0").canShare)
        // A quote leads to its original when the chat holds it.
        #expect(info("u2:1").quote?.messageId == "a1")
        #expect(info("u2:1").quoteLeads)
        #expect(info("u3:1").quote?.messageId == "gone")
        #expect(!info("u3:1").quoteLeads)
        // Rome's mark follows the event.
        #expect(info("u1:0").mark == nil)
        let mark = LiveEvent.statusReaction(sessionId: "concierge", messageId: "u1", reaction: "working")
        backend.bus.emit(LiveTopic.chat("concierge"), mark)
        #expect(info("u1:0").mark == .working)
        store.stop()
    }

    @Test func aSendThatFailedIsPendingUntilRemoved() async {
        let backend = FakeBackend()
        let store = await chat(backend)
        store.send("lost")
        await settle { if case .failed? = store.pending.first?.state { true } else { false } }
        let row = store.rows.first { $0.isGuardian }!
        #expect(store.info(for: row).isPending)
        #expect(store.info(for: row).date == nil)
        store.actions.remove(row.id)
        #expect(store.pending.isEmpty)
        #expect(store.rows.isEmpty)
        store.stop()
    }

    @Test func aThreadsRowsFollowTheChat() async {
        let backend = FakeBackend()
        let root = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        backend.stored = [root, reply]
        backend.threads["r"] = [root, reply]
        let store = await chat(backend)
        store.openThread(at: "r")
        let thread = store.thread!
        #expect(thread.rows.map(\.id).contains("a1:0"))
        let more = message("a2", "more", at: 20, thread: "r")
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(more))
        #expect(thread.rows.map(\.id).contains("a2:0"))
        #expect(thread.info(for: thread.rows.first { $0.id == "a2:0" }!).date == more.date)
        store.closeThread()
        store.stop()
    }

    @Test func actionsActOnTheirStore() async {
        let backend = FakeBackend()
        backend.stored = [message("a1", "sure", at: 10, thread: "a1", title: "T")]
        let store = await chat(backend)
        var opened: [String] = []
        store.actions.onOpenChat = { id, title in opened.append("\(id) \(title)") }
        store.actions.reply(to: "a1")
        #expect(store.quote?.messageId == "a1")
        store.actions.openThread(at: "a1")
        #expect(store.thread != nil)
        // From a row in the thread view, the view closes first.
        store.actions.openChat("task", "Book", inThread: true)
        #expect(store.thread == nil)
        #expect(opened == ["task Book"])
        store.stop()
    }

    @Test func aShellActionKeepsItsIdentityWhileItsClosureChanges() {
        let action = ShellAction<Int, Int> { $0 + 1 }
        let held = action
        action.run = { $0 * 2 }
        #expect(held === action)
        #expect(held.run(4) == 8)
    }
}

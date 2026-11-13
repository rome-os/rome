import Foundation
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", turn: String? = nil, text: String = "hi", at seconds: TimeInterval, sender: MessageSender? = nil, trace: TraceSummary? = nil, thread: String? = nil) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    var message = ChatMessage(id: id, sessionId: "concierge", turnId: turn, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), traceSummary: trace, chatThreadId: thread, knowsThreads: thread != nil)
    message.sender = sender
    return message
}

/// The review round on the iOS error-states PR.
@MainActor
@Suite struct ReviewRoundTests {
    /// A reply to a thread-only draft goes back to the thread, with no reply to a message.
    @Test func aRestoredThreadOnlyDraftStaysThreadOnly() async {
        let backend = FakeBackend()
        var anchor = message("a1", turn: "t", at: 0, thread: "a1")
        anchor.chatThreadTitle = "Task"
        backend.stored = [anchor]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        store.openThread(at: "a1")
        let saved = try? #require(store.composerThread)
        store.closeThread()
        #expect(store.composerThread == nil)

        // After a relaunch the draft's target comes back.
        let fresh = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await fresh.reload()
        fresh.reopenThread(saved!)
        #expect(fresh.composerThread?.bare == true)
        #expect(fresh.composerThread?.body["replyToMessageId"] == nil)
        #expect(fresh.composerThread?.body["chatThread"] == .string("a1"))
    }

    /// A routine's trace on a turn that took the guardian's own message is not an unprompted reply.
    @Test func aTurnThatTookTheGuardiansMessageIsNeverUnprompted() {
        let source = TraceSummary.InputSource(type: "routine", name: "Daily summary")
        var trace = TraceSummary()
        trace.automatedInput = source
        let automated = MessageSender(kind: "automated", sourceType: "routine", name: "Daily summary")
        let rows = TranscriptBuilder.rows(messages: [
            message("u1", role: "user", turn: "mine", text: "hello", at: 0),
            message("tr1", role: "trace", turn: "mine", at: 1, trace: trace),
            message("a1", turn: "mine", text: "hi back", at: 2),
            message("u2", role: "user", turn: "legacy", text: "run", at: 10, sender: automated),
            message("a2", turn: "legacy", text: "report", at: 11),
            message("u3", role: "user", turn: "both", text: "mine", at: 20),
            message("u4", role: "user", turn: "both", text: "run", at: 21, sender: automated),
            message("a3", turn: "both", text: "mixed", at: 22),
        ], pending: [], answers: [:], options: .init(showNotices: true))
        let labels = rows.compactMap { row -> String? in if case .sourceLabel(_, let text) = row { return text } else { return nil } }
        // Only the turn nobody prompted is labelled.
        #expect(labels == ["Routine · Daily summary"])
    }

    /// An older copy of a task's card is never answerable, expired or not.
    @Test func anOlderExpiredCopyIsNotWaitingOrExpired() throws {
        let json = #"{"kind":"question","id":"q1","messageId":"m","render":null,"since":5,"expired":true}"#
        let card = try #require(TaskAskCard(json: try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))))
        var task = ConciergeTask(id: "k", title: "T", state: .needsUser, createdAt: 0, updatedAt: 0)
        task.status = "ended"
        #expect(TaskAskMode.of(card: card, latest: false, task: task) == .open)
        #expect(TaskAskMode.of(card: card, latest: true, task: task) == .expired)
    }

    /// Closing the chat ends the poll, and a late result does not start it again.
    @Test func stoppingTheStoreEndsThePoll() async {
        let backend = FakeBackend()
        backend.turns = [ActiveTurn(turnId: "backend:s", status: "running", quiet: false)]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.runningPollInterval = .milliseconds(30)
        store.start()
        for _ in 0..<100 where !store.running { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(store.running)
        store.stop()
        backend.turns = []
        try? await Task.sleep(for: .milliseconds(250))
        // Nobody asked again: the store still believes what it last heard.
        #expect(store.running)
        store.recheckRunning()
        for _ in 0..<50 where store.running { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!store.running)
    }

    @Test func aFailedStopSaysSo() async {
        let backend = FakeBackend()
        backend.stopError = .network
        let tasks = TasksStore(backend: backend)
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        tasks.stopTask(id: "1") { store.stopTaskFailed() }
        for _ in 0..<50 where store.notice == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.notice != nil)
        #expect(!tasks.stopping.contains("1"))
    }
}

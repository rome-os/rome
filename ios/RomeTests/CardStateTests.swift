import Foundation
import Testing
@testable import Rome

private func task(_ id: String, chat: String, status: String?, endReason: String? = nil) -> ConciergeTask {
    var row = ConciergeTask(id: id, title: "T", state: .next, createdAt: 0, updatedAt: 0)
    row.chat = .init(id: chat, name: "T")
    row.status = status
    row.endReason = endReason
    return row
}

@MainActor
@Suite struct TaskCardStateTests {
    private func store(tasks: [ConciergeTask] = [], chats: [ChatSession] = []) async -> TasksStore {
        let backend = FakeBackend()
        backend.taskRows = tasks
        backend.sessionRows = chats
        let store = TasksStore(backend: backend)
        await store.refresh()
        return store
    }

    @Test func aCardSaysWhatTheWebSays() async {
        let rows = [
            task("1", chat: "c1", status: "ended", endReason: "done"),
            task("2", chat: "c2", status: "ended", endReason: "failed"),
            task("3", chat: "c3", status: "ended", endReason: "stopped"),
            task("4", chat: "c4", status: "ended", endReason: "no_response"),
            task("5", chat: "c5", status: "needs_you"),
            task("6", chat: "c6", status: "active"),
            task("7", chat: "c7", status: "later"),
        ]
        let store = await store(tasks: rows)
        #expect((1...7).map { store.cardState(forChat: "c\($0)").word } == ["Done", "Didn't finish", "Stopped", "No response", "Needs you", "Working", "Later"])
    }

    @Test func stopShowsOnlyWhileTheTaskIsOpen() async {
        let store = await store(tasks: [task("1", chat: "c1", status: "active"), task("2", chat: "c2", status: "ended", endReason: "done"), task("3", chat: "c3", status: "needs_you")])
        #expect(store.cardState(forChat: "c1").stoppable && store.cardState(forChat: "c3").stoppable)
        #expect(!store.cardState(forChat: "c2").stoppable)
        #expect(!store.cardState(forChat: "none").stoppable)
    }

    @Test func aTaskTheListDoesNotHoldReadsFromItsChat() async {
        var archived = ChatSession(id: "a", name: "a")
        archived.archivedAt = "2026-01-01T00:00:00Z"
        let store = await store(chats: [
            ChatSession(id: "r", name: "r", running: true),
            ChatSession(id: "w", name: "w", awaitingGuardian: true),
            ChatSession(id: "f", name: "f", lastTurnFailed: true),
            ChatSession(id: "d", name: "d"),
            archived,
        ])
        #expect(["r", "w", "f", "d", "a"].map { store.cardState(forChat: $0).word } == ["Working", "Needs you", "Stopped with an error", "Done", "Stopped"])
    }

    @Test func stopGoesToTheTaskOnce() async {
        let backend = FakeBackend()
        backend.taskRows = [task("1", chat: "c1", status: "active")]
        let store = TasksStore(backend: backend)
        await store.refresh()
        store.stopTask(id: "1")
        store.stopTask(id: "1")
        for _ in 0..<50 where backend.stoppedTasks.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.stoppedTasks == ["1"])
    }
}

@Suite struct ModelNameTests {
    @Test func theNamesAreTheWebs() {
        #expect(ModelNames.display("claude-opus-5-5[1m]") == "Opus 5.5")
        #expect(ModelNames.display("claude-sonnet-5-5") == "Sonnet 5.5")
        #expect(ModelNames.display("gpt-6-luna") == "GPT-6 Luna")
        #expect(ModelNames.display("something-new") == "something-new")
    }
}

@MainActor
@Suite struct FailedAnswerAndSendTests {
    private func part() -> MessagePart.QuestionPart {
        let content = #"[{"type":"pending_interaction","toolUseId":"q1","render":{"componentId":"question-card","builtin":true,"props":{"questions":[{"id":"q","question":"Pick","type":"single","options":["A","B"]}]}}}]"#
        guard case .question(let part)? = MessagePart.parse(content).first else { fatalError("no question") }
        return part
    }

    @Test func aSendThatFailedForGoodCanBeRemoved() async {
        let backend = FakeBackend()
        backend.sendError = .server(status: 409, message: "This chat is archived and read-only")
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        store.send("hello")
        for _ in 0..<50 where store.pending.first?.state == .sending { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.pending.first?.state == .failed(.archived))
        store.removePending(store.pending[0].id)
        #expect(store.pending.isEmpty)
    }
}

@MainActor
@Suite struct ThreadViewShapeTests {
    private func message(_ id: String, at seconds: TimeInterval, thread: String? = nil) -> ChatMessage {
        let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "hi"]]), encoding: .utf8)!
        var held = ChatMessage(id: id, sessionId: "concierge", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: true)
        held.chatThreadTitle = thread == nil ? nil : "Book flights"
        return held
    }

    private func chat() async -> (TranscriptStore, FakeBackend) {
        let backend = FakeBackend()
        backend.stored = [message("a1", at: 0, thread: "a1"), message("a2", at: 10, thread: "a1")]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        // Read once, awaited: no polling that a slow simulator outlasts.
        await store.reload()
        return (store, backend)
    }

    /// Opened from its label, the thread shows no reply bar, and a send names the thread only.
    @Test func aThreadOpenedFromItsLabelHasNoReplyBar() async {
        let (store, _) = await chat()
        store.openThread(at: "a2")
        #expect(store.thread != nil)
        #expect(!store.showsQuoteBar)
        #expect(store.composerThread?.body == ["chatThread": .string("a2")])
        store.closeThread()
    }

    /// Reply on a message inside the open view shows the bar, naming the
    /// task, and sends to the thread without quoting the message.
    @Test func replyInsideTheViewShowsTheBar() async {
        let (store, _) = await chat()
        store.openThread(at: "a2")
        #expect(store.thread != nil)
        store.reply(to: "a2")
        #expect(store.showsQuoteBar && store.threadReplyTitle == "Book flights")
        #expect(store.composerThread?.body == ["chatThread": .string("a2")])
        store.closeThread()
    }

    /// A forwarded result draws as a plain bubble: nothing of its task above it.
    @Test func aForwardedResultIsAPlainBubble() {
        let parts = MessagePart.parse(#"[{"type":"text","content":"Done","forwardedFrom":{"chatId":"c1","title":"Book"}}]"#)
        #expect(parts == [.text("Done", long: false, forwardedFrom: .init(chatId: "c1", title: "Book"))])
    }
}

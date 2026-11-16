import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct TaskCardStateTests {
    private func store(chats: [ChatSession]) async -> TaskChatsStore {
        let backend = FakeBackend()
        backend.sessionRows = chats
        let store = TaskChatsStore(backend: backend)
        await store.refresh()
        return store
    }

    /// The status line says only what the task chat says live: Working while
    /// it runs, Needs you while it waits on the guardian, and nothing else,
    /// whatever else the chat says (failed, archived, done, not listed).
    @Test func theLineShowsOnlyWorkingOrNeedsYou() async {
        var archived = ChatSession(id: "a", name: "a")
        archived.archivedAt = "2026-01-01T00:00:00Z"
        let store = await store(chats: [
            ChatSession(id: "r", name: "r", running: true, awaitingGuardian: true),
            ChatSession(id: "w", name: "w", awaitingGuardian: true),
            ChatSession(id: "f", name: "f", lastTurnFailed: true),
            ChatSession(id: "d", name: "d"),
            archived,
        ])
        #expect(["r", "w", "f", "d", "a", "none"].map { store.cardState(forChat: $0).word } == ["Working", "Needs you", nil, nil, nil, nil])
    }

    /// A task that ends sends `session_running` false for its chat: the list
    /// is read again, and Needs you leaves the card.
    @Test func needsYouLeavesWhenTheTaskEnds() async {
        let backend = FakeBackend()
        backend.sessionRows = [ChatSession(id: "w", name: "w", running: false, awaitingGuardian: true)]
        let store = TaskChatsStore(backend: backend)
        store.start()
        for _ in 0..<50 where store.chats.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.cardState(forChat: "w").word == "Needs you")
        backend.sessionRows = [ChatSession(id: "w", name: "w", running: false, awaitingGuardian: false)]
        backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "w", running: false))
        for _ in 0..<50 where store.cardState(forChat: "w").word != nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.cardState(forChat: "w").word == nil)
        store.stop()
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

    /// Opened from its label, the thread shows no reply bar, and a send names the thread's root only.
    @Test func aThreadOpenedFromItsLabelHasNoReplyBar() async {
        let (store, _) = await chat()
        store.openThread(at: "a2")
        #expect(store.thread != nil)
        #expect(!store.showsQuoteBar)
        // The send names the thread by its root.
        #expect(store.composerThread?.body == ["chatThread": .string("a1")])
        store.closeThread()
    }

    /// Reply on a message inside the open view shows the bar, naming the
    /// thread, and sends to the thread without quoting the message.
    @Test func replyInsideTheViewShowsTheBar() async {
        let (store, _) = await chat()
        store.openThread(at: "a2")
        #expect(store.thread != nil)
        store.reply(to: "a2")
        #expect(store.showsQuoteBar && store.threadReplyTitle == "Book flights")
        // The send names the thread by its root.
        #expect(store.composerThread?.body == ["chatThread": .string("a1")])
        store.closeThread()
    }

    /// A forwarded result draws as a plain bubble: nothing of its task above it.
    @Test func aForwardedResultIsAPlainBubble() {
        let parts = MessagePart.parse(#"[{"type":"text","content":"Done","forwardedFrom":{"chatId":"c1","title":"Book"}}]"#)
        #expect(parts == [.text("Done", long: false, forwardedFrom: .init(chatId: "c1", title: "Book"))])
    }
}

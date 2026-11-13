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
        #expect((1...7).map { store.cardState(forChat: "c\($0)").word } == ["Done", "Failed", "Stopped", "No response", "Needs you", "Working", "Later"])
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
@Suite struct SettledReadTests {
    private func message(_ id: String, _ parts: [[String: Any]], at seconds: TimeInterval) -> ChatMessage {
        let content = String(data: try! JSONSerialization.data(withJSONObject: parts), encoding: .utf8)!
        return ChatMessage(id: id, sessionId: "t", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
    }

    private func question(_ id: String, _ text: String) -> [String: Any] {
        ["type": "pending_interaction", "toolUseId": id, "render": ["componentId": "question-card", "builtin": true, "props": ["questions": [["id": "q", "question": text, "type": "single", "options": ["A", "B"]]]]]]
    }

    private func result(_ id: String, _ value: String) -> [String: Any] {
        ["type": "interaction_result", "toolUseId": id, "output": ["answers": [["questionId": "q", "value": value]]]]
    }

    /// A later turn can reuse a tool-call id: each question takes its own answer.
    @Test func aReusedIdKeepsEachQuestionsOwnAnswer() {
        let messages = [
            message("a", [question("x", "First?")], at: 0), message("b", [result("x", "One")], at: 10),
            message("c", [question("x", "Second?")], at: 20), message("d", [result("x", "Two")], at: 30),
        ]
        let first = TaskWaitStore.asked(messages: messages, until: Date(timeIntervalSince1970: 1_800_000_015))
        #expect(first?.outcome == "Answered: One")
        let second = TaskWaitStore.asked(messages: messages, until: Date(timeIntervalSince1970: 1_800_000_025))
        #expect(second?.outcome == "Answered: Two")
        // Asked again and not yet answered: open, not the old answer.
        let open = TaskWaitStore.asked(messages: Array(messages.prefix(3)), until: Date(timeIntervalSince1970: 1_800_000_025))
        #expect(open?.outcome == "Waiting: answer the card below")
    }

    @Test func theReadTakesLargerPages() {
        #expect(TaskWaitStore.settledPageSize > 2)
    }
}

@MainActor
@Suite struct FailedAnswerAndSendTests {
    private func part() -> MessagePart.QuestionPart {
        let content = #"[{"type":"pending_interaction","toolUseId":"q1","render":{"componentId":"question-card","builtin":true,"props":{"questions":[{"id":"q","question":"Pick","type":"single","options":["A","B"]}]}}}]"#
        guard case .question(let part)? = MessagePart.parse(content).first else { fatalError("no question") }
        return part
    }

    /// A failed answer leaves the form as it was: nothing answered, a brief says so.
    @Test func aFailedAnswerKeepsTheForm() async {
        let backend = FakeBackend()
        backend.answerError = .network
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        store.answer(part(), answers: [])
        for _ in 0..<50 where store.notice == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.localAnswers["q1"] == nil)
        #expect(store.notice != nil)
        #expect(!store.answering.contains("q1"))
        // A sent answer is kept once the server has it.
        backend.answerError = nil
        store.answer(part(), answers: [])
        for _ in 0..<50 where store.localAnswers["q1"] == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.localAnswers["q1"] != nil)
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
        store.start()
        for _ in 0..<60 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
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

    /// Reply on a message inside the open view still quotes it.
    @Test func replyInsideTheViewShowsTheBar() async {
        let (store, _) = await chat()
        store.openThread(at: "a2")
        store.reply(to: "a2")
        #expect(store.showsQuoteBar)
        #expect(store.composerThread?.body == ["replyToMessageId": .string("a2"), "chatThread": .string("a2")])
        store.closeThread()
    }

    /// A forwarded result draws as a plain bubble: nothing of its task above it.
    @Test func aForwardedResultIsAPlainBubble() {
        let parts = MessagePart.parse(#"[{"type":"text","content":"Done","forwardedFrom":{"chatId":"c1","title":"Book"}}]"#)
        #expect(parts == [.text("Done", long: false, forwardedFrom: .init(chatId: "c1", title: "Book"))])
    }
}


@MainActor
@Suite struct OpenWaitTests {
    private func decode(_ extra: String) throws -> ConciergeTask {
        let json = #"{"id":"t","title":"T","state":"needs_user","createdAt":1,"updatedAt":2\#(extra)}"#
        return try JSONDecoder().decode(ConciergeTask.self, from: Data(json.utf8))
    }

    @Test func theWaitIsReadAsSent() throws {
        let card = try decode(#","openWait":{"kind":"card","id":"q1","messageId":"m1","render":{"componentId":"question-card","builtin":true,"props":{"questions":[{"id":"q","question":"Pick","type":"single","options":["A","B"]}]}},"since":5}"#)
        #expect(card.knowsOpenWait)
        guard case .card(let id, let messageId, let render, let since)? = card.wait else { Issue.record("no card"); return }
        #expect(id == "q1" && messageId == "m1" && render?["componentId"]?.string == "question-card" && since == 5)
        let approval = try decode(#","openWait":{"kind":"approval","id":"ap","since":7}"#)
        #expect(approval.wait == .approval(id: "ap", since: 7))
        // Null says nothing waits; absent says the server does not tell.
        let none = try decode(#","openWait":null"#)
        #expect(none.knowsOpenWait && none.wait == nil)
        let older = try decode("")
        #expect(!older.knowsOpenWait && older.wait == nil)
        // A shape this build does not know drops the wait, never the task.
        let odd = try decode(#","openWait":{"kind":"portal"}"#)
        #expect(odd.knowsOpenWait && odd.wait == nil)
    }

    @Test func aQuestionCardComesFromItsRender() throws {
        let task = try decode(#","openWait":{"kind":"card","id":"q1","messageId":"m1","render":{"componentId":"question-card","builtin":true,"props":{"questions":[{"id":"q","question":"Pick","type":"single","options":["A","B"]}]}},"since":5}"#)
        guard case .set(.question(let question, let key)?) = TaskWaitStore.card(openWait: task.wait, approvals: nil) else { Issue.record("no question"); return }
        #expect(question.toolUseId == "q1" && question.questions.first?.options == ["A", "B"] && key == "m1:q1")
        // Another app's card is answered in the task chat, and nothing waiting clears the card.
        let app = try decode(#","openWait":{"kind":"card","id":"x","messageId":"m2","render":{"componentId":"streak"},"since":5}"#)
        #expect(TaskWaitStore.card(openWait: app.wait, approvals: nil) == .set(.elsewhere))
        #expect(TaskWaitStore.card(openWait: nil, approvals: nil) == .set(nil))
        // An approval the pending list cannot give now keeps the card shown.
        let approval = try decode(#","openWait":{"kind":"approval","id":"ap","since":7}"#)
        #expect(TaskWaitStore.card(openWait: approval.wait, approvals: nil) == .keep)
        #expect(TaskWaitStore.card(openWait: approval.wait, approvals: []) == .set(nil))
    }

    /// The wait the server names is drawn with no page of the task chat read.
    @Test func theCardLoadsWithoutPaging() async throws {
        let backend = FakeBackend()
        var row = try decode(#","openWait":{"kind":"card","id":"q1","messageId":"m1","render":{"componentId":"question-card","props":{"questions":[{"id":"q","question":"Pick","type":"single","options":["A"]}]}},"since":5}"#)
        row.chat = .init(id: "chat", name: "T")
        let store = TaskWaitStore(chatId: "chat", backend: backend, task: { row })
        await store.load()
        #expect(store.card != nil && backend.newestFetches == 0)
        // Nothing waiting: the card goes, still with no page read.
        row.openWait = .null
        await store.load()
        #expect(store.card == nil && backend.newestFetches == 0)
        // A server before `openWait` is asked the old way.
        let older = TaskWaitStore(chatId: "chat", backend: backend, task: { try? self.decode("") })
        await older.load()
        #expect(backend.newestFetches == 1)
    }
}

import Foundation
import Testing
@testable import Rome

nonisolated(unsafe) private let question: [String: Any] = ["type": "pending_interaction", "toolUseId": "q1", "render": ["componentId": "question-card", "builtin": true, "props": ["questions": [["id": "s", "question": "Which?", "type": "single", "options": ["A", "B"]]]]]]

private func message(_ id: String, role: String = "assistant", _ parts: [[String: Any]], at seconds: TimeInterval, session: String = "task-1") -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: parts), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

private func result(_ id: String) -> [String: Any] { ["type": "interaction_result", "toolUseId": id, "output": ["answers": []]] }
private func approval(_ id: String, chat: String = "task-1", at seconds: TimeInterval) -> PendingApproval {
    PendingApproval(id: id, chatId: chat, part: .init(approvalId: id, actionName: "send", title: "Send", summary: nil, fields: [], storedStatus: "pending"), createdAt: Date(timeIntervalSince1970: 1_800_000_000 + seconds))
}

/// A waiting task's card in the main Chat, by rome-os/rome#1949's rules.
@MainActor
@Suite struct TaskWaitTests {
    private func card(_ messages: [ChatMessage], _ approvals: [PendingApproval] = []) -> TaskWaitStore.Card? {
        TaskWaitStore.card(messages: messages, approvals: approvals, chatId: "task-1")
    }

    @Test func theLatestOpenQuestionShows() {
        guard case .question(let part, let key) = card([message("m", [question], at: 0)]) else { Issue.record("no question"); return }
        #expect(part.toolUseId == "q1" && key == "m:0")
    }

    /// A result closes only earlier cards: a later turn can reuse the id.
    @Test func aResultClosesOnlyWhatCameBefore() {
        #expect(card([message("m", [question], at: 0), message("r", role: "user", [result("q1")], at: 5)]) == nil)
        guard case .question(_, let key) = card([message("m", [question], at: 0), message("r", role: "user", [result("q1")], at: 5), message("m2", [question], at: 10)]) else {
            Issue.record("the reopened question is gone"); return
        }
        #expect(key == "m2:0")
    }

    /// An app's own card shows only the Open link.
    @Test func aLatestAppCardShowsNothing() {
        let app: [String: Any] = ["type": "pending_interaction", "toolUseId": "app", "appId": "x", "render": ["componentId": "pricing-table"]]
        #expect(card([message("m", [question], at: 0), message("a", [app], at: 5)]) == nil)
    }

    @Test func aNewerApprovalWinsAndOnlyThisTasksCounts() {
        let questionAt0 = message("m", [question], at: 0)
        #expect(card([questionAt0], [approval("ap", at: 10)]) == .approval(approval("ap", at: 10)))
        guard case .question = card([message("m", [question], at: 20)], [approval("ap", at: 10)]) else { Issue.record("an older approval won"); return }
        #expect(card([], [approval("ap", chat: "other", at: 10)]) == nil)
        #expect(card([], [approval("old", at: 5), approval("new", at: 9)]) == .approval(approval("new", at: 9)))
    }

    /// Offline, a failed answer and a failed refresh keep the card and its
    /// controls for a retry. Fails before the change: the card was cleared.
    @Test func aFailedReadKeepsTheCard() async {
        let backend = FakeBackend()
        backend.stored = [message("m", [question], at: 0)]
        let store = TaskWaitStore(chatId: "task-1", backend: backend)
        await store.load()
        guard case .question(let part, let key) = store.card else { Issue.record("no question"); return }
        backend.answerError = .network
        backend.messagesError = .network
        await store.answer(part, key: key, answers: [])
        #expect(store.error == "Could not send. Please try again.")
        #expect(store.card == .question(part, key: key))
        // Back online, a read that answers with nothing open clears it.
        backend.messagesError = nil
        backend.stored = [message("m", [question], at: 0), message("r", role: "user", [result("q1")], at: 5)]
        await store.load()
        #expect(store.card == nil)
    }

    /// Without the approvals read (offline, or a visitor's refusal), a shown
    /// approval stays, and a question still follows the task's page.
    @Test func withoutApprovalsAShownApprovalStays() {
        let shown = TaskWaitStore.Card.approval(approval("ap", at: 10))
        #expect(TaskWaitStore.update(shown, messages: [], approvals: nil, chatId: "task-1") == .keep)
        #expect(TaskWaitStore.update(nil, messages: nil, approvals: [], chatId: "task-1") == .keep)
        guard case .set(.question?) = TaskWaitStore.update(nil, messages: [message("m", [question], at: 0)], approvals: nil, chatId: "task-1") else {
            Issue.record("the question did not show"); return
        }
    }

    @Test func onlyAWaitingIdleTaskShowsACard() {
        #expect(TaskWaitView.waits(ChatSession(id: "t", name: "", awaitingGuardian: true)))
        #expect(!TaskWaitView.waits(ChatSession(id: "t", name: "", running: true, awaitingGuardian: true)))
        #expect(!TaskWaitView.waits(ChatSession(id: "t", name: "", awaitingGuardian: false)))
        #expect(!TaskWaitView.waits(nil))
    }

    /// Only the newest card for a task may expand.
    @Test func onlyTheNewestTaskCardIsLatest() {
        let card: (String) -> [String: Any] = { ["type": "task_chat", "chatId": $0, "title": "T"] }
        let rows = TranscriptBuilder.rows(messages: [
            message("c1", [card("task-1")], at: 0, session: "concierge"),
            message("c2", [card("task-2")], at: 10, session: "concierge"),
            message("c3", [card("task-1")], at: 20, session: "concierge"),
        ], pending: [], answers: [:], options: .init())
        let latest = rows.compactMap { row -> String? in
            if case .taskCard(let id, _, _, let latest) = row, latest { return id }
            return nil
        }
        #expect(latest == ["c2:0", "c3:0"])
    }

    @Test func approvalRowsAreReadWithTheirChat() throws {
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(#"[{"id":"ap","status":"pending","createdAt":"2026-11-09T10:00:00Z","description":"Send the mail","payload":{"actionName":"system:send_email","channelContext":{"threadId":"task-1"},"preview":{"kind":"generic","title":"Send","summary":"","fields":[{"label":"To","value":"a@b.c"}]}}},{"id":"bad","status":"pending","description":"Something","payload":{"channelContext":{"threadId":"task-2"},"preview":{"kind":"later"}}},{"id":"done","status":"approved","payload":{}}]"#.utf8))
        let rows = (json.array ?? []).compactMap(PendingApproval.init(json:))
        #expect(rows.map(\.id) == ["ap", "bad"])
        #expect(rows[0].chatId == "task-1" && rows[0].part.title == "Send" && rows[0].part.fields.count == 1)
        // A preview this build cannot read keeps the controls, named by the description.
        #expect(rows[1].part.title == "Something")
    }

    /// It reads two turns, answers to the task chat, and handles the two failures.
    @Test func answersGoToTheTaskChat() async {
        let backend = FakeBackend()
        backend.stored = [message("m", [question], at: 0)]
        let store = TaskWaitStore(chatId: "task-1", backend: backend)
        await store.load()
        #expect(backend.pageLimits == [2])
        guard case .question(let part, let key) = store.card else { Issue.record("no question"); return }
        // Already answered elsewhere: the card refreshes and says so.
        backend.answerError = .server(status: 400, message: nil)
        await store.answer(part, key: key, answers: [])
        #expect(store.error == "This card was already answered. The task has been refreshed.")
        #expect(store.sent[key] == nil)
        // The network dropped: it may be sent again.
        backend.answerError = .network
        await store.answer(part, key: key, answers: [])
        #expect(store.error == "Could not send. Please try again.")
        // It goes through, to the task chat, never the main Chat.
        backend.answerError = nil
        await store.answer(part, key: key, answers: [])
        #expect(backend.answeredSessions == ["task-1", "task-1", "task-1"])
        #expect(store.error == nil)
    }
}

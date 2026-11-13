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

    /// An app's own card is answered in its task chat.
    @Test func aLatestAppCardIsAnsweredInTheTaskChat() {
        let app: [String: Any] = ["type": "pending_interaction", "toolUseId": "app", "appId": "x", "render": ["componentId": "pricing-table"]]
        #expect(card([message("m", [question], at: 0), message("a", [app], at: 5)]) == .elsewhere)
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
            if case .taskCard(let id, _, _, let latest, _) = row, latest { return id }
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

/// Settled and expired cards (docs/domains/chats.md, rome-os/rome#2011).
@MainActor
@Suite struct SettledCardTests {
    private let at = { (seconds: TimeInterval) in Date(timeIntervalSince1970: 1_800_000_000 + seconds) }
    private func answer(_ values: [String]) -> JSONValue {
        .object(["answers": .array(values.map { .object(["questionId": .string("s"), "value": .string($0)]) })])
    }
    private func answered(_ value: String, at seconds: TimeInterval) -> ChatMessage {
        message("r\(seconds)", role: "user", [["type": "interaction_result", "toolUseId": "q1", "output": ["answers": [["questionId": "s", "value": value]]]]], at: seconds)
    }

    @Test func aQuestionFoldsToItsAnswer() {
        #expect(SettledOutcome.answer(answer(["Tea"])) == "Answered: Tea")
        #expect(SettledOutcome.answer(answer(["Tea", "Cake"])) == "Answered: Tea, Cake")
        // A long answer is not repeated.
        #expect(SettledOutcome.answer(answer([String(repeating: "x", count: 25)])) == "Answered")
        #expect(SettledOutcome.answer(.object(["dismissed": .bool(true)])) == "Dismissed")
    }

    @Test func anApprovalFoldsToHowItEnded() {
        #expect(SettledOutcome.approval(.executed, resolvedBy: "guardian") == "Approved")
        #expect(SettledOutcome.approval(.rejected, resolvedBy: nil) == "Rejected")
        #expect(SettledOutcome.approval(.rejected, resolvedBy: "rome:task-ended") == "Turned down: no answer within a day")
        #expect(SettledOutcome.approval(.rejected, resolvedBy: "rome:task-stopped") == "Turned down: task stopped")
        #expect(SettledOutcome.folds(.approved) && SettledOutcome.folds(.rejected))
        #expect(!SettledOutcome.folds(.pending) && !SettledOutcome.folds(.failed))
    }

    /// A folded `ask` card shows the question open when it was said, and
    /// the answer given since; a newer copy of an open one waits below.
    @Test func aFoldedAskReadsTheWaitOpenAtItsTime() {
        let messages = [message("m", [question], at: 0), answered("Tea", at: 5), message("m2", [question], at: 10)]
        let first = TaskWaitStore.asked(messages: messages, until: at(1))
        #expect(first?.title == "Which?" && first?.outcome == "Answered: Tea")
        // The second copy is still open.
        #expect(TaskWaitStore.asked(messages: messages, until: at(11))?.outcome == "Waiting: answer the card below")
        // An approval the task asked, read from its card in the task chat.
        let card: [String: Any] = ["type": "approval_card", "approvalId": "ap", "actionName": "send", "preview": ["kind": "generic", "title": "Send the mail", "summary": ""]]
        guard case .approval(let part, nil)? = TaskWaitStore.asked(messages: [message("a", [card], at: 20)], until: at(21))?.kind else {
            Issue.record("no approval"); return
        }
        #expect(part.approvalId == "ap" && SettledOutcome.title(part) == "Send the mail")
        var decided = SettledAsk(kind: .approval(part, record: ApprovalRecord(id: "ap", status: "rejected", resolvedBy: "rome:task-ended")))
        #expect(decided.outcome == "Turned down: no answer within a day")
        decided.kind = .approval(part, record: ApprovalRecord(id: "ap", status: "pending"))
        #expect(decided.outcome == "Waiting: answer the card below")
    }

    /// The newest `ask` card of a waiting task takes an answer; an expired
    /// one folds until opened, and waits on no one; anything else folds.
    @Test func anAskCardDrawsByItsTasksState() {
        let waiting = ChatSession(id: "t", name: "", awaitingGuardian: true)
        var task = ConciergeTask(id: "k", title: "T", state: .needsUser, createdAt: 0, updatedAt: 0)
        task.status = "needs_you"
        #expect(TaskAskMode.of(latest: true, session: waiting, task: task, openedExpired: false) == .waiting(expired: false))
        #expect(TaskAskMode.of(latest: false, session: waiting, task: task, openedExpired: false) == .settled)
        #expect(TaskAskMode.of(latest: true, session: ChatSession(id: "t", name: ""), task: task, openedExpired: false) == .settled)
        task.status = "ended"
        task.endReason = "no_response"
        #expect(TaskAskMode.of(latest: true, session: waiting, task: task, openedExpired: false) == .expired)
        #expect(TaskAskMode.of(latest: true, session: waiting, task: task, openedExpired: true) == .waiting(expired: true))
    }

    /// `show` decides the row: the question alone, the task card, or, on a
    /// part from before, the task card with its wait inside.
    @Test func showDecidesTheRow() {
        let part: (String?) -> [String: Any] = { show in
            var part: [String: Any] = ["type": "task_chat", "chatId": "task-1", "title": "T"]
            if let show { part["show"] = show }
            return part
        }
        let rows = TranscriptBuilder.rows(messages: [
            message("a", [part("ask")], at: 0, session: "concierge"),
            message("b", [part("task")], at: 10, session: "concierge"),
            message("c", [part(nil)], at: 20, session: "concierge"),
            message("d", [part("ask")], at: 30, session: "concierge"),
        ], pending: [], answers: [:], options: .init())
        #expect(rows.contains(.taskAsk(id: "a:0", chatId: "task-1", title: "T", latest: false, shownAt: at(0))))
        #expect(rows.contains(.taskCard(id: "b:0", chatId: "task-1", title: "T", latest: false, embedsWait: false)))
        #expect(rows.contains(.taskCard(id: "c:0", chatId: "task-1", title: "T", latest: false, embedsWait: true)))
        // The newest of either kind is the latest for its task.
        #expect(rows.contains(.taskAsk(id: "d:0", chatId: "task-1", title: "T", latest: true, shownAt: at(30))))
    }
}

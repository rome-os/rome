import Foundation
import Testing
@testable import Rome

private let questionRender = #"{"componentId":"question-card","builtin":true,"props":{"questions":[{"id":"s","question":"Which?","type":"single","options":["A","B"]}]}}"#

private func question(outcome: String? = nil, expired: Bool = false, id: String = "q1") -> String {
    #"{"kind":"question","id":"\#(id)","messageId":"m","render":\#(questionRender),"since":5,"expired":\#(expired)\#(outcome.map { #","outcome":\#($0)"# } ?? "")}"#
}

private func approval(outcome: String? = nil, id: String = "ap") -> String {
    #"{"kind":"approval","id":"\#(id)","title":"Send the mail","actionName":"send","since":7\#(outcome.map { #","outcome":\#($0)"# } ?? "")}"#
}

private func card(_ json: String) -> TaskAskCard? {
    TaskAskCard(json: try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
}

private func content(show: String?, card: String?, chat: String = "task-1") -> String {
    #"[{"type":"task_chat","chatId":"\#(chat)","title":"T"\#(show.map { #","show":"\#($0)""# } ?? "")\#(card.map { #","card":\#($0)"# } ?? "")}]"#
}

private func message(_ id: String, _ content: String, at seconds: TimeInterval) -> ChatMessage {
    ChatMessage(id: id, sessionId: "concierge", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

private func task(status: String, waitId: String?, endReason: String? = nil) -> ConciergeTask {
    var task = ConciergeTask(id: "k", title: "T", state: .needsUser, createdAt: 0, updatedAt: 0)
    task.status = status
    task.endReason = endReason
    task.openWait = waitId.map { .object(["kind": .string("card"), "id": .string($0), "since": .number(5)]) } ?? .null
    return task
}

/// What a `task_chat` part's `card` says, and how the app draws from it
/// alone (rome-os/rome#2104).
@Suite struct TaskAskCardTests {
    @Test func aQuestionAndItsOutcomesAreRead() throws {
        let open = try #require(card(question()))
        guard case .question(let asked) = open.kind else { Issue.record("no question"); return }
        #expect(asked.id == "q1" && asked.since == 5 && !asked.expired && asked.outcome == nil)
        #expect(open.questionPart?.questions.first?.id == "s" && !open.settled)

        let answered = try #require(card(question(outcome: #"{"kind":"answered","answer":{"text":"B","output":{"answers":[{"questionId":"s","value":"B"}]}}}"#)))
        #expect(answered.settled)
        guard case .question(let done) = answered.kind, case .answered(let output)? = done.outcome else { Issue.record("no answer"); return }
        #expect(SettledOutcome.answer(output) == "Answered: B")

        let dismissed = try #require(card(question(outcome: #"{"kind":"dismissed"}"#)))
        guard case .question(let skipped) = dismissed.kind else { Issue.record("no question"); return }
        #expect(skipped.outcome == .dismissed && SettledOutcome.answer(skipped.outcome!.output) == "Dismissed")
    }

    @Test func anApprovalAndItsOutcomesAreRead() throws {
        let open = try #require(card(approval()))
        #expect(open.approvalPart?.approvalId == "ap" && open.approvalPart?.title == "Send the mail" && !open.settled)
        for (json, outcome, line) in [
            (#"{"kind":"approved"}"#, TaskAskCard.ApprovalOutcome.approved, "Approved"),
            (#"{"kind":"rejected"}"#, .rejected, "Rejected"),
            (#"{"kind":"turned_down","reason":"no_response"}"#, .turnedDown(.noResponse), "Turned down: no answer within a day"),
            (#"{"kind":"turned_down","reason":"task_stopped"}"#, .turnedDown(.taskStopped), "Turned down: task stopped"),
        ] {
            let decided = try #require(card(approval(outcome: json)))
            guard case .approval(let value) = decided.kind else { Issue.record("no approval"); return }
            #expect(value.outcome == outcome && TaskAskCard.outcomeLine(outcome) == line && decided.settled)
        }
    }

    @Test func anUnavailableOrUnknownCardIsHandledQuietly() {
        #expect(card(#"{"kind":"unavailable"}"#)?.kind == .unavailable)
        #expect(card(#"{"kind":"portal"}"#) == nil)
        // A part from a server before `card` has none.
        let parts = MessagePart.parse(content(show: "ask", card: nil))
        #expect(parts == [.taskChat(chatId: "task-1", title: "T", show: .ask, card: nil)])
    }

    @Test func anExpiredQuestionIsNotWaiting() throws {
        let expired = try #require(card(question(expired: true)))
        #expect(expired.expired)
        #expect(TaskAskMode.of(card: expired, latest: true, task: task(status: "ended", waitId: "q1", endReason: "no_response")) == .expired)
    }

    /// Before the task list arrives, the newest card goes by its own word:
    /// no "No longer waiting" that turns into a form a moment later.
    @Test func beforeTheTasksArriveACardGoesByItsOwnState() throws {
        let open = try #require(card(question()))
        let expired = try #require(card(question(expired: true)))
        #expect(TaskAskMode.of(card: open, latest: true, task: nil, tasksListed: false) == .waiting)
        #expect(TaskAskMode.of(card: expired, latest: true, task: nil, tasksListed: false) == .expired)
        #expect(TaskAskMode.of(card: open, latest: false, task: nil, tasksListed: false) == .open)
    }

    /// A card that stopped waiting re-reads the page once per task state,
    /// however often it scrolls back into view.
    @MainActor @Test func aCardReReadsOncePerChange() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        let before = backend.newestFetches
        store.recoverCard("q1|active|-")
        for _ in 0..<50 where backend.newestFetches == before { try? await Task.sleep(for: .milliseconds(10)) }
        store.recoverCard("q1|active|-")
        try? await Task.sleep(for: .milliseconds(100))
        #expect(backend.newestFetches == before + 1)
        store.recoverCard("q1|ended|-")
        for _ in 0..<50 where backend.newestFetches == before + 1 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.newestFetches == before + 2)
    }

    /// The newest card, with no outcome, of a task that needs the guardian
    /// and whose open wait is this card, takes the answer.
    @Test func theWaitingRule() throws {
        let open = try #require(card(question()))
        let needs = task(status: "needs_you", waitId: "q1")
        #expect(TaskAskMode.of(card: open, latest: true, task: needs) == .waiting)
        #expect(TaskAskMode.of(card: open, latest: false, task: needs) == .open)
        #expect(TaskAskMode.of(card: open, latest: true, task: task(status: "needs_you", waitId: "other")) == .open)
        #expect(TaskAskMode.of(card: open, latest: true, task: task(status: "active", waitId: "q1")) == .open)
        #expect(TaskAskMode.of(card: open, latest: true, task: nil) == .open)
        let answered = try #require(card(question(outcome: #"{"kind":"dismissed"}"#)))
        #expect(TaskAskMode.of(card: answered, latest: true, task: needs) == .settled)
        let approving = try #require(card(approval()))
        #expect(TaskAskMode.of(card: approving, latest: true, task: task(status: "needs_you", waitId: "ap")) == .waiting)
        #expect(TaskAskMode.of(card: nil, latest: true, task: needs) == .settled)
    }

    /// `chat_card_settled` replaces the card of every part with the same kind and id.
    @Test func aSettledEventReplacesEveryPartThatShowsIt() throws {
        let settled = try JSONDecoder().decode(JSONValue.self, from: Data(question(outcome: #"{"kind":"dismissed"}"#).utf8))
        let first = content(show: "ask", card: question())
        let updated = try #require(TaskAskCard.settling(content: first, with: settled))
        guard case .taskChat(_, _, _, let card?)? = MessagePart.parse(updated).first, case .question(let asked) = card.kind else { Issue.record("no card"); return }
        #expect(asked.outcome == .dismissed)
        // Another id, another kind and a part with no card stay as they were.
        #expect(TaskAskCard.settling(content: content(show: "ask", card: question(id: "q2")), with: settled) == nil)
        #expect(TaskAskCard.settling(content: content(show: "ask", card: approval(id: "q1")), with: settled) == nil)
        #expect(TaskAskCard.settling(content: content(show: "task", card: nil), with: settled) == nil)
    }

    /// `show` decides the row; each draws from the card its part carries.
    @Test func showDecidesTheRowAndTheCardTravelsWithIt() throws {
        let ask = try #require(card(question()))
        let rows = TranscriptBuilder.rows(messages: [
            message("a", content(show: "ask", card: question()), at: 0),
            message("b", content(show: "task", card: nil), at: 10),
            message("c", content(show: nil, card: question(id: "q3")), at: 20),
            message("d", content(show: "ask", card: question(id: "q4")), at: 30),
        ], pending: [], answers: [:], options: .init())
        #expect(rows.contains(.taskAsk(id: "a:0", chatId: "task-1", title: "T", card: ask)))
        #expect(rows.contains(.taskCard(id: "b:0", chatId: "task-1", title: "T")))
        #expect(rows.contains(.taskCard(id: "c:0", chatId: "task-1", title: "T", ask: card(question(id: "q3")))))
        // The newest of either kind is the latest for its task.
        #expect(rows.contains(.taskAsk(id: "d:0", chatId: "task-1", title: "T", card: card(question(id: "q4")), latest: true)))
    }
}

@MainActor
@Suite struct CardSettledEventTests {
    private func settled() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(approval(outcome: #"{"kind":"approved"}"#).utf8))
    }

    @Test func theEventIsDecoded() throws {
        let event = LiveEventsSocket.decode(name: "chat_card_settled", data: .object(["sessionId": .string("concierge"), "card": try settled()]))
        guard case .cardSettled(let session, let card)? = event else { Issue.record("not read"); return }
        #expect(session == "concierge" && card["id"]?.string == "ap")
        #expect(LiveEventsSocket.decode(name: "chat_card_settled", data: .object(["sessionId": .string("concierge")])) == nil)
    }

    @Test func theChatsMessagesTakeTheSettledCard() async throws {
        let backend = FakeBackend()
        backend.stored = [message("a", content(show: "ask", card: approval()), at: 0)]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        store.settle(try settled())
        guard case .taskAsk(_, _, _, let card?, _)? = store.rows.first(where: { if case .taskAsk = $0 { return true } else { return false } }),
              case .approval(let value) = card.kind
        else { Issue.record("no ask row"); return }
        #expect(value.outcome == .approved)
    }

    /// An answer or a decision shows at once, before the instance announces it.
    @Test func aDecisionShowsBeforeTheEventComes() async throws {
        let backend = FakeBackend()
        backend.resolveError = nil
        backend.stored = [message("a", content(show: "ask", card: approval()), at: 0)]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        store.resolve("ap", approve: false)
        for _ in 0..<100 where store.resolvingApproval["ap"] != nil || !backend.resolved.contains("ap") { try? await Task.sleep(for: .milliseconds(10)) }
        try? await Task.sleep(for: .milliseconds(50))
        guard case .taskAsk(_, _, _, let card?, _)? = store.rows.first(where: { if case .taskAsk = $0 { return true } else { return false } }),
              case .approval(let value) = card.kind
        else { Issue.record("no ask row"); return }
        #expect(value.outcome == .rejected)
    }
}

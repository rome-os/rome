import Foundation
import Testing
@testable import Rome

private func json(_ parts: [[String: Any]]) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: parts), encoding: .utf8)!
}

private func message(
    _ id: String,
    role: String = "assistant",
    _ parts: [[String: Any]],
    at seconds: TimeInterval,
    session: String = "concierge"
) -> ChatMessage {
    ChatMessage(id: id, sessionId: session, role: role, content: json(parts), createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

private func text(_ value: String) -> [String: Any] { ["type": "text", "content": value] }

@Suite struct MessagePartTests {
    @Test func parsesTextFormatsAndForwardedOrigin() {
        let parts = MessagePart.parse(json([
            ["type": "text", "content": "short"],
            ["type": "text", "content": "doc", "format": "long"],
            ["type": "text", "content": "report", "format": "long", "forwardedFrom": ["chatId": "c1", "title": "T"]],
        ]))
        #expect(parts == [
            .text("short", long: false, forwardedFrom: nil),
            .text("doc", long: true, forwardedFrom: nil),
            .text("report", long: true, forwardedFrom: .init(chatId: "c1", title: "T")),
        ])
    }

    @Test func plainTextContentIsOnePart() {
        #expect(MessagePart.parse("hello") == [.text("hello", long: false, forwardedFrom: nil)])
        #expect(MessagePart.parse("   ").isEmpty)
    }

    @Test func parsesCardsAndKeepsUnknownParts() {
        let parts = MessagePart.parse(json([
            ["type": "task_chat", "chatId": "c9", "title": "Fix"],
            ["type": "approval_card", "approvalId": "a1", "actionName": "system:send_email", "status": "pending",
             "preview": ["kind": "generic", "title": "发送邮件", "summary": "", "fields": [["label": "收件人", "value": "x@y.z"]]]],
            ["type": "pending_interaction", "toolUseId": "q1", "render": ["componentId": "question-card", "builtin": true,
             "props": ["questions": [["id": "s", "question": "Which?", "type": "single", "options": ["A", "B"]]]]]],
            ["type": "pending_interaction", "toolUseId": "app", "render": ["componentId": "pricing-table"]],
            ["type": "tool_use", "tool": "x"],
            ["type": "error", "error": "boom"],
        ]))
        #expect(parts.count == 6)
        #expect(parts[0] == .taskChat(chatId: "c9", title: "Fix"))
        guard case .approval(let approval) = parts[1] else { Issue.record("no approval"); return }
        #expect(approval.title == "发送邮件")
        #expect(approval.fields == [.init(label: "收件人", value: "x@y.z")])
        guard case .question(let question) = parts[2] else { Issue.record("no question"); return }
        #expect(question.questions.first?.text == "Which?")
        #expect(parts[3] == .webOnly(.unknown, toolUseId: "app"))
        #expect(parts[4] == .other(type: "tool_use"))
        #expect(parts[5] == .error(TurnError(text: "boom")))
    }

    @Test func actionNamesReadAsWords() {
        #expect(displayActionName("system:send_email") == "send email")
        #expect(displayActionName(nil) == "Run action")
    }
}

@Suite struct TranscriptBuilderTests {
    @Test func agentRunGetsFirstAndLastCornersAcrossCards() {
        let rows = TranscriptBuilder.rows(
            messages: [
                message("u", role: "user", [text("hi")], at: 0),
                message("a1", [text("one")], at: 10),
                message("card", [["type": "task_chat", "chatId": "c", "title": "T"]], at: 11),
                message("a2", [text("two")], at: 12),
            ],
            pending: [], answers: [:], options: .init()
        )
        let positions = rows.compactMap { row -> BubblePosition? in
            if case .agentText(_, _, _, _, let position) = row { return position }
            return nil
        }
        #expect(positions == [.first, .last])
        if case .separator = rows.first {} else { Issue.record("expected a leading separator") }
    }

    @Test func longGapsGetSeparatorsAndBreakRuns() {
        let rows = TranscriptBuilder.rows(
            messages: [
                message("a1", [text("one")], at: 0),
                message("a2", [text("two")], at: 60 * 20),
            ],
            pending: [], answers: [:], options: .init()
        )
        let separators = rows.filter { if case .separator = $0 { return true } else { return false } }
        #expect(separators.count == 2)
        let positions = rows.compactMap { row -> BubblePosition? in
            if case .agentText(_, _, _, _, let position) = row { return position }
            return nil
        }
        #expect(positions == [.single, .single])
    }

    @Test func pendingSendsShowUntilStoredAndTypingComesLast() {
        let pending = PendingSend(id: "in-1", text: "hello", createdAt: Date(timeIntervalSince1970: 1_800_000_100), state: .sending)
        var rows = TranscriptBuilder.rows(messages: [message("a", [text("x")], at: 0)], pending: [pending], answers: [:], options: .init(typing: true))
        #expect(rows.contains { $0 == .userText(id: "in-1", text: "hello", pending: .sending) })
        #expect(rows.last == .typing)

        // Once the server stores the input under the same id, the pending bubble yields to it.
        rows = TranscriptBuilder.rows(
            messages: [message("a", [text("x")], at: 0), message("in-1", role: "user", [text("hello")], at: 100)],
            pending: [pending], answers: [:], options: .init()
        )
        #expect(!rows.contains { if case .userText(_, _, _, .some) = $0 { return true } else { return false } })
    }

    @Test func toolSummariesOnlyInTaskChats() {
        var traced = message("t", role: "trace", [], at: 5, session: "s")
        traced.traceSummary = TraceSummary(totalSteps: 3)
        let concierge = TranscriptBuilder.rows(messages: [traced], pending: [], answers: [:], options: .init(showTools: false))
        let task = TranscriptBuilder.rows(messages: [traced], pending: [], answers: [:], options: .init(showTools: true))
        #expect(!concierge.contains { if case .tools = $0 { return true } else { return false } })
        #expect(task.contains { $0 == .tools(id: "tools-t", traceMessageId: "t", count: 3) })
    }

    @Test func answersComeFromInteractionResults() {
        let answer = message("r", role: "user", [["type": "interaction_result", "toolUseId": "q1", "output": ["answers": [["questionId": "s", "value": "A"]]]]], at: 0)
        let answers = TranscriptBuilder.answers(in: [answer])
        #expect(answers["q1"]?["answers"]?.array?.first?["value"]?.string == "A")
    }

    /// A provider reuses tool-use ids across turns: an answer belongs to the
    /// card before it, and a later card with the same id stays open.
    /// A result that names its card's message answers that card, even read
    /// after a later card with the same tool-use id.
    @Test func aResultThatNamesItsCardAnswersThatCard() {
        let card: [String: Any] = ["type": "pending_interaction", "toolUseId": "item_0", "appId": "connector", "render": ["kind": "inline", "ui": ["components": [["id": "root", "component": "Text", "text": "Connect"]]]]]
        let first = message("c1", role: "assistant", [card], at: 0)
        let second = message("c2", role: "assistant", [card], at: 0)
        let result = message("r1", role: "user", [["type": "interaction_result", "toolUseId": "item_0", "messageId": "c1", "output": ["from": "connector", "value": "ok"]]], at: 0)
        let answers = TranscriptBuilder.answers(in: [first, second, result])
        #expect(answers["c1"] != nil)
        #expect(answers["c2"] == nil)
    }

    /// An answer known only from older messages, as a thread's own older
    /// page holds it, reaches the card's row.
    @Test func aWaitingCardsRowCarriesItsAnswer() {
        let card: [String: Any] = ["type": "pending_interaction", "toolUseId": "item_0", "appId": "connector", "render": ["kind": "inline", "ui": ["components": [["id": "root", "component": "Text", "text": "Connect"]]]]]
        let output: JSONValue = .object(["from": .string("connector"), "value": .string("ok")])
        let rows = TranscriptBuilder.rows(messages: [message("c1", role: "assistant", [card], at: 0)], pending: [], answers: ["c1": output], options: .init())
        let answered = rows.compactMap { row -> JSONValue? in
            if case .widgetUI(_, _, _, let answered) = row { return answered } else { return nil }
        }
        #expect(answered == [output])
    }

    @Test func anAnswerBelongsToTheCardBeforeIt() {
        let card: [String: Any] = ["type": "pending_interaction", "toolUseId": "item_0", "appId": "connector", "render": ["kind": "inline", "ui": ["components": [["id": "root", "component": "Text", "text": "Connect"]]]]]
        let first = message("c1", role: "assistant", [card], at: 0)
        let result = message("r1", role: "user", [["type": "interaction_result", "toolUseId": "item_0", "output": ["from": "connector", "value": "ok"]]], at: 1)
        let second = message("c2", role: "assistant", [card], at: 2)
        let answers = TranscriptBuilder.answers(in: [first, result, second])
        #expect(answers["c1"] != nil)
        #expect(answers["c2"] == nil)
    }
}

@Suite struct RelativeTimeTests {
    @Test func clockIsTwentyFourHour() {
        var components = DateComponents()
        components.year = 2026; components.month = 10; components.day = 30; components.hour = 18; components.minute = 20
        let date = Calendar.current.date(from: components)!
        #expect(RelativeTime.clock(date) == "18:20")
    }

    @Test func agoUsesPlainWords() {
        let now = Date()
        #expect(RelativeTime.ago(now.addingTimeInterval(-30), now: now) == "Just now")
        #expect(RelativeTime.ago(now.addingTimeInterval(-60), now: now) == "1 minute ago")
        #expect(RelativeTime.ago(now.addingTimeInterval(-600), now: now) == "10 minutes ago")
    }

    @Test func untilCountsDown() {
        let now = Date()
        #expect(RelativeTime.until(now.addingTimeInterval(-5), now: now) == "Due now")
        #expect(RelativeTime.until(now.addingTimeInterval(1800), now: now) == "In 30 minutes")
    }

    @Test func olderDaysUseTheLocaleFormat() {
        var components = DateComponents()
        components.year = 2025; components.month = 10; components.day = 27; components.hour = 14; components.minute = 5
        let date = Calendar.current.date(from: components)!
        let now = date.addingTimeInterval(400 * 86_400)
        #expect(RelativeTime.separator(date, now: now) == "Oct 27, 2025 14:05")
        #expect(RelativeTime.weekday(date) == "Mon")
    }

    /// Chinese dates read the way a Chinese calendar writes them, whatever the region.
    @Test func chineseDatesUseChineseFormats() {
        var components = DateComponents()
        components.year = 2025; components.month = 10; components.day = 27; components.hour = 14; components.minute = 5
        let date = Calendar.current.date(from: components)!
        for locale in [Locale(identifier: "zh-Hans_CN"), Locale(identifier: "zh-Hans_US")] {
            #expect(RelativeTime.weekday(date, locale: locale) == "周一")
            #expect(RelativeTime.day(date, locale: locale) == "10月27日")
            #expect(RelativeTime.day(date, withYear: true, locale: locale) == "2025年10月27日")
        }
    }
}

/// Chat and topic chats draw the same answerable cards as task chats.
@MainActor
@Suite struct ConciergeCardTests {
    private func cards(session: String) -> [InteractionCard?] {
        let asked = message("m", [
            ["type": "pending_interaction", "toolUseId": "q1", "render": ["componentId": "question-card", "builtin": true,
             "props": ["questions": [["id": "s", "question": "Which?", "type": "single", "options": ["A", "B"], "freeText": true]]]]],
            ["type": "approval_card", "approvalId": "a1", "actionName": "calendar:create_event", "status": "pending",
             "preview": ["kind": "generic", "title": "Add event", "summary": "", "fields": []]],
            ["type": "pending_interaction", "toolUseId": "h1", "appId": "pricing", "render": ["componentId": "pricing-table"]],
        ], at: 0, session: session)
        return TranscriptBuilder.rows(messages: [asked], pending: [], answers: [:], options: .init())
            .filter { if case .separator = $0 { return false } else { return true } }
            .map(InteractionCard.init)
    }

    @Test func theMainChatAnswersQuestionsAndApprovals() {
        #expect(cards(session: "concierge") == [.question(sessionId: "concierge"), .approval, .webOnly])
    }

    @Test func aTopicChatAnswersInItsOwnSession() {
        #expect(cards(session: "topic-1") == [.question(sessionId: "topic-1"), .approval, .webOnly])
    }

    @Test func aWidgetsEventGoesToCoreByItsId() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "topic-1", kind: .concierge, backend: backend)
        try? await store.answerWidget(widgetId: "m-q1", name: "send", context: .object(["answers": .array([])]))
        for _ in 0..<20 where backend.answeredWidgets.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.answeredWidgets == ["m-q1"])
    }

    @Test func webOnlyCardsOpenTheirChatOnTheDashboard() {
        let origin = URL(string: "https://me.romeos.cc")!
        #expect(InstancePages.chat(origin: origin, sessionId: "topic-1").absoluteString == "https://me.romeos.cc/chat/topic-1")
        #expect(InstancePages.chat(origin: origin, sessionId: nil) == origin)
        // The main chat opens at `/message`, the dashboard's address for it.
        #expect(InstancePages.chat(origin: origin, sessionId: conciergeChatID, mainChatServerID: "c-42").absoluteString == "https://me.romeos.cc/message")
        // Before the main chat's server id is known: `/message` too, never
        // `/chat`, which starts a new chat on the dashboard.
        #expect(InstancePages.chat(origin: origin, sessionId: conciergeChatID).absoluteString == "https://me.romeos.cc/message")
        // A visitor's main chat goes by its own id: it is still their main chat.
        #expect(InstancePages.chat(origin: origin, sessionId: "concierge-v-acc1", mainChatServerID: "concierge-v-acc1").absoluteString == "https://me.romeos.cc/message")
        #expect(InstancePages.chat(origin: origin, sessionId: "chat-site", mainChatServerID: "concierge-v-acc1").absoluteString == "https://me.romeos.cc/chat/chat-site")
    }
}

/// The "New messages" line: which message it goes above, and where.
@Suite struct UnreadAtOpenTests {
    /// The read mark, in whole seconds, at `seconds` past the base time.
    private func mark(_ seconds: TimeInterval) -> Int {
        UnreadAtOpen.second(Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    }

    private func turn(_ message: ChatMessage, _ id: String) -> ChatMessage {
        var message = message
        message.turnId = id
        return message
    }

    @Test func onlyAgentMessagesAfterTheMarksSecondAreUnread() {
        let messages = [
            message("u", role: "user", [text("hi")], at: 20),
            message("same", [text("read")], at: 10.4),
            message("later", [text("new")], at: 11),
        ]
        #expect(UnreadAtOpen.unread(messages, mark: mark(10)) == ["later"])
    }

    @Test func theLineGoesAboveTheFirstUnreadMessageThatDrawsSomething() {
        let messages = [
            message("a1", [text("read")], at: 0),
            message("blank", [text("  ")], at: 20),
            message("a2", [text("new")], at: 21),
        ]
        let unread = UnreadAtOpen.unread(messages, mark: mark(10))
        #expect(UnreadAtOpen.first(in: messages, unread: unread, hasOlder: false) == "a2")
        #expect(UnreadAtOpen.first(in: messages, unread: [], hasOlder: false) == nil)
    }

    @Test func anUnreadRunThatMayStartOnAnOlderPageWaitsForIt() {
        let messages = [
            turn(message("q", role: "user", [text("go")], at: 0), "t1"),
            turn(message("r1", [text("new")], at: 30), "t1"),
            turn(message("r2", [text("new too")], at: 40), "t2"),
        ]
        let unread = UnreadAtOpen.unread(messages, mark: mark(10))
        #expect(UnreadAtOpen.first(in: messages, unread: unread, hasOlder: true) == nil)
        #expect(UnreadAtOpen.first(in: messages, unread: unread, hasOlder: false) == "r1")
        // The oldest loaded turn has nothing unread: the run starts here.
        let read = [turn(message("old", [text("read")], at: 5), "t0")] + messages.dropFirst()
        #expect(UnreadAtOpen.first(in: Array(read), unread: unread, hasOlder: true) == "r1")
    }

    @Test func theLineSitsUnderItsTimeSeparatorAndEndsTheRunBeforeIt() {
        let messages = [
            message("a1", [text("one")], at: 60 * 30),
            message("a2", [text("two")], at: 60 * 30 + 10),
            message("a3", [text("three")], at: 60 * 30 + 20),
        ]
        let rows = TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(unreadFrom: "a2"))
        #expect(rows.map(\.id) == ["sep-a1", "a1:0", "unread-divider", "a2:0", "a3:0"])
        let positions = rows.compactMap { row -> BubblePosition? in
            if case .agentText(_, _, _, _, let position) = row { return position }
            return nil
        }
        #expect(positions == [.single, .first, .last])

        let after = TranscriptBuilder.rows(messages: [message("old", [text("x")], at: 0)] + messages, pending: [], answers: [:], options: .init(unreadFrom: "a1"))
        #expect(after.map(\.id).prefix(5) == ["sep-old", "old:0", "sep-a1", "unread-divider", "a1:0"])
    }

    @Test func noLineForAMessageTheChatDoesNotDraw() {
        let rows = TranscriptBuilder.rows(messages: [message("a1", [text("one")], at: 0)], pending: [], answers: [:], options: .init(unreadFrom: "gone"))
        #expect(!rows.contains(.unreadDivider))
    }
}

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
        #expect(question.questions.first?.options == ["A", "B"])
        #expect(parts[3] == .webOnly(kind: "pricing-table"))
        #expect(parts[4] == .other(type: "tool_use"))
        #expect(parts[5] == .error("boom"))
    }

    @Test func actionNamesReadAsWords() {
        #expect(displayActionName("system:send_email") == "send email")
        #expect(displayActionName(nil) == "执行操作")
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
        #expect(!rows.contains { if case .userText(_, _, .some) = $0 { return true } else { return false } })
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
        #expect(RelativeTime.ago(now.addingTimeInterval(-30), now: now) == "刚刚")
        #expect(RelativeTime.ago(now.addingTimeInterval(-600), now: now) == "10 分钟前")
    }
}

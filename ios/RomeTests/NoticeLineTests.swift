import Foundation
import Testing
@testable import Rome

private func at(_ seconds: TimeInterval) -> String { RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)) }

private func text(_ id: String, role: String = "assistant", turn: String, at seconds: TimeInterval, sender: MessageSender? = nil) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "hi \(id)"]]), encoding: .utf8)!
    var message = ChatMessage(id: id, sessionId: "concierge", turnId: turn, role: role, content: content, createdAt: at(seconds))
    message.sender = sender
    return message
}

private func trace(turn: String, at seconds: TimeInterval, _ summary: TraceSummary) -> ChatMessage {
    ChatMessage(id: "trace-\(turn)", sessionId: "concierge", turnId: turn, role: "trace", content: "[]", createdAt: at(seconds), traceSummary: summary)
}

private func rows(_ messages: [ChatMessage], notices: Bool = true) -> [TranscriptRow] {
    TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showNotices: notices))
}

/// Automated input (rome-os/rome#2088) and session renewals (rome-os/rome#2076).
@MainActor
@Suite struct NoticeLineTests {
    @Test func theTraceSummaryCarriesBothAndToleratesOtherShapes() throws {
        let json = #"{"totalSteps":2,"automatedInput":{"type":"routine","name":"Daily summary"},"sessionRenewal":{"reason":"context","sessionId":"s2"}}"#
        let summary = try JSONDecoder().decode(TraceSummary.self, from: Data(json.utf8))
        #expect(summary.automatedInput == .init(type: "routine", name: "Daily summary"))
        #expect(summary.sessionRenewal == .init(reason: "context", sessionId: "s2"))
        #expect(summary.totalSteps == 2)
        // A shape this build does not know drops only its own field.
        let odd = try JSONDecoder().decode(TraceSummary.self, from: Data(#"{"totalSteps":1,"automatedInput":"x","sessionRenewal":[1]}"#.utf8))
        #expect(odd.totalSteps == 1 && odd.automatedInput == nil && odd.sessionRenewal == nil)
    }

    /// A routine's, an app's or an agent's input draws no line of its own.
    @Test func automatedInputDrawsNothing() {
        let summary = TraceSummary(automatedInput: .init(type: "routine", name: "Daily summary"))
        let built = rows([
            text("q", role: "user", turn: "t0", at: 0), text("a", turn: "t0", at: 5),
            text("r", turn: "t1", at: 60), trace(turn: "t1", at: 61, summary),
        ])
        #expect(built.map(\.id).filter { !$0.hasPrefix("sep") } == ["q:0", "a:0", "r:0", "source-r"])
        // A turn the Concierge answered with silence shows nothing either.
        let silent = rows([text("q", role: "user", turn: "t0", at: 0), trace(turn: "t1", at: 60, summary)])
        #expect(silent.map(\.id).filter { !$0.hasPrefix("sep") } == ["q:0"])
    }

    private func labels(_ built: [TranscriptRow]) -> [String] {
        built.compactMap { if case .sourceLabel(_, let text) = $0 { text } else { nil } }
    }

    /// Each reply of a turn the Concierge began on its own says where it came from.
    @Test func everyReplyOfAnUnpromptedTurnIsLabelled() {
        let summary = TraceSummary(automatedInput: .init(type: "routine", name: "Daily summary"))
        let built = rows([text("a", turn: "t1", at: 60), text("b", turn: "t1", at: 61), trace(turn: "t1", at: 62, summary), text("q", role: "user", turn: "t2", at: 120), text("c", turn: "t2", at: 125)])
        #expect(labels(built) == ["Routine · Daily summary", "Routine · Daily summary"])
        // A turn that said nothing shows nothing, and a task chat draws none.
        #expect(labels(rows([trace(turn: "t1", at: 62, summary)])).isEmpty)
        #expect(labels(rows([text("a", turn: "t1", at: 60), trace(turn: "t1", at: 62, summary)], notices: false)).isEmpty)
    }

    @Test func theLabelsReadAsTheBoardsSay() {
        func label(_ type: String, _ name: String?) -> String { SourceCopy.label(.init(type: type, name: name)) }
        #expect(label("routine", "Daily") == "Routine · Daily")
        #expect(label("app", "Habits") == "App · Habits")
        #expect(label("agent", nil) == "Agent")
        #expect(label("following", "Gmail") == "Following · Gmail")
        #expect(label("digest", nil) == "Following · digest")
        #expect(label("digest", "x") == "Following · digest")
        // A kind this build does not know reads as an automation, and still decodes.
        #expect(label("brand-new", nil) == "Automation")
        #expect(label("routine", "  ") == "Routine")
    }

    /// In a task's thread only its own label shows.
    @Test func aTaskThreadMessageKeepsOnlyItsThreadLabel() {
        let summary = TraceSummary(automatedInput: .init(type: "agent", name: "Flint"))
        var inThread = text("a", turn: "t1", at: 60)
        inThread.chatThreadId = "r"
        inThread.chatThreadTitle = "Book flights"
        inThread.knowsThreads = true
        let options = TranscriptBuilder.Options(showThreads: true, showNotices: true)
        let built = TranscriptBuilder.rows(messages: [inThread, trace(turn: "t1", at: 61, summary)], pending: [], answers: [:], options: options)
        #expect(labels(built).isEmpty)
        #expect(built.contains { if case .threadLabel = $0 { true } else { false } })
    }

    /// An automated message from before marks its turn, and is not drawn.
    @Test func anOldAutomatedMessageLabelsItsTurn() {
        let routine = MessageSender(kind: "automated", sourceType: "routine", name: "Daily")
        let built = rows([text("old", role: "user", turn: "t0", at: 0, sender: routine), text("a", turn: "t0", at: 5)])
        #expect(built.map(\.id).filter { !$0.hasPrefix("sep") } == ["a:0", "source-a"])
        #expect(labels(built) == ["Routine · Daily"])
    }

    /// An automated message from before, said on the owner's behalf or not, is not drawn in a Concierge chat.
    @Test func anOldAutomatedMessageIsNotDrawn() {
        let routine = MessageSender(kind: "automated", sourceType: "agent", name: "Flint")
        let onBehalf = MessageSender(kind: "automated", sourceType: "routine", name: "Daily", onBehalfOf: .init(kind: "guardian", name: "Lin"))
        let built = rows([text("old", role: "user", turn: "t0", at: 0, sender: routine), text("mine", role: "user", turn: "t1", at: 60, sender: onBehalf), text("real", role: "user", turn: "t2", at: 120)])
        #expect(built.map(\.id).filter { !$0.hasPrefix("sep") } == ["real:0"])
        // In a task chat the Concierge's own messages stay bubbles.
        let task = rows([text("old", role: "user", turn: "t0", at: 0, sender: routine)], notices: false)
        #expect(task.contains { if case .userText(let id, _, _, _) = $0 { id == "old:0" } else { false } })
    }

    @Test func aRenewalStandsBeforeItsTurnFirst() {
        let summary = TraceSummary(sessionRenewal: .init(reason: "context", sessionId: "s2"), automatedInput: .init(type: "agent", name: "Flint"))
        let ids = rows([text("q", role: "user", turn: "t1", at: 0), trace(turn: "t1", at: 5, summary)]).map(\.id)
        #expect(Array(ids.drop { $0.hasPrefix("sep") }) == ["renewal-t1", "q:0"])
    }

    @Test func theLinesReadAsTheBoardsSay() {
        #expect(NoticeCopy.renewal("context") == "Context tidied up · conversation got long")
        #expect(NoticeCopy.renewal("setup") == "Context tidied up · setup updated")
        #expect(NoticeCopy.renewal("later") == "Context tidied up · later")
    }

    @Test func tidyingUpIsAnActivity() {
        let activity = ConciergeActivity(json: .object(["kind": .string("tool"), "tool": .string("tidyingUp")]))
        #expect(activity == .tool(.tidyingUp))
        #expect(activity?.statusLine == "Tidying up context…")
        #expect(activity?.isBusy == true)
    }

}

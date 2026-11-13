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

    /// A turn that ran on automated input shows one line where it starts,
    /// before what the Concierge says, wherever its trace sits.
    @Test func automatedInputStandsBeforeItsTurn() {
        let summary = TraceSummary(automatedInput: .init(type: "routine", name: "Daily summary"))
        let built = rows([
            text("q", role: "user", turn: "t0", at: 0), text("a", turn: "t0", at: 5),
            text("r", turn: "t1", at: 60), trace(turn: "t1", at: 61, summary),
        ])
        let ids = built.map(\.id)
        #expect(ids.firstIndex(of: "automated-t1")! == ids.firstIndex(of: "r:0")! - 1)
        // A turn the Concierge answered with silence still shows it.
        let silent = rows([text("q", role: "user", turn: "t0", at: 0), trace(turn: "t1", at: 60, summary)])
        #expect(silent.contains(.automatedInput(id: "automated-t1", source: .init(type: "routine", name: "Daily summary"))))
        // Task chats and the thread view show none.
        #expect(!rows([text("r", turn: "t1", at: 60), trace(turn: "t1", at: 61, summary)], notices: false).contains { if case .automatedInput = $0 { true } else { false } })
    }

    /// An automated message from before draws as the same line; one sent on
    /// the owner's behalf stays their bubble.
    @Test func anOldAutomatedMessageIsALine() {
        let routine = MessageSender(kind: "automated", sourceType: "agent", name: "Flint")
        let onBehalf = MessageSender(kind: "automated", sourceType: "routine", name: "Daily", onBehalfOf: .init(kind: "guardian", name: "Lin"))
        let built = rows([text("old", role: "user", turn: "t0", at: 0, sender: routine), text("mine", role: "user", turn: "t1", at: 60, sender: onBehalf)])
        #expect(built.contains(.automatedInput(id: "automated-old", source: .init(type: "agent", name: "Flint"))))
        #expect(built.contains { if case .userText(let id, _, _, _) = $0 { id == "mine:0" } else { false } })
        // An unknown source reads as an automation.
        let unknown = MessageSender(kind: "automated", sourceType: nil, name: nil)
        #expect(TranscriptBuilder.automatedSource(text("x", role: "user", turn: "t", at: 0, sender: unknown)) == .init(type: "automation", name: nil))
        // In a task chat the Concierge's own messages stay bubbles.
        #expect(!rows([text("old", role: "user", turn: "t0", at: 0, sender: routine)], notices: false).contains { if case .automatedInput = $0 { true } else { false } })
    }

    @Test func aRenewalStandsBeforeItsTurnFirst() {
        let summary = TraceSummary(sessionRenewal: .init(reason: "context", sessionId: "s2"), automatedInput: .init(type: "agent", name: "Flint"))
        let ids = rows([text("q", role: "user", turn: "t1", at: 0), trace(turn: "t1", at: 5, summary)]).map(\.id)
        #expect(Array(ids.drop { $0.hasPrefix("sep") }) == ["renewal-t1", "automated-t1", "q:0"])
    }

    @Test func theLinesReadAsTheBoardsSay() {
        #expect(NoticeCopy.automated(.init(type: "routine", name: "Daily summary")) == "Routine · Daily summary")
        #expect(NoticeCopy.automated(.init(type: "agent", name: nil)) == "Agent")
        #expect(NoticeCopy.automated(.init(type: "something", name: " ")) == "Automation")
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

    /// A handoff is read once; none written leaves the line plain, and a
    /// failed read tries again.
    @Test func theHandoffIsReadOnce() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.loadHandoff("s2")
        #expect(store.handoffs["s2"] == nil && backend.handoffReads == ["s2"])
        backend.handoffs = ["s2": "We agreed on dinner at 7.", "s3": String?.none]
        await store.loadHandoff("s2")
        await store.loadHandoff("s2")
        #expect(store.handoffs["s2"] == .some("We agreed on dinner at 7."))
        #expect(backend.handoffReads == ["s2", "s2"])
        await store.loadHandoff("s3")
        #expect(store.handoffs["s3"] == .some(nil))
    }
}

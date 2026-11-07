import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct SuggestionTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func offersTheThreeApprovedSuggestions() {
        // Tests run in English.
        #expect(Suggestion.all.map(\.text) == [
            "Plan my weekend trip and check the weather",
            "Watch my Gmail inbox for me",
            "What can you watch for me?",
        ])
    }

    @Test func aPickSendsExactlyItsTextOnceAndCloses() {
        let state = SuggestionsState()
        var sent: [String] = []
        state.send = { sent.append($0) }
        state.toggle()
        #expect(state.isOpen)
        for suggestion in Suggestion.all {
            state.isOpen = true
            state.pick(suggestion)
            #expect(!state.isOpen)
        }
        #expect(sent == Suggestion.all.map(\.text))
    }

    @Test func closingSendsNothing() {
        let state = SuggestionsState()
        var sent: [String] = []
        state.send = { sent.append($0) }
        state.toggle()
        state.close()
        #expect(!state.isOpen)
        #expect(sent.isEmpty)
    }

    @Test func aPickInChatReachesTheServerAsWritten() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        let state = SuggestionsState()
        state.send = { store.send($0) }
        state.pick(Suggestion.all[1])
        await settle()
        #expect(backend.calls == ["send concierge Watch my Gmail inbox for me"])
    }

    @Test func aPickInABlankTopicChatStartsItThenSends() async {
        let backend = FakeBackend()
        let workspace = Workspace(backend: backend, instanceName: "Test", host: "test", accountLabel: "test")
        let state = SuggestionsState()
        state.send = { text in Task { _ = await workspace.startTopicChat(firstMessage: text) } }
        state.pick(Suggestion.all[0])
        await settle()
        #expect(backend.calls == ["start", "send topic-1 Plan my weekend trip and check the weather"])
    }
}

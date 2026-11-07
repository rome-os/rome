import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct StarterTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func offersTheThreeApprovedStarters() {
        // Tests run in English.
        #expect(Suggestion.all.map(\.text) == [
            "Plan my weekend trip and check the weather",
            "Watch my Gmail inbox for me",
            "What can you watch for me?",
        ])
    }

    @Test func showOnlyWhileTheChatIsEmpty() {
        #expect(ConciergeStarters.visible(loaded: true, rows: []))
        // Still loading: the chat may not be empty.
        #expect(!ConciergeStarters.visible(loaded: false, rows: []))
        #expect(!ConciergeStarters.visible(loaded: true, rows: [.typing]))
    }

    @Test func goAwayOnceAMessageIsSent() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.start()
        await settle()
        #expect(ConciergeStarters.visible(loaded: store.loaded, rows: store.rows))
        store.send(Suggestion.all[2].text)
        #expect(!ConciergeStarters.visible(loaded: store.loaded, rows: store.rows))
    }

    @Test func aStarterInChatSendsExactlyItsText() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.send(Suggestion.all[1].text)
        await settle()
        #expect(backend.calls == ["send concierge Watch my Gmail inbox for me"])
    }

    @Test func aStarterInABlankTopicChatStartsItThenSends() async {
        let backend = FakeBackend()
        let workspace = Workspace(backend: backend, instanceName: "Test", host: "test", accountLabel: "test")
        _ = await workspace.startTopicChat(firstMessage: Suggestion.all[0].text)
        await settle()
        #expect(backend.calls == ["start", "send topic-1 Plan my weekend trip and check the weather"])
    }
}

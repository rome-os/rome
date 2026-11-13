import Foundation
import Testing
@testable import Rome

private func chatMessage(_ id: String, role: String, turn: String?, text: String = "hi", at seconds: TimeInterval) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: conciergeChatID, turnId: turn, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

/// The Chat's typing dots follow the web's rule: none for a turn that took the
/// guardian's message, none once the turn has spoken, and a poll that ends them
/// when the live event never comes.
@MainActor
@Suite struct TypingDotsTests {
    private func store(_ backend: FakeBackend) -> TranscriptStore {
        TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
    }

    private func dots(_ store: TranscriptStore) -> Bool { store.rows.contains { $0 == .typing } }

    @Test func aTurnForTheGuardiansMessageShowsNoDots() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage("u1", role: "user", turn: "t1", at: 0)]
        backend.turns = [ActiveTurn(turnId: "t1", status: "running", quiet: false)]
        let store = store(backend)
        await store.reload()
        #expect(store.running)
        #expect(!dots(store))
    }

    @Test func aSendShowsNoDotsBeforeItsTurnIsKnown() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.turns = [ActiveTurn(turnId: "turn", status: "running", quiet: false)]
        let store = store(backend)
        store.send("hello")
        #expect(store.running)
        #expect(!dots(store))
    }

    @Test func aTurnWithNoOwnerMessageShowsDotsUntilItSpeaks() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage("a0", role: "assistant", turn: "old", at: 0)]
        backend.turns = [ActiveTurn(turnId: "backend:x", status: "running", quiet: false, agentTurnId: "agent-x")]
        let store = store(backend)
        await store.reload()
        #expect(dots(store))

        // Its saved messages carry the agent's own id.
        backend.stored.append(chatMessage("a1", role: "assistant", turn: "agent-x", at: 5))
        await store.reload()
        #expect(store.running)
        #expect(!dots(store))
    }

    @Test func aTraceAloneIsNotSpeaking() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage("tr", role: "trace", turn: "t9", at: 0)]
        backend.turns = [ActiveTurn(turnId: "t9", status: "running", quiet: false)]
        let store = store(backend)
        await store.reload()
        #expect(dots(store))
    }

    @Test func aQuietTurnShowsNoDots() async {
        let backend = FakeBackend()
        backend.turns = [ActiveTurn(turnId: "q", status: "running", quiet: true)]
        let store = store(backend)
        await store.reload()
        #expect(store.running)
        #expect(!dots(store))
    }

    @Test func aRunningChatAsksAgainAndStopsWhenTheTurnEnded() async {
        let backend = FakeBackend()
        backend.turns = [ActiveTurn(turnId: "backend:y", status: "running", quiet: false)]
        let store = store(backend)
        store.runningPollInterval = .milliseconds(30)
        await store.reload()
        #expect(dots(store))

        // No live event arrives: only the poll can tell.
        backend.turns = []
        for _ in 0..<100 where store.running { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!store.running)
        #expect(!dots(store))
    }
}

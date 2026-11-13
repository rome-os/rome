import Foundation
import Testing
@testable import Rome

private func chatMessage(_ id: String, role: String, turn: String?, text: String = "hi", at seconds: TimeInterval) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: conciergeChatID, turnId: turn, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

/// The Chat's typing dots come from the server's `message_writing` alone
/// (docs/domains/chats.md#status-reaction): no trace, no guess.
@MainActor
@Suite struct TypingDotsTests {
    private func store(_ backend: FakeBackend) -> TranscriptStore {
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.start()
        return store
    }

    private func dots(_ store: TranscriptStore) -> Bool { store.rows.contains { $0 == .typing } }

    private func writing(_ backend: FakeBackend, turn: String = "t1", _ mode: WritingMode, _ on: Bool) {
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .messageWriting(sessionId: conciergeChatID, turnId: turn, mode: mode, writing: on))
    }

    @Test func theEventIsRead() {
        guard case .messageWriting(let id, let turn, let mode, let on) = LiveEventsSocket.decode(name: "message_writing", data: .object([
            "sessionId": .string("s"), "turnId": .string("t"), "mode": .string("simulated"), "writing": .bool(false),
        ])) else { Issue.record("not read"); return }
        #expect(id == "s" && turn == "t" && mode == .simulated && !on)
        #expect(LiveEventsSocket.decode(name: "message_writing", data: .object(["sessionId": .string("s"), "turnId": .string("t"), "mode": .string("guess")])) == nil)
    }

    /// A running turn alone shows nothing: only the server's word does.
    @Test func aRunningTurnAloneShowsNoDots() async {
        let backend = FakeBackend()
        backend.turns = [ActiveTurn(turnId: "t1", status: "running", quiet: false)]
        let store = store(backend)
        await store.reload()
        #expect(store.running && !dots(store))
        store.stop()
    }

    /// Exact (Claude): the dots show while the turn writes, and go when it stops.
    @Test func exactShowsTheDotsWhileWriting() async {
        let backend = FakeBackend()
        let store = store(backend)
        await store.reload()
        writing(backend, .exact, true)
        #expect(dots(store))
        writing(backend, .exact, false)
        #expect(!dots(store))
        // The turn ending clears a writing state whose last word was lost.
        writing(backend, .exact, true)
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .sessionRunning(sessionId: conciergeChatID, running: false))
        for _ in 0..<100 where dots(store) { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(!dots(store))
        store.stop()
    }

    /// Simulated (Codex): each new message waits behind the dots for 5 ms a
    /// character, 0.5 to 1 s, one after the other; history never waits.
    @Test func simulatedHoldsEachNewMessage() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage("old", role: "assistant", turn: "t1", at: 0)]
        let store = store(backend)
        await store.reload()
        writing(backend, .simulated, false)
        #expect(!dots(store))
        #expect(store.rows.contains { $0.id == "old:0" })

        let first = chatMessage("a1", role: "assistant", turn: "t1", text: "short", at: 5)
        let second = chatMessage("a2", role: "assistant", turn: "t1", text: String(repeating: "x", count: 150), at: 6)
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .messageInsert(first))
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .messageInsert(second))
        #expect(dots(store))
        #expect(!store.rows.contains { $0.id == "a1:0" || $0.id == "a2:0" })
        #expect(store.held.map(\.wait) == [.milliseconds(500), .milliseconds(750)])

        // The first shows after its wait, then the second after its own.
        for _ in 0..<100 where !store.rows.contains(where: { $0.id == "a1:0" }) { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.rows.contains { $0.id == "a1:0" } && !store.rows.contains { $0.id == "a2:0" } && dots(store))
        for _ in 0..<150 where !store.rows.contains(where: { $0.id == "a2:0" }) { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.rows.contains { $0.id == "a2:0" } && !dots(store))
        store.stop()
    }

    /// A message of another turn, or of an exact turn, never waits.
    @Test func onlyTheSimulatedTurnsMessagesWait() async {
        let backend = FakeBackend()
        let store = store(backend)
        await store.reload()
        writing(backend, .simulated, false)
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .messageInsert(chatMessage("b1", role: "assistant", turn: "other", at: 5)))
        #expect(store.held.isEmpty && store.rows.contains { $0.id == "b1:0" })
        writing(backend, turn: "t2", .exact, false)
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .messageInsert(chatMessage("b2", role: "assistant", turn: "t2", at: 6)))
        #expect(store.held.isEmpty && !dots(store))
        store.stop()
    }

    @Test func simulatedWaitsByLength() {
        #expect(TranscriptStore.simulatedWait(chatMessage("x", role: "assistant", turn: nil, text: "hi", at: 0)) == .milliseconds(500))
        #expect(TranscriptStore.simulatedWait(chatMessage("x", role: "assistant", turn: nil, text: String(repeating: "y", count: 400), at: 0)) == .milliseconds(1000))
    }

    @Test func theFallbackPollIsTheWebs() {
        #expect(TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: FakeBackend()).runningPollInterval == .seconds(30))
    }
}

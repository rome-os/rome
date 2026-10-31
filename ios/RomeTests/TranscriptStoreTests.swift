import Foundation
import Testing
@testable import Rome

/// A backend that serves one chat from memory, paged the way the server pages.
@MainActor
final class FakeBackend: RomeBackend {
    let displayOrigin = "test"
    let bus = LocalEventBus()
    var events: LiveEventSource { bus }

    var stored: [ChatMessage] = []
    var turns: [ActiveTurn] = []
    var interrupted: [String] = []
    /// Whether an interrupt ends the turn on the server.
    var interruptEndsTurn = true

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        let end = before.flatMap { cursor in stored.firstIndex { $0.id == cursor } } ?? stored.count
        let start = max(0, end - limit)
        return MessagePage(messages: Array(stored[start..<end]), nextCursor: start > 0 ? stored[start].id : nil)
    }

    func activeTurns(sessionId: String) async throws -> [ActiveTurn] { turns }

    func interrupt(turnId: String) async throws {
        interrupted.append(turnId)
        if interruptEndsTurn { turns.removeAll { $0.turnId == turnId } }
    }

    func conciergeSession() async throws -> ConciergeSessionInfo { throw APIError.network }
    func send(sessionId: String, text: String, inputId: String, priority: InputPriority) async throws -> CreatedTurn { throw APIError.network }
    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws { throw APIError.network }
    func markRead(sessionId: String) async {}
    func sessions() async throws -> [ChatSession] { [] }
    func tasks() async throws -> [ConciergeTask] { [] }
    func approval(id: String) async throws -> ApprovalRecord { throw APIError.network }
    func resolveApproval(id: String, approve: Bool) async throws { throw APIError.network }
    func toolCalls(traceMessageId: String) async throws -> [ToolCall] { [] }
    func aiTools() async throws -> AIToolsStatus { throw APIError.network }
    func setConciergeEnabled(_ enabled: Bool) async throws {}
    func search(_ query: String) async throws -> [SearchHit] { [] }
    func me() async throws -> String? { nil }
    func routines() async throws -> [Routine] { [] }
    func setRoutine(_ id: String, enabled: Bool) async throws {}
    func sendFeedback(_ text: String) async throws {}
}

private func chatMessage(_ index: Int, role: String = "assistant") -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "message \(index)"]]), encoding: .utf8)!
    return ChatMessage(id: "m\(index)", sessionId: "task", role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index))))
}

@MainActor
@Suite struct TranscriptStoreTests {
    /// 50 messages; the first one is the guardian's brief.
    private func backendWithLongChat() -> FakeBackend {
        let backend = FakeBackend()
        backend.stored = (0..<50).map { chatMessage($0, role: $0 == 0 ? "user" : "assistant") }
        return backend
    }

    @Test func olderPageWaitsUntilPlaced() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.messages.count == 40)
        #expect(store.hasOlder)

        await store.loadOlder()
        #expect(store.olderPage != nil)
        #expect(store.messages.count == 40)

        await store.placeOlderPage()
        #expect(store.olderPage == nil)
        #expect(store.messages.count == 50)
        #expect(!store.hasOlder)
    }

    @Test func reloadKeepsThePagesAlreadyLoaded() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        await store.loadOlder()
        await store.placeOlderPage()

        backend.stored.append(chatMessage(50))
        await store.reload()
        #expect(store.messages.count == 51)
        #expect(!store.hasOlder)
    }

    @Test func briefIsUnknownUntilTheOldestPageIsHeld() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.brief == nil)

        await store.loadOlder()
        await store.placeOlderPage()
        #expect(store.brief?.id == "m0")
    }

    @Test func stopEndsRunningWithoutALiveEvent() async throws {
        let backend = FakeBackend()
        backend.stored = [chatMessage(0, role: "user")]
        backend.turns = [ActiveTurn(turnId: "t1", status: "running", quiet: false)]
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.running)

        // No socket event arrives here: only the active turns can tell it ended.
        store.stopTurn()
        for _ in 0..<40 where store.running {
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(backend.interrupted == ["t1"])
        #expect(!store.running)
        #expect(!store.stopping)
        #expect(store.stopped)

        backend.turns = [ActiveTurn(turnId: "t2", status: "running", quiet: false)]
        await store.reload()
        #expect(store.running)
        #expect(!store.stopped)
    }
}

import Foundation
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", turn: String? = nil, at seconds: TimeInterval) -> ChatMessage {
    let json = (try? JSONSerialization.data(withJSONObject: [["type": "text", "content": text]])) ?? Data()
    return ChatMessage(
        id: id, sessionId: "concierge", turnId: turn, role: role, content: String(bytes: json, encoding: .utf8) ?? "[]",
        createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: nil, knowsThreads: true
    )
}

/// The order of a chat's messages, live updates in place, the task list's
/// writes, the socket's frames and how many chats keep their transcript.
@MainActor
@Suite struct PerfPathsTests {
    private func settle(_ until: () -> Bool) async {
        for _ in 0..<60 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// The order as the store worked it out before its keys were computed
    /// once: the reference the faster sort must match.
    private func reference(_ all: [ChatMessage], seen: [String: Int]) -> [ChatMessage] {
        var turnStart: [String: Date] = [:]
        var turnArrival: [String: Int] = [:]
        for message in all {
            let key = message.turnId ?? message.id
            turnStart[key] = min(turnStart[key] ?? message.date, message.date)
            turnArrival[key] = min(turnArrival[key] ?? Int.max, seen[message.id]!)
        }
        return all.sorted { a, b in
            let keyA = a.turnId ?? a.id, keyB = b.turnId ?? b.id
            let startA = turnStart[keyA]!, startB = turnStart[keyB]!
            if startA != startB { return startA < startB }
            if keyA != keyB { return turnArrival[keyA]! < turnArrival[keyB]! }
            if a.date != b.date { return a.date < b.date }
            return seen[a.id]! < seen[b.id]!
        }
    }

    @Test func theOrderIsTheServersWhateverTheTies() {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<50 {
            // Few distinct seconds and turns, so turns and rows tie often.
            let all = (0..<40).map { index in
                message("m\(index)", turn: Bool.random(using: &generator) ? "t\(Int.random(in: 0..<6, using: &generator))" : nil, at: Double(Int.random(in: 0..<8, using: &generator)))
            }.shuffled(using: &generator)
            let seen = Dictionary(uniqueKeysWithValues: all.map(\.id).shuffled(using: &generator).enumerated().map { ($1, $0) })
            #expect(TranscriptStore.ordered(all, seen: seen).map(\.id) == reference(all, seen: seen).map(\.id))
        }
    }

    @Test func aLiveEditOfAHeldMessageKeepsItsPlace() async {
        let backend = FakeBackend()
        backend.stored = [
            message("u1", role: "user", "hi", turn: "t1", at: 0),
            message("a1", "first", turn: "t1", at: 5),
            message("a2", "second", turn: "t1", at: 5),
            message("u2", role: "user", "next", turn: "t2", at: 9)
        ]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle { store.loaded }
        let before = store.messages.map(\.id)
        // The same turn and time, new text: replaced where it stands.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a1", "first, edited", turn: "t1", at: 5)))
        #expect(store.messages.map(\.id) == before)
        #expect(store.message("a1")?.parts.first?.textContent == "first, edited")
        // A new time moves it, as a full sort would.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a1", "first, later", turn: "t1", at: 7)))
        #expect(store.messages.map(\.id) == ["u1", "a2", "a1", "u2"])
        // A new message lands in order.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a3", "third", turn: "t1", at: 6)))
        #expect(store.messages.map(\.id) == ["u1", "a2", "a3", "a1", "u2"])
    }

    @Test func aTaskWriteThatChangesNothingWritesNothing() {
        let tasks = TasksStore(backend: FakeBackend())
        var task = ConciergeTask(id: "k1", title: "Book", state: .doing, createdAt: 1, updatedAt: 1, status: "active")
        task.chat = .init(id: "chat-1", name: "Book")
        tasks.apply(task)
        #expect(tasks.task(forChat: "chat-1")?.id == "k1")
        final class Flag: @unchecked Sendable { var on = false }
        let written = Flag()
        withObservationTracking { _ = tasks.tasks } onChange: { written.on = true }
        tasks.apply(task)
        #expect(!written.on)
        // A newer copy is written, and the index follows it.
        task.title = "Book a table"
        task.updatedAt = 2
        tasks.apply(task)
        #expect(written.on)
        #expect(tasks.title(forChat: "chat-2", fallback: "x") == "x")
        #expect(tasks.task(forChat: "chat-1")?.title == "Book a table")
        tasks.forget(chat: "chat-1")
        #expect(tasks.task(forChat: "chat-1") == nil)
    }

    @Test func aFrameIsReadIntoItsEvent() throws {
        let insert = #"{"type":"event","topic":"chat.session:c","event":"message_insert","data":{"id":"m1","sessionId":"c","role":"assistant","content":"[]","createdAt":"2026-11-13T10:00:00.000Z"}}"#
        guard case .event("chat.session:c", .messageInsert(let message))? = LiveEventsSocket.frame(insert) else {
            Issue.record("no insert")
            return
        }
        #expect(message.id == "m1")
        guard case .subscribed("tasks")? = LiveEventsSocket.frame(#"{"type":"subscribed","topic":"tasks"}"#) else {
            Issue.record("no confirmation")
            return
        }
        guard case .event(_, .sessionRunning("c", true))? = LiveEventsSocket.frame(#"{"type":"event","topic":"chat.status","event":"session_running","data":{"sessionId":"c","running":true}}"#) else {
            Issue.record("no running")
            return
        }
        #expect(LiveEventsSocket.frame("not json") == nil)
    }

    @Test func onlyTheNewestChatsKeepTheirTranscripts() async {
        let backend = FakeBackend()
        let drafts = DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-kept-\(UUID().uuidString)/Drafts"), instance: "t")
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        let first = (0..<3).map { workspace.topicStore("topic-\($0)") }
        // One chat runs on screen, one holds a send that failed.
        first[0].start()
        first[1].send("kept for Retry")
        await settle { first[1].pending.first?.state != .sending }
        #expect(!first[1].pending.isEmpty)
        for index in 3..<11 { _ = workspace.topicStore("topic-\(index)") }
        workspace.trimStores()
        // Eleven opened, eight kept: the two that would lose something stay,
        // and the oldest ones that would not go first.
        #expect(workspace.topicStore("topic-0") === first[0])
        #expect(workspace.topicStore("topic-1") === first[1])
        #expect(workspace.topicStore("topic-2") !== first[2])
        first[0].stop()
        workspace.stop()
    }
}

import Foundation
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", turn: String? = nil, at seconds: TimeInterval) -> ChatMessage {
    let json = (try? JSONSerialization.data(withJSONObject: [["type": "text", "content": text]])) ?? Data()
    return ChatMessage(
        id: id, sessionId: "concierge", turnId: turn, role: role, content: String(bytes: json, encoding: .utf8) ?? "[]",
        createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    )
}

/// The order of a chat's messages, live updates in place, the task list's
/// writes, the socket's frames and how many chats keep their transcript.
@MainActor
@Suite struct PerfPathsTests {
    private func settle(_ until: () -> Bool) async {
        for _ in 0..<60 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// The server sends every list in its final order and the store never
    /// sorts: whatever times the messages carry, they stay as they came.
    @Test func aPageStaysInTheOrderTheServerSentIt() async {
        let backend = FakeBackend()
        backend.stored = [
            message("z", turn: "t2", at: 50),
            message("a", turn: "t1", at: 10),
            message("m", at: 10),
            message("b", turn: "t1", at: 5)
        ]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle { store.loaded }
        #expect(store.messages.map(\.id) == ["z", "a", "m", "b"])
        await store.reload()
        await store.reload()
        #expect(store.messages.map(\.id) == ["z", "a", "m", "b"])
    }

    @Test func aLiveMessageGoesLastAndASameIdIsReplacedInPlace() async {
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
        // The same id, new text: replaced where it stands.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a1", "first, edited", turn: "t1", at: 5)))
        #expect(store.messages.map(\.id) == before)
        #expect(store.message("a1")?.parts.first?.textContent == "first, edited")
        // A new time does not move it.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a1", "first, later", turn: "t1", at: 70)))
        #expect(store.messages.map(\.id) == before)
        // A new message goes last, whatever time it carries.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a3", "third", turn: "t1", at: 6)))
        #expect(store.messages.map(\.id) == before + ["a3"])
    }

    @Test func aChatListThatChangesNothingWritesNothing() async {
        let backend = FakeBackend()
        backend.sessionRows = [ChatSession(id: "chat-1", name: "Book")]
        let tasks = TaskChatsStore(backend: backend)
        await tasks.refresh()
        #expect(tasks.title(forChat: "chat-1", fallback: "x") == "Book")
        final class Flag: @unchecked Sendable { var on = false }
        let written = Flag()
        withObservationTracking { _ = tasks.chats } onChange: { written.on = true }
        await tasks.refresh()
        #expect(!written.on)
        backend.sessionRows = [ChatSession(id: "chat-1", name: "Book a table")]
        await tasks.refresh()
        #expect(written.on)
        #expect(tasks.title(forChat: "chat-2", fallback: "x") == "x")
        #expect(tasks.title(forChat: "chat-1", fallback: "x") == "Book a table")
        tasks.forget(chat: "chat-1")
        #expect(tasks.isGone(chat: "chat-1"))
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

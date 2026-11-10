import Foundation
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, thread: String? = nil, knows: Bool = true, session: String = "concierge") -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: knows)
}

/// What the wire says about chat threads, and what an older instance leaves out.
@MainActor
@Suite struct ChatThreadWireTests {
    private func decode(_ json: String) throws -> ChatMessage {
        try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
    }

    @Test func aMessageSaysItsThreadOrThatItIsAlone() throws {
        let placed = try decode(#"{"id":"m2","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":"m1"}"#)
        #expect(placed.chatThreadId == "m1" && placed.knowsThreads && placed.threadRoot == "m1")
        let alone = try decode(#"{"id":"m3","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":null}"#)
        #expect(alone.chatThreadId == nil && alone.knowsThreads && alone.threadRoot == "m3")
        // An instance before chat threads leaves the field out.
        let older = try decode(#"{"id":"m4","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z"}"#)
        #expect(older.chatThreadId == nil && !older.knowsThreads)
    }

    /// A kept copy reads back the same, null included.
    @Test func aKeptMessageKeepsItsThread() throws {
        for kept in [message("a", at: 0, thread: "r"), message("b", at: 0, thread: nil, knows: true), message("c", at: 0, thread: nil, knows: false)] {
            let back = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(kept))
            #expect(back == kept)
        }
    }

    @Test func thePlacementEventIsRead() {
        guard case .messageThread(let session, let id, let thread) = LiveEventsSocket.decode(name: "message_chat_thread", data: .object(["sessionId": .string("s"), "messageId": .string("m2"), "chatThreadId": .string("m1")])) else {
            Issue.record("not read"); return
        }
        #expect(session == "s" && id == "m2" && thread == "m1")
        guard case .messageThread(_, _, let none) = LiveEventsSocket.decode(name: "message_chat_thread", data: .object(["sessionId": .string("s"), "messageId": .string("m2"), "chatThreadId": .null])) else {
            Issue.record("not read"); return
        }
        #expect(none == nil)
    }

    /// An instance with chat threads gets `chatThread`; an older one a reply,
    /// which every supported release places by `replyToMessageId`.
    @Test func aSendFromAThreadNamesIt() {
        #expect(ThreadTarget(messageId: "m2", instanceKnowsThreads: true).body == ["chatThread": .string("m2")])
        #expect(ThreadTarget(messageId: "m2", instanceKnowsThreads: false).body == ["replyToMessageId": .string("m2")])
    }
}

/// The "N replies" line under a thread's first message, in Concierge chats only.
@Suite struct ThreadRepliesRowTests {
    private let messages = [
        message("r", role: "user", "plan a trip", at: 0, thread: "r"),
        message("a1", "sure", at: 10, thread: "r"),
        message("w", role: "user", "weather?", at: 20, thread: "w"),
        message("a2", "mild", at: 30, thread: "w"),
        message("a3", "hotel picked", at: 40, thread: "r"),
        message("lone", "hello", at: 50),
    ]

    private func replies(_ options: TranscriptBuilder.Options) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: options).filter {
            if case .threadReplies = $0 { return true } else { return false }
        }
    }

    @Test func aThreadsFirstMessageCountsItsReplies() {
        #expect(replies(.init(showThreads: true)) == [
            .threadReplies(id: "replies-r", messageId: "r", count: 2, guardian: true),
            .threadReplies(id: "replies-w", messageId: "w", count: 1, guardian: true),
        ])
        #expect(replies(.init()).isEmpty)
        // Right under the message it counts.
        let rows = TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showThreads: true))
        let index = rows.firstIndex { $0.id == "replies-r" }!
        #expect(rows[index - 1].id == "r:0")
        #expect(rows[index].messageId == "r")
        #expect(rows[index - 1].messageId == "r")
    }
}

/// A chat thread open over its chat.
@MainActor
@Suite struct ThreadStoreTests {
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage]) async -> TranscriptStore {
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        // Started, so the chat hears events as it does on screen.
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<50 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func anInstanceWithThreadsReadsTheWholeThread() async {
        let backend = FakeBackend()
        let older = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        // The chat holds only the reply; the read brings the rest.
        let store = await chat(backend, [reply])
        backend.threads["a1"] = [older, reply]
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.messages.count == 2 }
        #expect(backend.threadReads == ["a1"])
        #expect(thread.messages.map(\.id) == ["r", "a1"])
        #expect(thread.root == "r")
        #expect(thread.target == ThreadTarget(messageId: "a1", instanceKnowsThreads: true))
        store.closeThread()
        #expect(store.thread == nil)
    }

    /// An older instance has no thread read: the message shows alone, and a
    /// send from it is a reply.
    @Test func anOlderInstanceShowsTheMessageAlone() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("x", role: "user", "q", at: 0, knows: false), message("a", "answer", at: 10, knows: false)])
        store.openThread(at: "a")
        let thread = store.thread!
        await settle { thread.loaded }
        #expect(backend.threadReads.isEmpty)
        #expect(thread.messages.map(\.id) == ["a"])
        #expect(thread.target == ThreadTarget(messageId: "a", instanceKnowsThreads: false))
    }

    @Test func aFailedReadKeepsWhatTheChatHolds() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("r", role: "user", "plan", at: 0, thread: "r"), message("a1", "sure", at: 10, thread: "r"), message("o", "other", at: 20)])
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.loaded }
        #expect(thread.messages.map(\.id) == ["r", "a1"])
    }

    /// New messages of the thread show live; one placed elsewhere leaves it.
    @Test func theThreadFollowsEvents() async {
        let backend = FakeBackend()
        let root = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        let store = await chat(backend, [root, reply])
        backend.threads["r"] = [root, reply]
        store.openThread(at: "r")
        let thread = store.thread!
        await settle { backend.threadReads.count == 1 }
        // A new reply in the thread, and one in another.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a2", "more", at: 20, thread: "r")))
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("b", "elsewhere", at: 21, thread: "z")))
        #expect(thread.messages.map(\.id) == ["r", "a1", "a2"])
        // The guardian's message is placed here: the thread is read again.
        let mine = message("u", role: "user", "and then?", at: 30, thread: "r")
        backend.threads["r"] = [root, reply, message("a2", "more", at: 20, thread: "r"), mine]
        backend.bus.emit(LiveTopic.chat("concierge"), .messageThread(sessionId: "concierge", messageId: "u", chatThreadId: "r"))
        await settle { thread.messages.count == 4 }
        #expect(thread.messages.last?.id == "u")
        // A reply moved to another thread leaves this one.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageThread(sessionId: "concierge", messageId: "a1", chatThreadId: "z"))
        #expect(!thread.messages.contains { $0.id == "a1" })
        // The chat learns the placement too.
        #expect(store.message("a1")?.chatThreadId == "z")
        store.closeThread()
    }

    /// A send from the thread carries it, and a retry keeps it.
    @Test func aSendFromTheThreadGoesToIt() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("a1", "sure", at: 10, thread: "r")])
        store.openThread(at: "a1")
        let target = store.thread!.target
        #expect(store.send("and then?", thread: target))
        await settle { !backend.sentThreads.isEmpty }
        #expect(backend.sentThreads == [target])
        // It failed: Retry goes to the same thread.
        await settle { store.pending.first?.state == .failed }
        backend.sendSucceeds = true
        store.retry(store.pending[0].id)
        await settle { backend.sentThreads.count == 2 }
        #expect(backend.sentThreads == [target, target])
        // A send from the chat itself names no thread.
        #expect(store.send("new thing"))
        await settle { backend.sentThreads.count == 3 }
        #expect(backend.sentThreads.last == .some(nil))
    }

    /// Task chats have no chat threads.
    @Test func aTaskChatOpensNoThread() async {
        let backend = FakeBackend()
        backend.stored = [message("a", "done", at: 0, thread: "a", session: "t1")]
        let store = TranscriptStore(sessionId: "t1", kind: .task, backend: backend)
        await store.reload()
        store.openThread(at: "a")
        #expect(store.thread == nil)
    }
}

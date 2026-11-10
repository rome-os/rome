import Foundation
import Testing
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, thread: String? = nil, knows: Bool = true) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: "concierge", role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: knows)
}

private func settle(_ until: @MainActor () -> Bool) async {
    for _ in 0..<60 where await !until() { try? await Task.sleep(for: .milliseconds(10)) }
}

@MainActor
private func chat(_ backend: FakeBackend, _ messages: [ChatMessage]) async -> TranscriptStore {
    backend.stored = messages
    let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
    store.start()
    await settle { store.loaded }
    return store
}

/// Where a thread's messages come from, and where a thread draft goes.
@MainActor
@Suite struct ThreadSourceTests {
    // MARK: The draft keeps its thread

    /// The composer's draft is aimed at the open thread, and every save keeps
    /// it. Fails before the change: the first save after a restore dropped it.
    @Test func everySaveKeepsTheThread() async {
        let root = FileManager.default.temporaryDirectory.appending(path: "rome-thread-save-\(UUID().uuidString)/Drafts", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let target = ThreadTarget(messageId: "a1", instanceKnowsThreads: true)
        let drafts = DraftStore(root: root, instance: "me")
        drafts.save(chat: "concierge", text: "Half a reply", photos: [], thread: target)
        await drafts.flush()
        drafts.save(chat: "concierge", text: "Half a reply, more", photos: [], thread: target)
        await drafts.flush()
        let back = await DraftStore(root: root, instance: "me").load(chat: "concierge")
        #expect(back?.text == "Half a reply, more")
        #expect(back?.thread == target)
    }

    /// The composer is aimed where the chat says: the open thread, one still
    /// being looked up, or the chat once the thread is closed.
    @Test func theComposerFollowsTheThread() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("a1", at: 0, thread: "a1")])
        #expect(store.composerThread == nil)
        store.openThread(at: "a1")
        #expect(store.composerThread == ThreadTarget(messageId: "a1", instanceKnowsThreads: true))
        store.closeThread()
        #expect(store.composerThread == nil)
    }

    // MARK: A thread older than the pages held

    /// Fails before the change: a draft whose message was not loaded lost its thread.
    @Test func anUnloadedThreadIsAskedFor() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("new", at: 100, thread: "new")])
        let target = ThreadTarget(messageId: "old", instanceKnowsThreads: true)
        backend.threads["old"] = [message("old", role: "user", at: 0, thread: "old"), message("oldA", at: 5, thread: "old")]
        store.reopenThread(target)
        #expect(store.composerThread == target)
        await settle { store.thread != nil }
        #expect(store.thread?.anchor.id == "old")
        #expect(store.thread?.messages.map(\.id) == ["old", "oldA"])
        store.closeThread()
    }

    @Test func onlyAThreadTheServerLostIsDropped() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("new", at: 100, thread: "new")])
        let target = ThreadTarget(messageId: "old", instanceKnowsThreads: true)
        // Unreachable: the draft keeps waiting on its thread.
        backend.threadError = .network
        store.reopenThread(target)
        await settle { backend.threadReads.count == 1 }
        #expect(store.composerThread == target)
        // The next reload asks again; the server says it is gone.
        backend.threadError = nil
        await store.reload()
        #expect(store.composerThread == nil)
        #expect(store.thread == nil)
    }

    // MARK: One source of live messages

    /// The overlay shows the chat's own messages: an insert during the read,
    /// and an answer a reload brings, both show, and the read never drops them.
    @Test func theThreadShowsWhatTheChatReceives() async {
        let backend = FakeBackend()
        let root = message("r", role: "user", at: 0, thread: "r")
        let store = await chat(backend, [root])
        backend.threads["r"] = [root]
        backend.duringThreadRead = {
            // Arrives while the read is out: before the change, the read's answer replaced it.
            backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("live", at: 10, thread: "r")))
        }
        store.openThread(at: "r")
        await settle { store.thread?.loaded == true }
        #expect(store.thread?.messages.map(\.id) == ["r", "live"])
        // An answer stored without a live event, brought by the chat's reload.
        backend.stored.append(message("answer", at: 20, thread: "r"))
        await store.reload()
        #expect(store.thread?.messages.map(\.id) == ["r", "live", "answer"])
        store.closeThread()
    }

    /// A card answered in a message older than the chat's pages shows done.
    @Test func answersFromTheThreadReadCount() async {
        let backend = FakeBackend()
        let question: [String: Any] = ["type": "pending_interaction", "toolUseId": "q1", "render": ["componentId": "question-card", "builtin": true, "props": ["questions": [["id": "s", "question": "Which?", "type": "single", "options": ["A", "B"]]]]]]
        let content = String(data: try! JSONSerialization.data(withJSONObject: [question]), encoding: .utf8)!
        let card = ChatMessage(id: "q", sessionId: "concierge", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)), chatThreadId: "q", knowsThreads: true)
        let answerContent = String(data: try! JSONSerialization.data(withJSONObject: [["type": "interaction_result", "toolUseId": "q1", "output": ["answers": [["questionId": "s", "value": "A"]]]]]), encoding: .utf8)!
        let answer = ChatMessage(id: "ans", sessionId: "concierge", role: "user", content: answerContent, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_010)), chatThreadId: "q", knowsThreads: true)
        let store = await chat(backend, [message("later", at: 100, thread: "later")])
        backend.threads["q"] = [card, answer]
        store.reopenThread(ThreadTarget(messageId: "q", instanceKnowsThreads: true))
        await settle { store.thread != nil }
        let rows = store.thread?.rows(answers: store.answers) ?? []
        guard case .question(_, _, _, let answered) = rows.first(where: { if case .question = $0 { return true } else { return false } }) else {
            Issue.record("no question row"); return
        }
        #expect(answered != nil)
        store.closeThread()
    }

    // MARK: Thread support is the instance's

    /// A live insert leaves `chatThreadId` out: the instance still has
    /// threads, and a message's known thread stays.
    @Test func liveInsertsDoNotForgetThreads() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("a1", at: 0, thread: "r")])
        #expect(store.instanceKnowsThreads)
        // The same message again, without the field: its thread stays.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a1", at: 0, knows: false)))
        #expect(store.message("a1")?.chatThreadId == "r")
        // A new message without the field opens a thread that sends `chatThread`.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("fresh", at: 20, knows: false)))
        store.openThread(at: "fresh")
        #expect(store.thread?.target == ThreadTarget(messageId: "fresh", instanceKnowsThreads: true))
        store.closeThread()
    }
}

/// The header's status follows the newest news per chat.
@MainActor
@Suite struct ActivityOrderTests {
    @Test func anOlderEventIsIgnored() {
        let store = TopicChatsStore(backend: FakeBackend())
        store.heardActivity(.working, for: "c", at: 200)
        store.heardActivity(.needsYou, for: "c", at: 100)
        #expect(store.activity(for: "c") == .working)
        store.heardActivity(.needsYou, for: "c", at: 300)
        #expect(store.activity(for: "c") == .needsYou)
    }

    /// A list asked for before an event arrived never undoes it.
    @Test func aStaleListKeepsTheNewerEvent() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "t1", name: "Trip", main: false, unread: 0, activity: .working)]
        let store = TopicChatsStore(backend: backend)
        backend.duringChatsFetch = {
            backend.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "t1", activity: .needsYou, at: 500))
        }
        store.start()
        await settle { store.loaded }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(store.activity(for: "t1") == .needsYou)
        store.stop()
    }

    @Test func onlyTheChatOnScreenIsReadOut() {
        #expect(ChatIdentity.announcement("Working on it", announces: true) == "Working on it")
        #expect(ChatIdentity.announcement("Working on it", announces: false) == nil)
        #expect(ChatIdentity.announcement(nil, announces: true) == nil)
    }
}

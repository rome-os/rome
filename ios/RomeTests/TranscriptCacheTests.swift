import Foundation
import Testing
@testable import Rome

private func row(_ index: Double, chat: String = "concierge", id: String? = nil) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "message \(index)"]]), encoding: .utf8)!
    return ChatMessage(id: id ?? "m\(Int(index))", sessionId: chat, role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + index)))
}

@MainActor
@Suite(.serialized) struct TranscriptCacheTests {
    private let base = FileManager.default.temporaryDirectory.appending(path: "rome transcripts \(UUID().uuidString)", directoryHint: .isDirectory)
    private var root: URL { base.appending(path: "Transcripts", directoryHint: .isDirectory) }

    private func cache(_ instance: String = "me.romeos.cc") -> TranscriptCache {
        TranscriptCache(root: root, instance: instance)
    }

    private func written(_ cache: TranscriptCache) {
        cache.flush()
        TranscriptCache.settle()
    }

    private func cleanUp() { try? FileManager.default.removeItem(at: base) }

    /// The newest 50 come back in order, on the next launch, for this instance only.
    @Test func keepsTheNewestPagePerInstance() {
        defer { cleanUp() }
        let first = cache()
        first.save(chat: "concierge", messages: (0..<60).map { row(Double($0)) })
        written(first)
        let again = cache().messages(chat: "concierge")
        #expect(again?.map(\.id) == (10..<60).map { "m\($0)" })
        #expect(cache("other.romeos.cc").messages(chat: "concierge") == nil)
        #expect(cache().messages(chat: "topic-1") == nil)
        // Not backed up.
        let folder = root.appending(path: DraftStore.safe("me.romeos.cc"), directoryHint: .isDirectory)
        #expect((try? folder.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true)
    }

    /// Old, from another format, for another chat, or unreadable: thrown away.
    @Test func discardsWhatIsStaleOrOfAnotherShape() throws {
        defer { cleanUp() }
        let keeper = cache()
        keeper.save(chat: "concierge", messages: [row(1)])
        written(keeper)
        let file = root.appending(path: DraftStore.safe("me.romeos.cc")).appending(path: "concierge.json")
        func write(_ snapshot: TranscriptCache.Snapshot) throws {
            try JSONEncoder().encode(snapshot).write(to: file)
        }
        #expect(cache().messages(chat: "concierge", now: .now.addingTimeInterval(TranscriptCache.maxAge + 60)) == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))

        try write(.init(format: TranscriptCache.format + 1, savedAt: .now, chatId: "concierge", messages: [row(1)]))
        #expect(cache().messages(chat: "concierge") == nil)
        try write(.init(format: TranscriptCache.format, savedAt: .now, chatId: "topic-9", messages: [row(1)]))
        #expect(cache().messages(chat: "concierge") == nil)
        try Data(#"{"rows":[]}"#.utf8).write(to: file)
        #expect(cache().messages(chat: "concierge") == nil)
        try write(.init(format: TranscriptCache.format, savedAt: .now, chatId: "concierge", messages: [row(1)]))
        #expect(cache().messages(chat: "concierge")?.map(\.id) == ["m1"])
    }

    /// The kept rows are the first frame; the fetch merges by id, the server
    /// wins inside its page, and the older-page cursor is the fetch's.
    @Test func showsTheCacheThenMergesTheFetch() async {
        defer { cleanUp() }
        let backend = FakeBackend()
        backend.stored = (0..<45).map { row(Double($0)) }
        let kept = cache()
        // m2 is older than the newest page; "gone" was deleted on the server.
        kept.save(chat: "concierge", messages: [row(2)] + (30..<36).map { row(Double($0)) } + [row(35.5, id: "gone")] + (36..<40).map { row(Double($0)) })
        written(kept)

        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.cache = cache()
        store.showCached()
        #expect(store.loaded)
        #expect(!store.hasOlder)
        #expect(store.messages.map(\.id).contains("gone"))
        #expect(backend.newestFetches == 0)

        await store.reload()
        // The page is m5...m44: m2 stays until the older page brings it again.
        #expect(store.messages.map(\.id) == ["m2"] + (5..<45).map { "m\($0)" })
        #expect(store.hasOlder)
        await store.loadOlder()
        await store.placeOlderPage()
        #expect(store.messages.map(\.id) == (0..<45).map { "m\($0)" })
        #expect(!store.hasOlder)

        // What the fetch brought is kept for next time.
        written(store.cache!)
        #expect(cache().messages(chat: "concierge")?.last?.id == "m44")
    }

    /// A newest page that shares nothing with the kept rows starts over from it.
    @Test func aFarNewerPageReplacesTheCache() async {
        defer { cleanUp() }
        let backend = FakeBackend()
        backend.stored = (0..<100).map { row(Double($0)) }
        let kept = cache()
        kept.save(chat: "concierge", messages: (0..<10).map { row(Double($0)) })
        written(kept)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.cache = cache()
        store.showCached()
        await store.reload()
        #expect(store.messages.map(\.id) == (60..<100).map { "m\($0)" })
        #expect(store.hasOlder)
    }

    /// Offline at launch: the main chat opens under last time's id (a
    /// visitor's own) with its kept rows, and stays open when the instance
    /// cannot be reached. Topic chats are kept too; task chats never.
    @Test func theWorkspaceOpensOnTheKeptChats() async {
        defer { cleanUp() }
        let kept = cache("t")
        kept.setMainChat("visitor-chat")
        kept.save(chat: "visitor-chat", messages: [row(1, chat: "visitor-chat")])
        kept.save(chat: "topic-1", messages: [row(2, chat: "topic-1")])
        written(kept)

        let backend = FakeBackend()
        let drafts = DraftStore(root: base.appending(path: "Drafts", directoryHint: .isDirectory), instance: "t")
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        #expect(workspace.concierge.sessionId == "visitor-chat")
        #expect(workspace.conciergeState == .ready)
        #expect(workspace.concierge.messages.map(\.id) == ["m1"])

        await workspace.openConcierge()
        #expect(workspace.conciergeState == .ready)
        #expect(workspace.concierge.messages.map(\.id) == ["m1"])

        #expect(workspace.topicStore("topic-1").messages.map(\.id) == ["m2"])
        #expect(workspace.taskStore("task-1").cache == nil)
        workspace.stop()
    }

    /// The server names the main chat: remembered for the next launch.
    @Test func remembersTheMainChat() async {
        defer { cleanUp() }
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: "visitor-chat", unread: 0)
        let drafts = DraftStore(root: base.appending(path: "Drafts", directoryHint: .isDirectory), instance: "t")
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        #expect(workspace.conciergeState == .loading)
        await workspace.openConcierge()
        workspace.stop()
        TranscriptCache.settle()
        #expect(cache("t").mainChat() == "visitor-chat")
    }

    /// Sign-out wipes every instance, writes still waiting included; a gone
    /// instance's chats go, demo and local ones stay.
    @Test func signOutAndRemovedInstancesClear() {
        defer { cleanUp() }
        for instance in ["me.romeos.cc", "gone.romeos.cc", DraftStore.demoInstance, DraftStore.localInstance("rome.localhost")] {
            let each = cache(instance)
            each.save(chat: "concierge", messages: [row(1)])
            written(each)
        }
        TranscriptCache.removeInstances(keeping: ["me.romeos.cc"], root: root)
        #expect(cache().messages(chat: "concierge") != nil)
        #expect(cache("gone.romeos.cc").messages(chat: "concierge") == nil)
        #expect(cache(DraftStore.demoInstance).messages(chat: "concierge") != nil)
        #expect(cache(DraftStore.localInstance("rome.localhost")).messages(chat: "concierge") != nil)

        let late = cache()
        late.save(chat: "topic-1", messages: [row(2)])
        late.flush()
        TranscriptCache.removeAll(root: root)
        #expect(!FileManager.default.fileExists(atPath: root.path(percentEncoded: false)))
    }
}

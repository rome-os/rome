import Foundation
import Testing
@testable import Rome

/// A send from a chat thread that does not get through comes back in that
/// thread after a relaunch, not in the chat's own composer.
@MainActor
@Suite struct ThreadDraftTests {
    private let root = FileManager.default.temporaryDirectory.appending(path: "rome-thread-drafts-\(UUID().uuidString)/Drafts", directoryHint: .isDirectory)
    private func store() -> DraftStore { DraftStore(root: root, instance: "me.romeos.cc") }
    private func cleanUp() { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }

    private func message(_ id: String, thread: String?) -> ChatMessage {
        ChatMessage(id: id, sessionId: "topic-1", role: "assistant", content: #"[{"type":"text","content":"hi"}]"#, createdAt: RomeDate.string(.now), chatThreadId: thread, knowsThreads: true)
    }

    /// Fails before the change: the failed send came back in the chat's composer.
    @Test func aFailedThreadSendComesBackInItsThread() async {
        let target = ThreadTarget(messageId: "a1", instanceKnowsThreads: true)
        let first = store()
        first.sending(chat: DraftStore.threadChat("topic-1", messageId: "a1"), inputId: "in-1", text: "Will it rain?", photos: [], fromComposer: true, thread: target)
        await first.flush()
        // Relaunch.
        let drafts = store()
        #expect(await drafts.load(chat: "topic-1") == nil)
        #expect(await drafts.threadDrafts(chat: "topic-1") == [target])
        #expect(await drafts.load(chat: DraftStore.threadChat("topic-1", messageId: "a1"))?.text == "Will it rain?")
        // Back in the thread's composer, it no longer opens the thread on its
        // own: left there, it waits for the thread to be opened.
        #expect(await drafts.threadDrafts(chat: "topic-1").isEmpty)
        #expect(await store().load(chat: DraftStore.threadChat("topic-1", messageId: "a1"))?.text == "Will it rain?")
        cleanUp()
    }

    /// The chat opens the thread a draft is in; one whose thread is gone
    /// goes into the chat's own composer.
    @Test func theChatReopensTheThreadOrDropsTheLink() async {
        let drafts = store()
        drafts.sending(chat: DraftStore.threadChat("topic-1", messageId: "a1"), inputId: "in-1", text: "kept", photos: [], thread: ThreadTarget(messageId: "a1", instanceKnowsThreads: true))
        drafts.sending(chat: DraftStore.threadChat("topic-1", messageId: "gone"), inputId: "in-2", text: "orphan", photos: [], thread: ThreadTarget(messageId: "gone", instanceKnowsThreads: true))
        await drafts.flush()
        let relaunched = store()
        let backend = FakeBackend()
        backend.stored = [message("a1", thread: "a1")]
        let chat = TranscriptStore(sessionId: "topic-1", kind: .concierge, backend: backend)
        chat.drafts = ChatDrafts(store: relaunched, chat: "topic-1")
        await chat.reload()
        await chat.reopenThreadDraft()
        await relaunched.flush()
        #expect(chat.thread?.anchor.id == "a1")
        #expect(await relaunched.threadDrafts(chat: "topic-1") == [ThreadTarget(messageId: "a1", instanceKnowsThreads: true)])
        #expect(await relaunched.load(chat: "topic-1")?.text == "orphan")
        cleanUp()
    }
}

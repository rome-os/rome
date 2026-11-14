import Foundation
import Testing
@testable import Rome

/// The chat has one composer and one draft; a send from a chat thread that
/// does not get through comes back in it with the thread it was for.
@MainActor
@Suite struct ThreadDraftTests {
    private let root = FileManager.default.temporaryDirectory.appending(path: "rome-thread-drafts-\(UUID().uuidString)/Drafts", directoryHint: .isDirectory)
    private func store() -> DraftStore { DraftStore(root: root, instance: "me.romeos.cc") }
    private func cleanUp() { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    private let target = ThreadTarget(messageId: "a1", instanceKnowsThreads: true)

    private func message(_ id: String) -> ChatMessage {
        ChatMessage(id: id, sessionId: "topic-1", role: "assistant", content: #"[{"type":"text","content":"hi"}]"#, createdAt: RomeDate.string(.now), chatThreadId: id, knowsThreads: true)
    }

    /// Fails before the change: the restored draft had no thread, and a send
    /// went to the chat.
    @Test func aFailedThreadSendComesBackWithItsThread() async {
        let first = store()
        first.sending(chat: "topic-1", inputId: "in-1", text: "Will it rain?", photos: [], fromComposer: true, thread: target)
        await first.flush()
        let draft = await store().load(chat: "topic-1")
        #expect(draft?.text == "Will it rain?")
        #expect(draft?.thread == target)
        cleanUp()
    }

    /// Text typed for the chat keeps the whole draft in the chat.
    @Test func aMixedDraftStaysInTheChat() async {
        let drafts = store()
        drafts.save(chat: "topic-1", text: "for the chat", photos: [])
        await drafts.flush()
        drafts.sending(chat: "topic-1", inputId: "in-1", text: "for the thread", photos: [], thread: target)
        await drafts.flush()
        let draft = await store().load(chat: "topic-1")
        #expect(draft?.text == "for the chat\n\nfor the thread")
        #expect(draft?.thread == nil)
        // Two threads: neither wins.
        #expect(DraftStore.thread(of: [Draft(text: "a", photos: [], thread: target), Draft(text: "b", photos: [], thread: ThreadTarget(messageId: "z", instanceKnowsThreads: true))]) == nil)
        cleanUp()
    }

    /// The chat opens the thread again; a thread gone from the chat leaves
    /// the text in the composer for the chat.
    @Test func theChatReopensTheThreadWhileItIsThere() async {
        let backend = FakeBackend()
        // A task's thread: its messages carry the task's title.
        var anchor = message("a1")
        anchor.chatThreadId = "a1"
        anchor.chatThreadTitle = "Book flights"
        anchor.knowsThreads = true
        backend.stored = [anchor]
        let chat = TranscriptStore(sessionId: "topic-1", kind: .concierge, backend: backend)
        await chat.reload()
        chat.reopenThread(ThreadTarget(messageId: "gone", instanceKnowsThreads: true))
        #expect(chat.thread == nil)
        chat.reopenThread(target)
        #expect(chat.thread?.anchor.id == "a1")
        chat.closeThread()
    }
}

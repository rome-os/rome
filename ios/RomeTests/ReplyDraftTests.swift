import Foundation
import Testing
@testable import Rome

/// The chat has one composer and one draft; a reply that does not get through
/// comes back in it with the message it was for.
@MainActor
@Suite struct ReplyDraftTests {
    private let root = FileManager.default.temporaryDirectory.appending(path: "rome-reply-drafts-\(UUID().uuidString)/Drafts", directoryHint: .isDirectory)
    private func store() -> DraftStore { DraftStore(root: root, instance: "me.romeos.cc") }
    private func cleanUp() { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    private let target = ReplyTarget(messageId: "a1")

    @Test func aFailedReplyComesBackWithItsMessage() async {
        let first = store()
        first.sending(chat: "topic-1", inputId: "in-1", text: "Will it rain?", photos: [], fromComposer: true, reply: target)
        await first.flush()
        let draft = await store().load(chat: "topic-1")
        #expect(draft?.text == "Will it rain?")
        #expect(draft?.reply == target)
        cleanUp()
    }

    /// Every save keeps the reply the composer is aimed at.
    @Test func everySaveKeepsTheReply() async {
        let drafts = store()
        drafts.save(chat: "concierge", text: "Half a reply", photos: [], reply: target)
        await drafts.flush()
        drafts.save(chat: "concierge", text: "Half a reply, more", photos: [], reply: target)
        await drafts.flush()
        let back = await store().load(chat: "concierge")
        #expect(back?.text == "Half a reply, more")
        #expect(back?.reply == target)
        cleanUp()
    }

    /// Text typed with no reply keeps the whole draft out of one.
    @Test func aMixedDraftRepliesToNothing() async {
        let drafts = store()
        drafts.save(chat: "topic-1", text: "plain", photos: [])
        await drafts.flush()
        drafts.sending(chat: "topic-1", inputId: "in-1", text: "a reply", photos: [], reply: target)
        await drafts.flush()
        let draft = await store().load(chat: "topic-1")
        #expect(draft?.text == "plain\n\na reply")
        #expect(draft?.reply == nil)
        // Two messages: neither wins.
        #expect(DraftStore.reply(of: [Draft(text: "a", photos: [], reply: target), Draft(text: "b", photos: [], reply: ReplyTarget(messageId: "z"))]) == nil)
        cleanUp()
    }
}

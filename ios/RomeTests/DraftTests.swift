import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct DraftTests {
    private let root = FileManager.default.temporaryDirectory.appending(path: "rome drafts \(UUID().uuidString)/Application Support", directoryHint: .isDirectory)

    private func store(_ instance: String = "me.romeos.cc") -> DraftStore {
        DraftStore(root: root, instance: instance)
    }

    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func photo(_ byte: UInt8) -> ComposerImage { ComposerImage(jpeg: Data([0xFF, 0xD8, byte])) }

    @Test func savesAndRestoresAfterARelaunch() async {
        let first = store()
        let photos = [photo(1), photo(2)]
        first.save(chat: "concierge", text: "Half a thought", photos: photos)
        // A new store reads it back from disk, photos and all.
        let draft = await store().load(chat: "concierge")
        #expect(draft?.text == "Half a thought")
        #expect(draft?.photos.map(\.id) == photos.map(\.id))
        #expect(draft?.photos.map(\.jpeg) == photos.map(\.jpeg))
        try? FileManager.default.removeItem(at: root)
    }

    @Test func eachChatAndInstanceHasItsOwn() async {
        store().save(chat: "concierge", text: "main", photos: [])
        store().save(chat: "topic-1", text: "topic", photos: [])
        store("team.romeos.cc").save(chat: "concierge", text: "other instance", photos: [])
        #expect(await store().load(chat: "concierge")?.text == "main")
        #expect(await store().load(chat: "topic-1")?.text == "topic")
        #expect(await store("team.romeos.cc").load(chat: "concierge")?.text == "other instance")
        try? FileManager.default.removeItem(at: root)
    }

    @Test func emptyingTheComposerClearsItAndItsPhotos() async {
        let drafts = store()
        drafts.save(chat: "c", text: "x", photos: [photo(1)])
        drafts.save(chat: "c", text: "  ", photos: [])
        #expect(await store().load(chat: "c") == nil)
        let files = (try? FileManager.default.subpathsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []
        #expect(!files.contains { $0.hasSuffix(".jpg") })
        try? FileManager.default.removeItem(at: root)
    }

    @Test func aDeliveredSendClearsTheDraft() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let drafts = store()
        let chat = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        chat.drafts = ChatDrafts(store: drafts, chat: "concierge")
        drafts.save(chat: "concierge", text: "Send me", photos: [])
        chat.send("Send me")
        drafts.save(chat: "concierge", text: "", photos: [])
        await settle()
        #expect(await store().load(chat: "concierge") == nil)
        try? FileManager.default.removeItem(at: root)
    }

    @Test func aFailedSendKeepsTheDraftForTheNextLaunch() async {
        let backend = FakeBackend()
        let drafts = store()
        let chat = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        chat.drafts = ChatDrafts(store: drafts, chat: "concierge")
        let photos = [photo(7)]
        chat.send("Did not go", images: photos)
        // The composer empties at once.
        drafts.save(chat: "concierge", text: "", photos: [])
        await settle()
        // This session shows it as a failed bubble with retry, not as a draft too.
        #expect(await drafts.load(chat: "concierge") == nil)
        // The next launch hands it back.
        let draft = await store().load(chat: "concierge")
        #expect(draft?.text == "Did not go")
        #expect(draft?.photos.map(\.id) == photos.map(\.id))
        try? FileManager.default.removeItem(at: root)
    }

    @Test func aNewDraftWinsOverAnUnsentOne() async {
        let backend = FakeBackend()
        let chat = TranscriptStore(sessionId: "c", kind: .concierge, backend: backend)
        chat.drafts = ChatDrafts(store: store(), chat: "c")
        chat.send("old")
        await settle()
        let later = store()
        later.save(chat: "c", text: "new", photos: [])
        #expect(await later.load(chat: "c")?.text == "new")
        try? FileManager.default.removeItem(at: root)
    }

    @Test func signOutWipesEveryDraft() async {
        store().save(chat: "c", text: "x", photos: [photo(1)])
        store("team.romeos.cc").save(chat: "c", text: "y", photos: [])
        DraftStore.removeAll(root: root)
        #expect(await store().load(chat: "c") == nil)
        #expect(await store("team.romeos.cc").load(chat: "c") == nil)
    }

    @Test func aRemovedInstanceLosesItsDrafts() async {
        store().save(chat: "c", text: "keep", photos: [])
        store("gone.romeos.cc").save(chat: "c", text: "drop", photos: [])
        DraftStore.removeInstances(keeping: ["me.romeos.cc"], root: root)
        #expect(await store().load(chat: "c")?.text == "keep")
        #expect(await store("gone.romeos.cc").load(chat: "c") == nil)
        try? FileManager.default.removeItem(at: root)
    }

    @Test func aBlankTopicChatLeftUnsentIsDiscarded() async {
        let drafts = store()
        let blank = DraftStore.blankChat(UUID())
        drafts.save(chat: blank, text: "never sent", photos: [photo(3)])
        drafts.discard(chat: blank)
        #expect(await store().load(chat: blank) == nil)
        // One left over from a killed app goes at the next start.
        let leftover = DraftStore.blankChat(UUID())
        drafts.save(chat: leftover, text: "orphan", photos: [])
        drafts.save(chat: "topic-1", text: "real", photos: [])
        store().discardBlankChats()
        #expect(await store().load(chat: leftover) == nil)
        #expect(await store().load(chat: "topic-1")?.text == "real")
        try? FileManager.default.removeItem(at: root)
    }

    @Test func photosLiveInFilesNotUserDefaults() {
        store().save(chat: "c", text: "", photos: [photo(9)])
        let files = (try? FileManager.default.subpathsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []
        #expect(files.contains { $0.hasSuffix(".jpg") })
        #expect(UserDefaults.standard.dictionaryRepresentation().keys.allSatisfy { !$0.lowercased().contains("draft") })
        try? FileManager.default.removeItem(at: root)
    }
}

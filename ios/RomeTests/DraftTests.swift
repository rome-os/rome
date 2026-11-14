import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct DraftTests {
    /// A space in the path, like Application Support's.
    private let root = FileManager.default.temporaryDirectory.appending(path: "rome drafts \(UUID().uuidString)/Application Support", directoryHint: .isDirectory)

    private func store(_ instance: String = "me.romeos.cc") -> DraftStore {
        DraftStore(root: root, instance: instance)
    }

    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func photo(_ byte: UInt8) -> ComposerImage { ComposerImage(jpeg: Data([0xFF, 0xD8, byte])) }

    private func cleanUp() { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }

    private func jpegCount() -> Int {
        ((try? FileManager.default.subpathsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []).filter { $0.hasSuffix(".jpg") }.count
    }

    // MARK: Saving and restoring

    @Test func savesAndRestoresAfterARelaunch() async {
        let first = store()
        let photos = [photo(1), photo(2)]
        first.save(chat: "concierge", text: "Half a thought", photos: photos)
        await first.flush()
        let draft = await store().load(chat: "concierge")
        #expect(draft?.text == "Half a thought")
        #expect(draft?.photos.map(\.id) == photos.map(\.id))
        #expect(draft?.photos.map(\.jpeg) == photos.map(\.jpeg))
        cleanUp()
    }

    @Test func eachChatAndInstanceHasItsOwn() async {
        let a = store(), b = store("team.romeos.cc")
        a.save(chat: "concierge", text: "main", photos: [])
        a.save(chat: "topic-1", text: "topic", photos: [])
        b.save(chat: "concierge", text: "other instance", photos: [])
        await a.flush()
        await b.flush()
        #expect(await store().load(chat: "concierge")?.text == "main")
        #expect(await store().load(chat: "topic-1")?.text == "topic")
        #expect(await store("team.romeos.cc").load(chat: "concierge")?.text == "other instance")
        cleanUp()
    }

    @Test func emptyingTheComposerClearsItAndItsPhotos() async {
        let drafts = store()
        drafts.save(chat: "c", text: "x", photos: [photo(1)])
        await drafts.flush()
        drafts.save(chat: "c", text: "  ", photos: [])
        await drafts.flush()
        #expect(await store().load(chat: "c") == nil)
        #expect(jpegCount() == 0)
        cleanUp()
    }

    // MARK: Sending

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
        await drafts.flush()
        #expect(await store().load(chat: "concierge") == nil)
        cleanUp()
    }

    @Test func aFailedSendKeepsTheDraftForTheNextLaunch() async {
        let drafts = store()
        let chat = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: FakeBackend())
        chat.drafts = ChatDrafts(store: drafts, chat: "concierge")
        let photos = [photo(7)]
        chat.send("Did not go", images: photos)
        drafts.save(chat: "concierge", text: "", photos: [])
        await settle()
        await drafts.flush()
        // This session shows it as a failed bubble with Retry, not as a draft too.
        #expect(await drafts.load(chat: "concierge") == nil)
        let draft = await store().load(chat: "concierge")
        #expect(draft?.text == "Did not go")
        #expect(draft?.photos.map(\.id) == photos.map(\.id))
        cleanUp()
    }

    /// Review 1: once restored, the live slot is the only draft.
    @Test func aRestoredSendStaysClearedOnceTheComposerEmpties() async {
        let failed = store()
        failed.sending(chat: "c", inputId: "in-1", text: "Lost send", photos: [])
        await failed.flush()
        let next = store()
        #expect(await next.load(chat: "c")?.text == "Lost send")
        next.save(chat: "c", text: "", photos: [])
        await next.flush()
        #expect(await store().load(chat: "c") == nil)
        cleanUp()
    }

    /// Review 4: two lost sends come back as one draft, oldest first.
    @Test func twoLostSendsMergeOldestFirst() async {
        let failed = store()
        failed.sending(chat: "c", inputId: "in-1", text: "First", photos: [photo(1), photo(2), photo(3)])
        await failed.flush()
        try? await Task.sleep(for: .milliseconds(1100))
        failed.sending(chat: "c", inputId: "in-2", text: "Second", photos: [photo(4), photo(5)])
        await failed.flush()
        let next = store()
        let draft = await next.load(chat: "c")
        #expect(draft?.text == "First\n\nSecond")
        #expect(draft?.photos.count == 4)
        // The fifth photo is kept, not deleted: it comes back after this draft is sent.
        #expect(jpegCount() == 5)
        next.save(chat: "c", text: "", photos: [])
        await next.flush()
        #expect(await store().load(chat: "c")?.photos.count == 1)
        cleanUp()
    }

    /// Review 5: a send that got through is not handed back.
    @Test func aSendAlreadyInTheTranscriptIsDropped() async {
        let failed = store()
        failed.sending(chat: "c", inputId: "in-1", text: "By id", photos: [])
        await failed.flush()
        let byId = await store().load(chat: "c", transcript: [SentMessage(id: "in-1", text: "By id", date: .now)])
        #expect(byId == nil)

        // The same text under another id is a second message: it comes back.
        failed.sending(chat: "c", inputId: "in-2", text: "Same text", photos: [])
        await failed.flush()
        let byText = await store().load(chat: "c", transcript: [SentMessage(id: "other", text: "Same text", date: .now)])
        #expect(byText?.text == "Same text")
        cleanUp()
    }

    /// Review 3: a live draft never hides an unsent message.
    @Test func theLiveDraftAndAnUnsentSendAlwaysMerge() async {
        let first = store()
        first.save(chat: "c", text: "Typed later", photos: [])
        first.sending(chat: "c", inputId: "in-1", text: "Lost send", photos: [])
        await first.flush()
        let next = store()
        #expect(await next.load(chat: "c")?.text == "Typed later\n\nLost send")
        // Merged once: the unsent slot is gone.
        #expect(await store().load(chat: "c")?.text == "Typed later\n\nLost send")
        cleanUp()
    }

    /// Review 3: a kill right after a send does not keep the sent text in the composer too.
    @Test func aComposerSendClearsTheLiveDraftAtOnce() async {
        let drafts = store()
        drafts.save(chat: "c", text: "Hello", photos: [])
        await drafts.flush()
        drafts.save(chat: "c", text: "Hello", photos: [])
        drafts.sending(chat: "c", inputId: "in-1", text: "Hello", photos: [], fromComposer: true)
        await drafts.flush()
        #expect(await store().load(chat: "c")?.text == "Hello")
        cleanUp()
    }

    /// Review 3: a starter does not wipe what the composer holds.
    @Test func aStarterSendKeepsTheComposersDraft() async {
        let drafts = store()
        drafts.save(chat: "c", text: "Half typed", photos: [])
        await drafts.flush()
        drafts.sending(chat: "c", inputId: "in-1", text: "Starter", photos: [])
        drafts.delivered(chat: "c", inputId: "in-1")
        await drafts.flush()
        #expect(await store().load(chat: "c")?.text == "Half typed")
        cleanUp()
    }

    // MARK: Task and blank chats

    /// Review 2: a task chat's store outlives its screen, with its failed bubble.
    @Test func aTaskChatKeepsItsFailedSendAcrossVisits() async {
        let backend = FakeBackend()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: store())
        let first = workspace.taskStore("task-1")
        first.send("Did not go")
        await settle()
        let again = workspace.taskStore("task-1")
        #expect(again === first)
        #expect(again.pending.contains { $0.text == "Did not go" && $0.state == .failed(.unreachable) })
        cleanUp()
    }

    /// Review 3: a blank chat's first message survives a failed start…
    @Test func aFailedStartHandsTheMessageBack() async {
        let backend = FakeBackend()
        backend.startFails = true
        let drafts = store()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        let blank = DraftStore.blankChat(UUID())
        let id = await workspace.startTopicChat(firstMessage: "Plan it", images: [photo(1)], blankKey: blank, fromComposer: true)
        #expect(id == nil)
        await drafts.flush()
        // Back in the blank chat's draft, once.
        let draft = await store().load(chat: blank)
        #expect(draft?.text == "Plan it")
        #expect(draft?.photos.count == 1)
        cleanUp()
    }

    /// …even when the guardian left the chat while it was starting: the next blank chat has it.
    @Test func aFailedStartAfterLeavingComesBackInTheNextBlankChat() async {
        let backend = FakeBackend()
        backend.startFails = true
        let drafts = store()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        let blank = DraftStore.blankChat(UUID())
        _ = await workspace.startTopicChat(firstMessage: "Left behind", blankKey: blank, fromComposer: true)
        await drafts.flush()
        let relaunched = store()
        relaunched.discardBlankChats()
        #expect(await relaunched.load(chat: DraftStore.blankChat(UUID()))?.text == "Left behind")
        // Taken once.
        #expect(await store().load(chat: DraftStore.blankChat(UUID())) == nil)
        cleanUp()
    }

    /// …and a kill while the chat is being made.
    @Test func aBlankChatsCutOffMessageComesBackInTheNextBlankChat() async {
        let killed = store()
        let blank = DraftStore.blankChat(UUID())
        killed.sending(chat: blank, inputId: "start-1", text: "Mid-create", photos: [photo(2)])
        await killed.flush()
        let next = store()
        next.discardBlankChats()
        let draft = await next.load(chat: DraftStore.blankChat(UUID()))
        #expect(draft?.text == "Mid-create")
        #expect(draft?.photos.count == 1)
        cleanUp()
    }

    @Test func aStartedChatMovesTheMessageToItself() async {
        let backend = FakeBackend()
        let drafts = store()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        let blank = DraftStore.blankChat(UUID())
        let id = await workspace.startTopicChat(firstMessage: "Hello", blankKey: blank)
        await settle()
        await drafts.flush()
        #expect(id == "topic-1")
        #expect(await store().load(chat: blank) == nil)
        // The send failed (the fake fails sends), so the new chat has it.
        #expect(await store().load(chat: "topic-1")?.text == "Hello")
        cleanUp()
    }

    @Test func aBlankTopicChatLeftUnsentIsDiscarded() async {
        let drafts = store()
        let blank = DraftStore.blankChat(UUID())
        drafts.save(chat: blank, text: "never sent", photos: [photo(3)])
        drafts.discard(chat: blank)
        await drafts.flush()
        #expect(await store().load(chat: blank) == nil)
        let leftover = DraftStore.blankChat(UUID())
        drafts.save(chat: leftover, text: "orphan", photos: [])
        drafts.save(chat: "topic-1", text: "real", photos: [])
        await drafts.flush()
        let next = store()
        next.discardBlankChats()
        #expect(await next.load(chat: leftover) == nil)
        #expect(await next.load(chat: "topic-1")?.text == "real")
        cleanUp()
    }

    // MARK: Writing off the main actor

    /// Review 6: saves wait a moment, and a later discard always wins.
    @Test func savesAreDebouncedAndOrdered() async {
        let drafts = store()
        drafts.save(chat: "c", text: "a", photos: [])
        drafts.save(chat: "c", text: "ab", photos: [])
        // Not on disk yet, but this store already answers with it.
        #expect(await store().load(chat: "c") == nil)
        #expect(await drafts.load(chat: "c")?.text == "ab")
        drafts.discard(chat: "c")
        try? await Task.sleep(for: .milliseconds(500))
        await drafts.flush()
        #expect(await store().load(chat: "c") == nil)
        cleanUp()
    }

    // MARK: Clearing

    @Test func signOutWipesEveryDraft() async {
        let a = store(), b = store("team.romeos.cc")
        a.save(chat: "c", text: "x", photos: [photo(1)])
        b.save(chat: "c", text: "y", photos: [])
        await a.flush()
        await b.flush()
        DraftStore.removeAll(root: root)
        #expect(await store().load(chat: "c") == nil)
        #expect(await store("team.romeos.cc").load(chat: "c") == nil)
        cleanUp()
    }

    /// Review 7: demo and local drafts are not swept by Rome Cloud's list.
    @Test func aRemovedInstanceLosesItsDraftsButDemoAndLocalStay() async {
        let keep = store(), gone = store("gone.romeos.cc"), demo = store(DraftStore.demoInstance), local = store(DraftStore.localInstance("127.0.0.1"))
        for drafts in [keep, gone, demo, local] {
            drafts.save(chat: "c", text: drafts.instance, photos: [])
            await drafts.flush()
        }
        DraftStore.removeInstances(keeping: ["me.romeos.cc"], root: root)
        #expect(await store().load(chat: "c") != nil)
        #expect(await store("gone.romeos.cc").load(chat: "c") == nil)
        #expect(await store(DraftStore.demoInstance).load(chat: "c") != nil)
        #expect(await store(DraftStore.localInstance("127.0.0.1")).load(chat: "c") != nil)
        cleanUp()
    }

    /// Review 7: "." and ".." never name the parent folder.
    @Test func dotNamesStayInsideTheirFolder() {
        #expect(DraftStore.safe(".") == "%2E")
        #expect(DraftStore.safe("..") == "%2E%2E")
        #expect(DraftStore.safe("a/b") == "a%2Fb")
        #expect(DraftStore.safe("concierge") == "concierge")
    }

    @Test func photosLiveInFilesNotUserDefaults() async {
        let drafts = store()
        drafts.save(chat: "c", text: "", photos: [photo(9)])
        await drafts.flush()
        #expect(jpegCount() == 1)
        #expect(UserDefaults.standard.dictionaryRepresentation().keys.allSatisfy { !$0.lowercased().contains("draft") })
        cleanUp()
    }
}

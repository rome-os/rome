import Foundation
import Testing
@testable import Rome

/// A visitor's main chat is not `concierge`: everything sent to the server
/// goes by its own id, while the app's screens keep naming it the main chat.
@Suite @MainActor struct VisitorMainChatTests {
    private static let visitorChat = "concierge-v-0123456789abcdef01234567"

    private func workspace(_ backend: FakeBackend, drafts: DraftStore) -> Workspace {
        Workspace(backend: backend, instanceName: "Team", host: "team.romeos.cc", accountLabel: "v@example.com", drafts: drafts)
    }

    private func draftStore() -> DraftStore {
        DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-visitor-\(UUID().uuidString)/Drafts", directoryHint: .isDirectory), instance: "team.romeos.cc")
    }

    @Test func aVisitorsTranscriptGoesByTheirOwnChatId() async {
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: Self.visitorChat, unread: 0)
        let space = workspace(backend, drafts: draftStore())
        await space.openConcierge()
        #expect(space.mainChatServerID == Self.visitorChat)
        // Loads, sends and the live topic all use the store's id.
        #expect(space.concierge.sessionId == Self.visitorChat)
        #expect(space.concierge.drafts?.chat == Self.visitorChat)
        #expect(space.isMainChat(Self.visitorChat) && space.isMainChat(conciergeChatID))
        #expect(!space.isMainChat("topic-1"))
    }

    /// New app on a visitor's Apps screen asks the visitor's own main chat,
    /// never the guardian's `concierge`.
    @Test func aVisitorsNewAppGoesToTheirOwnChat() async {
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: Self.visitorChat, unread: 0)
        backend.identity = .success(AccountIdentity(name: "Visitor", isGuardian: false))
        let space = workspace(backend, drafts: draftStore())
        await space.readRole()
        await space.openConcierge()
        #expect(space.isVisitor)
        // What Apps' onStart does, then the composer's send.
        space.composerPrefill = AppIdea.habitTracker.prompt
        space.concierge.send(space.composerPrefill ?? "")
        try? await Task.sleep(for: .milliseconds(50))
        #expect(backend.calls.contains("send \(Self.visitorChat) \(AppIdea.habitTracker.prompt)"))
        #expect(!backend.calls.contains { $0.hasPrefix("send \(conciergeChatID) ") })
    }

    @Test func theGuardianKeepsConcierge() async {
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: conciergeChatID, unread: 0)
        let space = workspace(backend, drafts: draftStore())
        let before = space.concierge
        await space.openConcierge()
        #expect(space.concierge === before)
        #expect(space.concierge.sessionId == conciergeChatID)
    }

    /// What this phone kept under `concierge` before moves to the visitor's own id.
    @Test func draftsMoveToTheVisitorsChat() async {
        let drafts = draftStore()
        drafts.save(chat: conciergeChatID, text: "Half a thought", photos: [])
        await drafts.flush()
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: Self.visitorChat, unread: 0)
        let space = workspace(backend, drafts: drafts)
        await space.openConcierge()
        #expect(await drafts.load(chat: Self.visitorChat)?.text == "Half a thought")
        #expect(await drafts.load(chat: conciergeChatID) == nil)
    }

    /// Push presentation and routing know the visitor's main chat as the main chat.
    @Test func pushesKnowTheVisitorsMainChat() {
        #expect(PushPresentation.serverChat(conciergeChatID, mainServerID: Self.visitorChat) == Self.visitorChat)
        let topics = TopicChatsStore.topics(in: [
            ConciergeChat(id: Self.visitorChat, name: "Chat", main: true, unread: 0),
            ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 0),
        ])
        #expect(topics.map(\.id) == ["topic-1"])
        #expect(PushRoute.topicChat(for: PushTarget(instanceId: "i", chatId: Self.visitorChat), topics: topics) == nil)
    }

    /// Who the session is: a visitor hides the guardian's controls; an unreadable answer hides nothing.
    @Test func readsTheRole() async {
        let backend = FakeBackend()
        let space = workspace(backend, drafts: draftStore())
        backend.identity = .success(AccountIdentity(name: "v@example.com", isGuardian: false))
        await space.readRole()
        #expect(space.isVisitor && !space.isGuardian)
        backend.identity = .success(AccountIdentity(name: "Lin"))
        await space.readRole()
        #expect(space.isGuardian)
        backend.identity = .failure(APIError.network)
        await space.readRole()
        #expect(space.role == .unknown && !space.isVisitor)
    }

    @Test func visitorIdentityFromAuthMe() {
        let visitor = AccountIdentity(json: .object(["kind": .string("visitor"), "email": .string("v@example.com")]))
        #expect(visitor?.isGuardian == false)
        let guardian = AccountIdentity(json: .object(["kind": .string("guardian")]))
        #expect(guardian?.isGuardian == true)
    }
}

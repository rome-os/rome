import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct TopicChatTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func workspace(_ backend: FakeBackend) -> Workspace {
        Workspace(backend: backend, instanceName: "Test", host: "test", accountLabel: "test", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-tests-\(UUID().uuidString)/Drafts"), instance: "test"))
    }

    @Test func aBlankChatCreatesNothingUntilTheFirstSend() async {
        let backend = FakeBackend()
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(backend.calls.isEmpty)
        #expect(workspace.topics.chats.isEmpty)
    }

    @Test func theFirstSendStartsTheChatThenSendsToIt() async {
        let backend = FakeBackend()
        let workspace = workspace(backend)
        let id = await workspace.startTopicChat(firstMessage: "Plan the Kyoto trip")
        await settle()
        #expect(id == "topic-1")
        #expect(backend.calls == ["start", "send topic-1 Plan the Kyoto trip"])
        #expect(workspace.topics.chats.map(\.id) == ["topic-1"])
    }

    @Test func aChatThatCannotStartSendsNothing() async {
        let backend = FakeBackend()
        backend.startFails = true
        let workspace = workspace(backend)
        let id = await workspace.startTopicChat(firstMessage: "Hello")
        await settle()
        #expect(id == nil)
        #expect(backend.calls == ["start"])
        #expect(workspace.topics.chats.isEmpty)
    }

    @Test func theDrawerListsTopicChatsAndFollowsTheirNames() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "topic-1", name: "", main: false, unread: 3)]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.chats.map(\.id) == ["topic-1"])
        #expect(TopicChatsStore.title(store.chat("topic-1")) == "New chat")
        backend.bus.emit(LiveTopic.chat("topic-1"), .sessionName(sessionId: "topic-1", name: "Kyoto trip"))
        #expect(TopicChatsStore.title(store.chat("topic-1")) == "Kyoto trip")
    }

    /// As on the web, a named chat's composer says which chat a message goes to.
    @Test func theComposerNamesTheChatOnceItHasOne() {
        #expect(TopicChatsStore.composerPlaceholder(nil, replying: false) == "Message")
        let unnamed = ConciergeChat(id: "topic-1", name: "  ", main: false, unread: 0)
        #expect(TopicChatsStore.composerPlaceholder(unnamed, replying: false) == "Message")
        let named = ConciergeChat(id: "topic-1", name: " Kyoto trip ", main: false, unread: 0)
        #expect(TopicChatsStore.composerPlaceholder(named, replying: false) == "Message in Kyoto trip")
        #expect(TopicChatsStore.composerPlaceholder(named, replying: true) == "Reply")
    }

    /// A chat read beside the pinned drawer (iPad) loses its badge at once.
    @Test func readingAChatClearsItsBadge() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 3), ConciergeChat(id: "topic-2", name: "Books", main: false, unread: 1)]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        store.markRead("topic-1")
        #expect(store.chat("topic-1")?.unread == 0)
        #expect(store.chat("topic-2")?.unread == 1)
    }

    @Test func renameSendsTheNameAndUpdatesTheDrawer() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "topic-1", name: "Old", main: false, unread: 0)]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(await workspace.renameTopic("topic-1", to: "  Kyoto trip "))
        #expect(backend.calls == ["rename topic-1 Kyoto trip"])
        #expect(workspace.topics.chat("topic-1")?.name == "Kyoto trip")
        // A blank name is not sent.
        #expect(await !workspace.renameTopic("topic-1", to: "   "))
        #expect(backend.calls.count == 1)
    }

    @Test func archiveRemovesTheChatFromTheDrawer() async {
        let backend = FakeBackend()
        backend.topicChats = [
            ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 0),
            ConciergeChat(id: "topic-2", name: "Home", main: false, unread: 0),
        ]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(await workspace.archiveTopic("topic-1"))
        #expect(backend.calls == ["archive topic-1"])
        #expect(workspace.topics.chats.map(\.id) == ["topic-2"])
        // A refetch agrees: the server no longer lists it.
        workspace.topics.refresh()
        await settle()
        #expect(workspace.topics.chats.map(\.id) == ["topic-2"])
    }

    /// As on the web: a delete moves the chat's follows and open tasks unless
    /// the guardian chose to stop them.
    @Test func deleteStopsTheChatsWorkOnlyWhenAsked() async {
        let backend = FakeBackend()
        backend.topicChats = [
            ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 0),
            ConciergeChat(id: "topic-2", name: "Home", main: false, unread: 0),
        ]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(await workspace.deleteTopic("topic-1"))
        #expect(await workspace.deleteTopic("topic-2", stoppingWork: true))
        #expect(backend.calls == ["delete topic-1", "delete topic-2 stopping work"])
        #expect(workspace.topics.chats.isEmpty)
    }

    /// The list arrives; a failed read, or one slower than the wait, gives
    /// nil, and the delete moves them. The waits are far apart, so a busy
    /// test machine cannot flip the outcome.
    @Test func theDeleteReadsTheChatsWorkOrGivesUp() async {
        let backend = FakeBackend()
        let workspace = workspace(backend)
        #expect(await workspace.topicWork("topic-1", wait: .seconds(60)) == nil)
        let work = ConciergeChatWork(openTasks: [.init(id: "t1", title: "Book the hotel")])
        backend.chatWorkAnswer = work
        #expect(await workspace.topicWork("topic-1", wait: .seconds(60)) == work)
        // An answer that would take two minutes is given up on long before.
        backend.chatWorkDelay = .seconds(120)
        let started = ContinuousClock.now
        #expect(await workspace.topicWork("topic-1", wait: .milliseconds(50)) == nil)
        #expect(ContinuousClock.now - started < .seconds(60))
        #expect(backend.calls == ["work topic-1", "work topic-1", "work topic-1"])
    }

    @Test func aTurnInAnUnknownChatRefetchesTheList() async {
        let backend = FakeBackend()
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        backend.topicChats = [ConciergeChat(id: "topic-9", name: "Started on the web", main: false, unread: 0)]
        backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "topic-9", running: true))
        await settle()
        #expect(store.chats.map(\.id) == ["topic-9"])
    }
}

@Suite struct ConciergeChatListTests {
    @Test func parsesTheListAndKeepsOnlyTopicChats() throws {
        let json = #"{"chats":[{"id":"concierge","name":"Concierge","main":true,"unread":1},{"id":"c-2","name":"Trip","main":false,"unread":0},{"id":"c-3","name":"","main":false,"unread":4}]}"#
        let response = try JSONDecoder().decode(ConciergeChatsResponse.self, from: Data(json.utf8))
        let topics = TopicChatsStore.topics(in: response.chats)
        #expect(topics.map(\.id) == ["c-2", "c-3"])
        #expect(topics.last?.unread == 4)
    }

    @Test func aTaskRowNamesItsConciergeChat() throws {
        let json = #"{"id":"t","title":"T","state":"doing","createdAt":1,"updatedAt":1,"conciergeChat":{"id":"c-2","name":"Trip","main":false}}"#
        let task = try JSONDecoder().decode(ConciergeTask.self, from: Data(json.utf8))
        #expect(task.conciergeChat?.id == "c-2")
    }
}

/// The delete alert of a topic chat says what the web's dialog says.
@Suite struct TopicDeletePromptTests {
    @Test func listsFiveThenCountsTheRestAndAsks() {
        let work = ConciergeChatWork(
            follows: [.init(source: "github", label: "GitHub", target: "rome-os/rome"), .init(source: "gmail", label: "Gmail", target: "inbox")],
            openTasks: (1...5).map { .init(id: "t\($0)", title: "Task \($0)") }
        )
        let prompt = TopicDeletePrompt(id: "topic-1", name: "Trip", work: work)
        #expect(prompt.title == "Delete “Trip”?")
        #expect(prompt.asksAboutWork)
        #expect(prompt.message == """
        This chat is deleted permanently. It has:
        • Following GitHub · rome-os/rome
        • Following Gmail · inbox
        • Open task: Task 1
        • Open task: Task 2
        • Open task: Task 3
        and 2 more

        What happens to them?
        """)
    }

    @Test func anEmptyChatHasNothingToChoose() {
        let prompt = TopicDeletePrompt(id: "topic-1", name: "Trip", work: ConciergeChatWork())
        #expect(!prompt.asksAboutWork)
        #expect(prompt.message == "This chat is deleted permanently.")
    }

    /// Unread (an older instance, a slow network), they move, and the alert says so.
    @Test func anUnreadListSaysTheyMove() {
        let prompt = TopicDeletePrompt(id: "topic-1", name: "Trip", work: nil)
        #expect(!prompt.asksAboutWork)
        #expect(prompt.message == "This chat is deleted permanently. Its follows and open tasks move to Chat.")
    }

    @Test func parsesTheServersList() throws {
        let json = #"{"follows":[{"source":"github","label":"GitHub","target":"rome-os/rome"}],"openTasks":[{"id":"t1","title":"Book the hotel"}]}"#
        let work = try JSONDecoder().decode(ConciergeChatWork.self, from: Data(json.utf8))
        #expect(work.follows.map(\.label) == ["GitHub"])
        #expect(work.openTasks.map(\.title) == ["Book the hotel"])
        let partial = try JSONDecoder().decode(ConciergeChatWork.self, from: Data(#"{"follows":[]}"#.utf8))
        #expect(partial.isEmpty)
    }
}

@Suite struct TopicPushRouteTests {
    let topics = [ConciergeChat(id: "c-trip", name: "Trip", main: false)]

    @Test func aTopicChatOpensIt() {
        #expect(PushRoute.topicChat(for: PushTarget(instanceId: "i", chatId: "c-trip"), topics: topics) == "c-trip")
    }

    @Test func theMainChatOrAnUnknownOneOpensChat() {
        #expect(PushRoute.topicChat(for: PushTarget(instanceId: "i", chatId: "concierge"), topics: topics) == nil)
        #expect(PushRoute.topicChat(for: PushTarget(instanceId: "i", chatId: "c-gone"), topics: topics) == nil)
        #expect(PushRoute.topicChat(for: PushTarget(instanceId: "i"), topics: topics) == nil)
    }
}

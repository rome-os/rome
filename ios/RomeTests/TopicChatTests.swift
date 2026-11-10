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

@Suite struct TaskFilterTests {
    private func task(_ id: String, from chat: ConciergeChat?) -> ConciergeTask {
        ConciergeTask(
            id: id, title: id, state: .needsUser, summary: nil, waitingOn: nil, dueAt: nil, rank: nil, chat: nil,
            conciergeChat: chat, sourceMessageId: nil, createdAt: 1, updatedAt: 1, completedAt: nil, archivedAt: nil, notSynced: nil
        )
    }

    @Test func eachChatListsItsOwnTasks() {
        let main = ConciergeChat(id: conciergeChatID, name: "", main: true)
        let trip = ConciergeChat(id: "c-trip", name: "Trip", main: false)
        let tasks = [task("a", from: main), task("b", from: trip), task("c", from: nil)]
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let inMain = TasksStore.group(tasks.filter { TasksStore.belongs($0, toChat: conciergeChatID) }, showAllDone: false, now: now)
        let inTrip = TasksStore.group(tasks.filter { TasksStore.belongs($0, toChat: "c-trip") }, showAllDone: false, now: now)
        // A row that names no chat comes from an older server: the main chat's.
        #expect(Set(inMain.flatMap(\.tasks).map(\.id)) == ["a", "c"])
        #expect(inTrip.flatMap(\.tasks).map(\.id) == ["b"])
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

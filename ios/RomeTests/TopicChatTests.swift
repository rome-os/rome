import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct TopicChatTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// Waits up to ten seconds for `condition`.
    private func until(_ condition: () -> Bool) async {
        for _ in 0..<1000 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
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

    /// The drawer's fold lasts across launches, per instance, and goes with the account.
    @Test func theFoldIsKeptPerInstance() {
        let defaults = UserDefaults(suiteName: "topics-fold-\(UUID())")!
        let me = TopicChatsFold(host: "me.romeos.cc", defaults: defaults)
        let store = TopicChatsStore(backend: FakeBackend(), fold: me)
        #expect(!store.folded)
        store.setFolded(true)
        #expect(TopicChatsStore(backend: FakeBackend(), fold: me).folded)
        #expect(!TopicChatsStore(backend: FakeBackend(), fold: TopicChatsFold(host: "team.romeos.cc", defaults: defaults)).folded)
        store.setFolded(false)
        #expect(!me.load())
        me.save(true)
        TopicChatsFold.removeAll(defaults: defaults)
        #expect(!me.load())
    }

    /// Folded, the header counts every unread reply, and the open chat keeps its row.
    @Test func aFoldedListKeepsUnreadAndTheOpenChat() async {
        let backend = FakeBackend()
        backend.topicChats = [
            ConciergeChat(id: "topic-1", name: "Kyoto", main: false, unread: 2),
            ConciergeChat(id: "topic-2", name: "Meals", main: false, unread: 0),
            ConciergeChat(id: "topic-3", name: "Books", main: false, unread: 1),
        ]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.unreadCount == 3)
        store.markRead("topic-1")
        #expect(store.unreadCount == 1)
        #expect(TopicChatsStore.foldedRows(store.chats, openId: "topic-2").map(\.id) == ["topic-2"])
        #expect(TopicChatsStore.foldedRows(store.chats, openId: nil).isEmpty)
    }

    /// As on the web, a named chat's composer says which chat a message goes to.
    @Test func theComposerNamesTheChatOnceItHasOne() {
        #expect(TopicChatsStore.composerPlaceholder(nil) == "Message")
        let unnamed = ConciergeChat(id: "topic-1", name: "  ", main: false, unread: 0)
        #expect(TopicChatsStore.composerPlaceholder(unnamed) == "Message")
        let named = ConciergeChat(id: "topic-1", name: " Kyoto trip ", main: false, unread: 0)
        #expect(TopicChatsStore.composerPlaceholder(named) == "Message in Kyoto trip")
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

    /// As on the web: an archive moves the chat's follows and open tasks
    /// unless the guardian chose to stop them.
    @Test func archiveStopsTheChatsWorkOnlyWhenAsked() async {
        let backend = FakeBackend()
        backend.topicChats = [
            ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 0),
            ConciergeChat(id: "topic-2", name: "Home", main: false, unread: 0),
        ]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(await workspace.archiveTopic("topic-1"))
        #expect(await workspace.archiveTopic("topic-2", stoppingWork: true))
        #expect(backend.calls == ["archive topic-1", "archive topic-2 stopping work"])
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

    /// As on the web: latest activity first, and a chat the chat list has no
    /// time for yet counts as newest.
    @Test func theDrawerListsTopicChatsLatestActivityFirst() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b", "c", "d"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T08:00:00.000Z"),
            ChatSession(id: "c", name: "c", activityAt: "2026-11-15T09:00:00.000Z"),
        ]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.chats.map(\.id) == ["d", "a", "c", "b"])
    }

    @Test func aTurnStartingInAChatMovesItUp() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T08:00:00.000Z"),
        ]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.chats.map(\.id) == ["a", "b"])
        // The guardian's message moved the chat's time on the server.
        backend.sessionRows[1].activityAt = "2026-11-15T11:00:00.000Z"
        backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "b", running: true))
        await settle()
        #expect(store.chats.map(\.id) == ["b", "a"])
    }

    /// A reconnect replays each chat's running state: nothing happened, so
    /// nothing moves.
    @Test func aReplayedStatusLeavesTheOrder() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b", "c"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T09:00:00.000Z"),
            ChatSession(id: "c", name: "c", activityAt: "2026-11-15T08:00:00.000Z"),
        ]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.chats.map(\.id) == ["a", "b", "c"])
        backend.bus.emit(LiveTopic.chatStatus, .reconnected)
        for id in ["c", "b"] {
            backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: id, running: true))
        }
        #expect(store.chats.map(\.id) == ["a", "b", "c"])
        await settle()
        #expect(store.chats.map(\.id) == ["a", "b", "c"])
    }

    @Test func theDrawerPagesWithoutRevealingRowsBeforeTheOpenChat() {
        let chats = (0..<70).map { ConciergeChat(id: "c-\($0)", name: "Chat", main: false, unread: $0 == 65 ? 1 : 0) }
        let page = TopicChatsStore.page(chats, limit: 30, pinnedAt: [:], openId: "c-69")
        #expect(TopicChatsStore.pageSize == 30)
        #expect(page.count == 32)
        #expect(!page.contains { $0.id == "c-44" })
        #expect(page.suffix(2).map(\.id) == ["c-65", "c-69"])
        #expect(TopicChatsStore.page(chats, limit: 90, pinnedAt: [:], openId: nil).count == 70)
    }

    @Test func olderTopicsStartCollapsedAndRememberBothStatesPerInstance() {
        let defaults = UserDefaults(suiteName: "older-topics-\(UUID())")!
        let fold = TopicChatsFold(host: "me.romeos.cc", defaults: defaults)
        let store = TopicChatsStore(backend: FakeBackend(), fold: fold)
        #expect(!store.olderExpanded)
        store.setOlderExpanded(true)
        #expect(TopicChatsStore(backend: FakeBackend(), fold: fold).olderExpanded)
        #expect(!TopicChatsStore(backend: FakeBackend(), fold: TopicChatsFold(host: "other", defaults: defaults)).olderExpanded)
        store.setOlderExpanded(false)
        #expect(!fold.loadOlderExpanded())
        fold.saveOlderExpanded(true)
        TopicChatsFold.removeAll(defaults: defaults)
        #expect(!fold.loadOlderExpanded())
    }

    @Test func olderTopicsUseSevenDaysNotCalendarWeeks() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        let cutoff = now.addingTimeInterval(-7 * 86400)
        let chats = ["new", "boundary", "old", "unknown"].map { ConciergeChat(id: $0, name: $0, main: false) }
        let groups = TopicChatsStore.groups(chats, lastActive: ["new": cutoff.addingTimeInterval(0.001), "boundary": cutoff, "old": cutoff.addingTimeInterval(-1)], pinnedAt: [:], now: now)
        #expect(groups.current.map(\.id) == ["new", "unknown"])
        #expect(groups.older.map(\.id) == ["boundary", "old"])
    }

    /// Pins and unread chats stay outside Older; an open older chat stays
    /// in it, with only its selected state.
    @Test func pinsAndUnreadStayOutsideAndTheOpenOldTopicStaysInOlder() {
        let now = Date.now
        let chats = ["pin", "unread", "open", "old"].map { ConciergeChat(id: $0, name: $0, main: false, unread: $0 == "unread" ? 2 : 0) }
        let times = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, now.addingTimeInterval(-30 * 86400)) })
        let groups = TopicChatsStore.groups(chats, lastActive: times, pinnedAt: ["pin": now], now: now)
        #expect(groups.current.map(\.id) == ["pin", "unread"])
        #expect(groups.older.map(\.id) == ["open", "old"])
    }

    @Test func olderCountsComeBeforePaging() {
        let now = Date.now
        let chats = (0..<130).map { ConciergeChat(id: "old-\($0)", name: "Old", main: false) }
        let times = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, now.addingTimeInterval(-8 * 86400)) })
        let groups = TopicChatsStore.groups(chats, lastActive: times, pinnedAt: [:], now: now)
        #expect(groups.current.isEmpty)
        #expect(groups.older.count == 130)
        #expect(groups.older.prefix(TopicChatsStore.pageSize).count == 30)
        // An open chat past Older's page shows, and the page grows to it.
        #expect(TopicChatsStore.shownCount(130, limit: TopicChatsStore.pageSize, openIndex: 99) == 100)
        #expect(TopicChatsStore.shownCount(130, limit: TopicChatsStore.pageSize, openIndex: nil) == 30)
    }

    /// An unread chat quiet for a week opens outside Older, and reading it
    /// leaves it there while it is open: the list keeps its shape. Once
    /// another chat opens, it goes to Older. An older chat opened stays in Older.
    @Test func theOpenChatKeepsTheGroupItOpenedIn() async {
        let backend = FakeBackend()
        let now = Date.now
        backend.topicChats = [
            ConciergeChat(id: "quiet", name: "Quiet", main: false, unread: 1),
            ConciergeChat(id: "old", name: "Old", main: false, unread: 0),
        ]
        backend.sessionRows = ["quiet", "old"].map { ChatSession(id: $0, name: $0, activityAt: RomeDate.string(now.addingTimeInterval(-9 * 86400))) }
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        func groups() -> (current: [String], older: [String]) {
            let groups = TopicChatsStore.groups(store.chats, lastActive: store.lastActive, pinnedAt: store.pinnedAt, held: store.heldCurrent, now: now)
            return (groups.current.map(\.id), groups.older.map(\.id))
        }
        #expect(groups().current == ["quiet"])
        store.noteOpen("quiet", now: now)
        store.markRead("quiet")
        #expect(groups().current == ["quiet"])
        // The same chat noted again, as the list changes, keeps its place.
        store.noteOpen("quiet", now: now)
        #expect(groups().current == ["quiet"])
        store.noteOpen("old", now: now)
        #expect(store.heldCurrent == nil)
        #expect(groups().current.isEmpty)
        #expect(groups().older.sorted() == ["old", "quiet"])
        store.noteOpen(nil)
        #expect(store.heldCurrent == nil)
    }

    /// A chat not in the list yet, such as an archived one, holds nothing,
    /// and is decided once it is listed.
    @Test func anOpenChatIsDecidedOnceListed() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "new", name: "New", main: false, unread: 0)]
        let store = TopicChatsStore(backend: backend)
        store.noteOpen("new")
        #expect(store.heldCurrent == nil)
        store.start()
        await settle()
        store.noteOpen("new")
        #expect(store.heldCurrent == "new")
    }

    @Test func archivedStartsCollapsedAndRemembersItsOwnStatePerInstance() {
        let defaults = UserDefaults(suiteName: "archived-topics-\(UUID())")!
        let fold = TopicChatsFold(host: "me.romeos.cc", defaults: defaults)
        let store = TopicChatsStore(backend: FakeBackend(), fold: fold)
        #expect(!store.archivedExpanded)
        store.setArchivedExpanded(true)
        #expect(!store.olderExpanded)
        #expect(TopicChatsStore(backend: FakeBackend(), fold: fold).archivedExpanded)
        #expect(!TopicChatsStore(backend: FakeBackend(), fold: TopicChatsFold(host: "other", defaults: defaults)).archivedExpanded)
        TopicChatsFold.removeAll(defaults: defaults)
        #expect(!fold.loadArchivedExpanded())
    }

    @Test func onlyAFreshTopicMessageMovesItOutOfOlder() async {
        let backend = FakeBackend()
        let now = Date.now
        backend.topicChats = [ConciergeChat(id: "old", name: "Old", main: false, unread: 0)]
        backend.sessionRows = [ChatSession(id: "old", name: "Old", activityAt: RomeDate.string(now.addingTimeInterval(-8 * 86400)))]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        func groups() -> (current: [ConciergeChat], older: [ConciergeChat]) {
            TopicChatsStore.groups(store.chats, lastActive: store.lastActive, pinnedAt: store.pinnedAt, now: now)
        }
        #expect(groups().older.count == 1)
        backend.sessionRows.append(ChatSession(id: "task", name: "Background task", activityAt: RomeDate.string(now)))
        backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "task", running: true))
        store.setActivity(.working, for: "old")
        await settle()
        #expect(groups().older.count == 1)
        backend.sessionRows[0].activityAt = RomeDate.string(now)
        backend.bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "old", running: false))
        await settle()
        #expect(groups().current.map(\.id) == ["old"])
        #expect(groups().older.isEmpty)
    }

    /// As on the web: the pinned chats first, the latest pinned on top, then
    /// the rest by activity, whatever their activity.
    @Test func theDrawerListsPinnedChatsFirstLatestPinOnTop() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b", "c", "d"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T08:00:00.000Z", pinnedAt: "2026-11-16T08:00:00.000Z"),
            ChatSession(id: "c", name: "c", activityAt: "2026-11-15T09:00:00.000Z"),
            ChatSession(id: "d", name: "d", activityAt: "2026-11-15T07:00:00.000Z", pinnedAt: "2026-11-16T09:00:00.000Z"),
        ]
        let store = TopicChatsStore(backend: backend)
        store.start()
        await settle()
        #expect(store.chats.map(\.id) == ["d", "b", "a", "c"])
        #expect(store.isPinned("d") && store.isPinned("b") && !store.isPinned("a"))
        // A turn in an unpinned chat moves it up among the unpinned only.
        backend.sessionRows[2].activityAt = "2026-11-17T09:00:00.000Z"
        store.refresh()
        await settle()
        #expect(store.chats.map(\.id) == ["d", "b", "c", "a"])
    }

    @Test func pinningMovesTheChatToTheTopAndUnpinningBack() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b", "c"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T09:00:00.000Z"),
            ChatSession(id: "c", name: "c", activityAt: "2026-11-15T08:00:00.000Z"),
        ]
        let workspace = workspace(backend)
        workspace.topics.start()
        // Waits on the list, not a fixed time: a loaded CI clone is slow.
        await until { workspace.topics.chats.count == 3 }
        #expect(await workspace.pinTopic("c", pinned: true))
        // At once, before the refetch.
        #expect(workspace.topics.chats.map(\.id) == ["c", "a", "b"])
        await settle()
        #expect(workspace.topics.chats.map(\.id) == ["c", "a", "b"])
        #expect(await workspace.pinTopic("b", pinned: true))
        #expect(workspace.topics.chats.map(\.id) == ["b", "c", "a"])
        #expect(await workspace.pinTopic("c", pinned: false))
        await until { workspace.topics.chats.map(\.id) == ["b", "a", "c"] }
        #expect(workspace.topics.chats.map(\.id) == ["b", "a", "c"])
        #expect(backend.calls == ["pin c", "pin b", "unpin c"])
    }

    @Test func aPinTheServerRefusesChangesNothing() async {
        let backend = FakeBackend()
        backend.topicChats = ["a", "b"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        backend.sessionRows = [
            ChatSession(id: "a", name: "a", activityAt: "2026-11-15T10:00:00.000Z"),
            ChatSession(id: "b", name: "b", activityAt: "2026-11-15T09:00:00.000Z"),
        ]
        backend.pinFails = true
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(await !workspace.pinTopic("b", pinned: true))
        #expect(workspace.topics.chats.map(\.id) == ["a", "b"])
        #expect(!workspace.topics.isPinned("b"))
    }

    @Test func theOrderWithoutTimesIsNewestStartedFirst() {
        let chats = ["a", "b", "c"].map { ConciergeChat(id: $0, name: $0, main: false, unread: 0) }
        #expect(TopicChatsStore.ordered(chats, lastActive: [:]).map(\.id) == ["c", "b", "a"])
        let early = Date(timeIntervalSince1970: 0)
        #expect(TopicChatsStore.ordered(chats, lastActive: ["c": early]).map(\.id) == ["b", "a", "c"])
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

    /// The archive alert lists what the delete alert lists, after its own lead.
    @Test func theArchiveAlertListsTheWorkAndAsks() {
        let work = ConciergeChatWork(
            follows: [.init(source: "github", label: "GitHub", target: "rome-os/rome")],
            openTasks: (1...6).map { .init(id: "t\($0)", title: "Task \($0)") }
        )
        let prompt = TopicArchivePrompt(id: "topic-1", name: "Trip", work: work)
        #expect(prompt.title == "Archive “Trip”?")
        #expect(prompt.message == """
        This chat will be archived. It has:
        • Following GitHub · rome-os/rome
        • Open task: Task 1
        • Open task: Task 2
        • Open task: Task 3
        • Open task: Task 4
        and 2 more

        What happens to them?
        """)
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

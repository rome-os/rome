import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct ArchivedTopicsTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func workspace(_ backend: FakeBackend) -> Workspace {
        Workspace(backend: backend, instanceName: "Test", host: "test", accountLabel: "test", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-tests-\(UUID().uuidString)/Drafts"), instance: "test"))
    }

    private func archived(_ id: String, _ name: String, daysAgo: Double? = nil, agent: String? = ChatSession.conciergeAgent, trigger: String? = nil) -> ChatSession {
        ChatSession(
            id: id, name: name, agentName: agent, triggerKind: trigger,
            archivedAt: RomeDate.string(.now),
            activityAt: daysAgo.map { RomeDate.string(.now.addingTimeInterval(-$0 * 86400)) }
        )
    }

    /// As the web's chat list tells them: only the Concierge's topic chats,
    /// never a task chat or an ordinary chat, latest activity first.
    @Test func listsOnlyArchivedTopicChatsLatestFirst() async {
        let backend = FakeBackend()
        backend.archivedRows = [
            archived("old", "Tax", daysAgo: 90),
            archived("task", "Book hotel", daysAgo: 1, trigger: ChatSession.taskChatTrigger),
            archived("plain", "Notes", daysAgo: 1, agent: nil),
            archived("new", "Car", daysAgo: 2),
            archived("untimed", "Holiday"),
        ]
        let store = ArchivedTopicsStore(backend: backend)
        #expect(!store.loaded)
        store.refresh()
        await settle()
        #expect(store.loaded)
        #expect(store.chats.map(\.id) == ["new", "old", "untimed"])
        #expect(store.chat("new")?.name == "Car")
    }

    @Test func parsesTheArchivedList() throws {
        let json = #"[{"id":"t1","name":"Car","agentName":"core:concierge","triggerKind":null,"archivedAt":"2026-11-01T10:00:00.000Z","activityAt":"2026-11-01T09:00:00.000Z"},{"id":"t2","name":"Hotel","agentName":"core:concierge","triggerKind":"concierge","archivedAt":"2026-11-01T10:00:00.000Z"}]"#
        let sessions = try JSONDecoder().decode([ChatSession].self, from: Data(json.utf8))
        #expect(sessions.map(\.isArchivedTopicChat) == [true, false])
    }

    /// The row under the topic chats: hidden with none archived, folded, or
    /// while more topic chats are still to page in.
    @Test func theEntryShowsOnlyWithArchivedChatsAtTheEnd() {
        #expect(ArchivedTopicsStore.showsEntry(archived: 3, folded: false, shownTopics: 5, topics: 5))
        #expect(ArchivedTopicsStore.showsEntry(archived: 1, folded: false, shownTopics: 0, topics: 0))
        #expect(!ArchivedTopicsStore.showsEntry(archived: 0, folded: false, shownTopics: 5, topics: 5))
        #expect(!ArchivedTopicsStore.showsEntry(archived: 3, folded: true, shownTopics: 0, topics: 5))
        #expect(!ArchivedTopicsStore.showsEntry(archived: 3, folded: false, shownTopics: 30, topics: 45))
    }

    /// The sheet pages as the drawer does: the first page, then a page more each time.
    @Test func theSheetShowsAPageAtATime() async {
        let backend = FakeBackend()
        backend.archivedRows = (1...45).map { archived("t\($0)", "Chat \($0)", daysAgo: Double($0)) }
        let store = ArchivedTopicsStore(backend: backend)
        store.refresh()
        await settle()
        #expect(store.count == 45)
        let first = TopicChatsStore.shownCount(store.count, limit: TopicChatsStore.pageSize, openIndex: nil)
        #expect(first == 30)
        #expect(Array(store.chats.prefix(first)).last?.id == "t30")
        #expect(TopicChatsStore.shownCount(store.count, limit: first + TopicChatsStore.pageSize, openIndex: nil) == 45)
    }

    @Test func archivingAChatListsItThere() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "topic-1", name: "Trip", main: false, unread: 0)]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(workspace.archivedTopics.count == 0)
        #expect(await workspace.archiveTopic("topic-1"))
        #expect(workspace.archivedTopics.chats.map(\.id) == ["topic-1"])
        #expect(workspace.isArchivedTopic("topic-1"))
        // Named as it was in the drawer, for the open chat's header.
        #expect(workspace.topicChat("topic-1")?.name == "Trip")
        await settle()
        #expect(workspace.archivedTopics.chats.map(\.id) == ["topic-1"])
    }

    /// A restore leaves the sheet, lists the chat in the drawer at once, and
    /// ends the chat's read-only state.
    @Test func restoreMovesTheChatBackToTheDrawer() async {
        let backend = FakeBackend()
        backend.archivedRows = [archived("topic-1", "Car", daysAgo: 1), archived("topic-2", "Tax", daysAgo: 2)]
        let workspace = workspace(backend)
        workspace.archivedTopics.refresh()
        await settle()
        #expect(workspace.isArchivedTopic("topic-1"))
        #expect(await workspace.restoreTopic("topic-1"))
        #expect(await workspace.restoreTopic("topic-2", movingFollowsBack: true))
        #expect(backend.calls == ["restore topic-1", "restore topic-2 moving follows back"])
        #expect(workspace.archivedTopics.count == 0)
        #expect(!workspace.isArchivedTopic("topic-1"))
        #expect(Set(workspace.topics.chats.map(\.id)) == ["topic-1", "topic-2"])
        #expect(workspace.topicChat("topic-1")?.name == "Car")
    }

    @Test func aRestoreTheServerRefusesChangesNothing() async {
        let backend = FakeBackend()
        backend.archivedRows = [archived("topic-1", "Car", daysAgo: 1)]
        backend.unarchiveFails = true
        let workspace = workspace(backend)
        workspace.archivedTopics.refresh()
        await settle()
        #expect(await !workspace.restoreTopic("topic-1"))
        #expect(workspace.isArchivedTopic("topic-1"))
        #expect(workspace.topics.chats.isEmpty)
    }

    /// A list asked for before the chat was unarchived here, and answered
    /// after, does not bring it back.
    @Test func aStaleListKeepsARestoredChatOut() async {
        let backend = FakeBackend()
        backend.archivedRows = [archived("topic-1", "Car", daysAgo: 1)]
        let store = ArchivedTopicsStore(backend: backend)
        // The read is under way, still holding the chat, when it is unarchived.
        backend.duringArchivedFetch = { [weak store] in
            store?.remove("topic-1")
            backend.duringArchivedFetch = nil
        }
        store.refresh()
        await settle()
        #expect(store.loaded)
        #expect(store.count == 0)
    }

    /// Unarchived here, then archived again on the web: the next read shows
    /// it, and its search hit opens it read only again.
    @Test func aChatArchivedAgainElsewhereShowsAgain() async {
        let backend = FakeBackend()
        let row = archived("topic-1", "Car", daysAgo: 1)
        backend.archivedRows = [row]
        let workspace = workspace(backend)
        workspace.archivedTopics.refresh()
        await settle()
        #expect(await workspace.restoreTopic("topic-1"))
        #expect(!workspace.isArchivedTopic("topic-1"))
        // Archived again on the web.
        try? await Task.sleep(for: .milliseconds(5))
        backend.archivedRows = [row]
        workspace.archivedTopics.refresh()
        await settle()
        #expect(workspace.archivedTopics.chats.map(\.id) == ["topic-1"])
        #expect(workspace.isArchivedTopic("topic-1"))
        #expect(workspace.archivedTopics.note(row))
    }

    @Test func deleteTakesTheChatOutOfTheSheet() async {
        let backend = FakeBackend()
        backend.archivedRows = [archived("topic-1", "Car", daysAgo: 1), archived("topic-2", "Tax", daysAgo: 2)]
        let workspace = workspace(backend)
        workspace.archivedTopics.refresh()
        await settle()
        #expect(await workspace.deleteTopic("topic-1"))
        #expect(backend.calls == ["delete topic-1"])
        #expect(workspace.archivedTopics.chats.map(\.id) == ["topic-2"])
        workspace.archivedTopics.refresh()
        await settle()
        #expect(workspace.archivedTopics.chats.map(\.id) == ["topic-2"])
    }

    /// A hit that says the chat is archived wins over the drawer's older
    /// list: it opens read only and leaves the drawer.
    @Test func anArchivedHitOfAChatTheDrawerStillListsOpensReadOnly() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "topic-1", name: "Car", main: false, unread: 0)]
        let workspace = workspace(backend)
        workspace.topics.start()
        await settle()
        #expect(workspace.topics.chat("topic-1") != nil)
        // Archived on the web since the drawer last read its list.
        #expect(workspace.openSearchHit(archived("topic-1", "Car", daysAgo: 1)) == .topic("topic-1"))
        #expect(workspace.isArchivedTopic("topic-1"))
        #expect(workspace.topics.chat("topic-1") == nil)
        // An active topic chat and a task chat open as before.
        backend.topicChats.append(ConciergeChat(id: "topic-2", name: "Trip", main: false, unread: 0))
        workspace.topics.refresh()
        await settle()
        #expect(workspace.openSearchHit(ChatSession(id: "topic-2", name: "Trip", agentName: ChatSession.conciergeAgent)) == .topic("topic-2"))
        #expect(!workspace.isArchivedTopic("topic-2"))
        #expect(workspace.openSearchHit(ChatSession(id: "chat-9", name: "Hotel", triggerKind: ChatSession.taskChatTrigger)) == .taskChat("chat-9", title: "Hotel"))
    }

    /// The open chat deleted from the Archived sheet, or archived or deleted
    /// from the drawer, leaves the screen for the main Chat; another stays.
    @Test func retiringTheOpenChatShowsTheMainChat() {
        #expect(MainShell.section(after: .topic("topic-1"), retired: "topic-1") == .chat)
        #expect(MainShell.section(after: .topic("topic-2"), retired: "topic-1") == nil)
        #expect(MainShell.section(after: .chat, retired: "topic-1") == nil)
    }

    /// An archived chat found by search opens read only, with an Archived label.
    @Test func aSearchHitOfAnArchivedChatOpensReadOnly() async {
        let backend = FakeBackend()
        let workspace = workspace(backend)
        let hit = archived("topic-9", "Car", daysAgo: 3)
        #expect(!workspace.isArchivedTopic("topic-9"))
        workspace.archivedTopics.note(hit)
        #expect(workspace.isArchivedTopic("topic-9"))
        #expect(workspace.topicChat("topic-9")?.name == "Car")
        // A task chat or an active chat is never read only.
        workspace.archivedTopics.note(archived("task", "Hotel", trigger: ChatSession.taskChatTrigger))
        workspace.archivedTopics.note(ChatSession(id: "topic-3", name: "Trip", agentName: ChatSession.conciergeAgent))
        #expect(!workspace.isArchivedTopic("task"))
        #expect(!workspace.isArchivedTopic("topic-3"))
    }

    @Test func parsesTheFollowsAnArchiveMoved() throws {
        let json = #"{"follows":[],"openTasks":[],"movedFollows":[{"source":"gmail","label":"Gmail","target":"dealer@example.com"}]}"#
        let work = try JSONDecoder().decode(ConciergeChatWork.self, from: Data(json.utf8))
        #expect(work.movedFollows == [.init(source: "gmail", label: "Gmail", target: "dealer@example.com")])
        #expect(work.isEmpty)
        // An older instance sends none: nothing to ask, the restore goes ahead.
        let older = try JSONDecoder().decode(ConciergeChatWork.self, from: Data(#"{"follows":[],"openTasks":[]}"#.utf8))
        #expect(older.movedFollows.isEmpty)
    }

    /// As on the web: an archived topic chat's "…" offers only Unarchive and
    /// Delete for the chat, no Rename or Pin; the Tasks button and the
    /// Agent's status stay as in any topic chat.
    @Test func anArchivedChatsMenuOffersUnarchiveAndDelete() {
        #expect(TopicHeaderMenu(blank: false, archived: true).items == [.unarchive, .delete])
        #expect(TopicHeaderMenu(blank: false, archived: false).items == [.rename, .pin, .archive, .delete])
        #expect(TopicHeaderMenu(blank: true, archived: false).items.isEmpty)
    }

    @Test func theRestoreAlertListsTheMovedFollows() {
        let prompt = TopicRestorePrompt(id: "topic-1", name: "Car", moved: [.init(source: "gmail", label: "Gmail", target: "dealer@example.com")])
        #expect(prompt.title == "Unarchive “Car”?")
        #expect(prompt.message == """
        When this chat was archived, these follows moved to Chat:
        • Following Gmail · dealer@example.com

        What happens to them?
        """)
    }

    // MARK: - The sheet's groups and its "Last active" line

    /// Gregorian, weeks from Sunday, in UTC, so the groups never move with
    /// the machine's settings.
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.firstWeekday = 1
        return calendar
    }

    private func day(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    private func chat(_ id: String) -> ConciergeChat {
        ConciergeChat(id: id, name: id, main: false)
    }

    /// This week, earlier this month, then a group per month, newest first;
    /// chats with no time last. A time ahead of now counts as this week.
    @Test func groupsByWeekThenMonth() {
        let now = day(2026, 11, 21) // a Saturday; the week began on Sunday 15th
        let times: [String: Date] = [
            "today": day(2026, 11, 21, hour: 9),
            "ahead": day(2026, 11, 22),
            "sunday": day(2026, 11, 15, hour: 1),
            "saturday": day(2026, 11, 14),
            "second": day(2026, 11, 2),
            "oct30": day(2026, 10, 30),
            "oct2": day(2026, 10, 2),
            "sep": day(2026, 9, 5),
            "lastYear": day(2025, 11, 30),
        ]
        let chats = ["ahead", "today", "sunday", "saturday", "second", "oct30", "oct2", "sep", "lastYear", "untimed"].map(chat)
        let groups = ArchivedTopicsStore.groups(chats, lastActive: times, now: now, calendar: calendar)
        #expect(groups.map(\.period) == [.thisWeek, .earlierThisMonth, .month(day(2026, 10, 1, hour: 0)), .month(day(2026, 9, 1, hour: 0)), .month(day(2025, 11, 1, hour: 0)), .undated])
        #expect(groups.map { $0.chats.map(\.id) } == [["ahead", "today", "sunday"], ["saturday", "second"], ["oct30", "oct2"], ["sep"], ["lastYear"], ["untimed"]])
    }

    /// A week that began last month keeps its first days in This week.
    @Test func thisWeekReachesIntoLastMonth() {
        let now = day(2026, 12, 2) // a Wednesday; the week began on Sunday 29th
        let times = ["mon": day(2026, 11, 30), "sat": day(2026, 11, 28)]
        let groups = ArchivedTopicsStore.groups(["mon", "sat"].map(chat), lastActive: times, now: now, calendar: calendar)
        #expect(groups.map(\.period) == [.thisWeek, .month(day(2026, 11, 1, hour: 0))])
    }

    @Test func noChatsNoGroups() {
        #expect(ArchivedTopicsStore.groups([], lastActive: [:]).isEmpty)
    }

    /// Today a time, this year a day, before that a day with its year.
    @Test func theLastActiveDateReadsAsElsewhere() {
        let now = Date()
        let earlier = now.addingTimeInterval(-60)
        if Calendar.current.isDate(earlier, inSameDayAs: now) {
            #expect(RelativeTime.moment(earlier, now: now) == RelativeTime.clock(earlier))
        }
        let en = Locale(identifier: "en_US")
        let zh = Locale(identifier: "zh-Hans_CN")
        let nov12 = day(2026, 11, 12)
        let later = day(2026, 11, 21)
        #expect(RelativeTime.moment(nov12, now: later, calendar: calendar, locale: en) == "Nov 12")
        #expect(RelativeTime.moment(day(2025, 11, 12), now: later, calendar: calendar, locale: en) == "Nov 12, 2025")
        #expect(RelativeTime.moment(nov12, now: later, calendar: calendar, locale: zh) == "11月12日")
        #expect(RelativeTime.moment(day(2025, 11, 12), now: later, calendar: calendar, locale: zh) == "2025年11月12日")
    }

    /// A month's label carries its year only when it is not this year's.
    @Test func monthLabelsCarryTheYearOnlyBeforeThisYear() {
        let now = day(2026, 11, 21)
        let en = Locale(identifier: "en_US")
        let zh = Locale(identifier: "zh-Hans_CN")
        #expect(RelativeTime.month(day(2026, 10, 1), now: now, calendar: calendar, locale: en) == "October")
        #expect(RelativeTime.month(day(2025, 10, 1), now: now, calendar: calendar, locale: en) == "October 2025")
        #expect(RelativeTime.month(day(2025, 10, 1), now: now, calendar: calendar, locale: zh) == "2025年10月")
    }

    /// The store keeps each chat's last activity from the list, and a chat
    /// archived here keeps the time the drawer knew until the list is read.
    @Test func keepsEachChatsLastActivity() async {
        let backend = FakeBackend()
        backend.archivedRows = [archived("car", "Car", daysAgo: 2), archived("untimed", "Holiday")]
        let store = ArchivedTopicsStore(backend: backend)
        store.refresh()
        await settle()
        #expect(store.lastActive["car"] != nil)
        #expect(store.lastActive["untimed"] == nil)
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        backend.archivedRows.insert(archived("trip", "Trip"), at: 0)
        store.add(chat("trip"), lastActive: at)
        #expect(store.lastActive["trip"] == at)
    }
}

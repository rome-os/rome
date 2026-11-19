import Foundation
import Testing
@testable import Rome

private let listJSON = #"""
{"chatId":"concierge","groups":[
 {"key":"needs_you","items":[{"kind":"task","task":{"id":"t1","title":"Book a table","state":"needs_user","status":"needs_you","createdAt":1,"updatedAt":1,"waitingSince":1800000000000,"openWait":{"kind":"approval","id":"a1","since":1},"chat":{"id":"c1","name":"Book"}},"schedule":null,"check":null,"cardMessageId":"m9"}]},
 {"key":"later","items":[
  {"kind":"task","task":{"id":"t2","title":"Daily report","state":"next","status":"later","createdAt":1,"updatedAt":1},"schedule":{"at":"15:47","days":null},"check":{"id":"k1","at":1800061200000,"recurring":true},"cardMessageId":null},
  {"kind":"check","check":{"id":"k2","name":"Look at the flight","at":1800001200000,"waitingFor":null,"taskId":null}}
 ]},
 {"key":"on_its_own","items":[
  {"kind":"follow","source":"github","label":"GitHub","target":"rome-os/rome","state":"active","digestTimes":["09:00"]},
  {"kind":"routine","id":"r1","name":"Old summary","trigger":{"type":"manual"},"enabled":false,"nextRunAt":null,"lastRun":{"status":"error","firedAt":1}},
  {"kind":"portal","id":"x"}
 ]},
 {"key":"ended","items":[{"kind":"task","task":{"id":"t3","title":"Fix the bike","state":"done","status":"ended","endReason":"failed","createdAt":1,"updatedAt":1,"completedAt":1799992800000},"schedule":null,"check":null,"cardMessageId":null}]}
]}
"""#

/// The Agent page's Tasks tab (docs/domains/chats.md#task-list).
@MainActor
@Suite struct TaskListTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func decoded() throws -> TaskListResponse {
        try JSONDecoder().decode(TaskListResponse.self, from: Data(listJSON.utf8))
    }

    @Test func theListDecodesEveryKindAndDropsUnknownOnes() throws {
        let list = try decoded()
        #expect(list.groups.map(\.key) == [.needsYou, .later, .onItsOwn, .ended])
        #expect(list.groups[2].items.map(\.id) == ["follow:github:rome-os/rome", "routine:r1"])
        guard case .task(let waiting) = list.groups[0].items[0] else { Issue.record("no task"); return }
        #expect(waiting.cardMessageId == "m9" && waiting.task.chat?.id == "c1")
    }

    @Test func eachRowSaysItsStateThenItsTime() throws {
        let list = try decoded()
        guard case .task(let waiting) = list.groups[0].items[0],
              case .task(let daily) = list.groups[1].items[0],
              case .check(let check) = list.groups[1].items[1],
              case .follow(let follow) = list.groups[2].items[0],
              case .routine(let routine) = list.groups[2].items[1],
              case .task(let ended) = list.groups[3].items[0]
        else { Issue.record("shapes"); return }
        #expect(TaskListWords.task(waiting, now: now) == "Waiting for your approval · now")
        #expect(TaskListWords.task(daily, now: now).hasPrefix("Daily at "))
        #expect(TaskListWords.task(daily, now: now).hasSuffix(" · in 17 hr"))
        #expect(TaskListWords.check(check, now: now) == "Checks in 20 min")
        #expect(TaskListWords.follow(follow).hasPrefix("GitHub · Digest daily at "))
        #expect(TaskListWords.routine(routine, now: now) == "Only when run by hand · Paused · Last run failed")
        #expect(TaskListWords.task(ended, now: now) == "Failed · 2 hr ago")
        #expect(TaskListWords.task(waiting, now: now, stopping: true) == "Stopping…")
    }

    /// The groups keep their fixed order, Ended always last, whatever order
    /// they arrive in, with some missing or all there.
    @Test func groupsKeepTheirOrder() async throws {
        func group(_ key: TaskListGroup.Key) -> TaskListGroup { TaskListGroup(key: key, items: []) }
        let all: [TaskListGroup.Key] = [.needsYou, .active, .later, .onItsOwn, .ended]
        #expect(TaskListGroup.ordered([.ended, .later, .needsYou, .onItsOwn, .active].map(group)).map(\.key) == all)
        #expect(TaskListGroup.ordered([.ended, .active].map(group)).map(\.key) == [.active, .ended])
        #expect(TaskListGroup.ordered([.later, .ended, .needsYou].map(group)).map(\.key) == [.needsYou, .later, .ended])
        // The store keeps that order too.
        let backend = FakeBackend()
        var list = try decoded()
        list.groups.reverse()
        backend.taskLists["concierge"] = list
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        #expect(store.groups.map(\.key) == [.needsYou, .later, .onItsOwn, .ended])
    }

    /// Each row's menu is titled with when it was made; a row whose kind the
    /// instance gives no time has none, rather than a guessed one.
    @Test func eachRowSaysWhenItWasMade() throws {
        let list = try decoded()
        guard case .task(let task) = list.groups[0].items[0] else { Issue.record("no task"); return }
        #expect(list.groups[0].items[0].createdAt == Date(timeIntervalSince1970: 0.001) && task.task.createdAt == 1)
        #expect(list.groups[1].items[1].createdAt == nil)
        let made = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(TaskListWords.created(made, now: made) == "Created " + RelativeTime.separator(made, now: made))
        let check = try JSONDecoder().decode(TaskListItem.self, from: Data(#"{"kind":"check","check":{"id":"k","name":"n","at":null,"waitingFor":null,"createdAt":1800000000000}}"#.utf8))
        #expect(check.createdAt == made)
    }

    /// A task not started yet shows its age; a scheduled one, or one with a
    /// check, keeps its own line.
    @Test func aNotStartedTaskShowsItsAge() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let day = 86_400_000.0
        let nowMs = now.timeIntervalSince1970 * 1000
        #expect(TaskListWords.age(nowMs - 3 * day, now: now, calendar: calendar) == "3 days ago")
        #expect(TaskListWords.age(nowMs - day, now: now, calendar: calendar) == "yesterday")
        #expect(TaskListWords.age(nowMs, now: now, calendar: calendar) == "today")
        // As the web words it: 今天创建, 昨天创建, 3天前创建 once in the line.
        let zh = Locale(identifier: "zh-Hans_CN")
        #expect(TaskListWords.age(nowMs, now: now, calendar: calendar, locale: zh) == "今天")
        #expect(TaskListWords.age(nowMs - day, now: now, calendar: calendar, locale: zh) == "昨天")
        #expect(TaskListWords.age(nowMs - 3 * day, now: now, calendar: calendar, locale: zh) == "3天前")
        let fresh = ConciergeTask(id: "n", title: "N", state: .next, createdAt: nowMs - 3 * day, updatedAt: nowMs, status: "later")
        // A task is its task chat: there is no unstarted one, so a later task with no check says nothing.
        #expect(TaskListWords.task(.init(task: fresh, schedule: nil, check: nil, cardMessageId: nil), now: now) == "")
        // Active says how long ago it began.
        let active = ConciergeTask(id: "a", title: "A", state: .doing, createdAt: nowMs - day, updatedAt: nowMs - 25 * 60_000, status: "active")
        #expect(TaskListWords.task(.init(task: active, schedule: nil, check: nil, cardMessageId: nil), now: now).hasPrefix("Active · "))
        let scheduled = TaskListItem.Task(task: fresh, schedule: .init(at: "09:00", days: nil), check: nil, cardMessageId: nil)
        #expect(TaskListWords.task(scheduled, now: now).hasPrefix("Daily at "))
        let checked = TaskListItem.Task(task: fresh, schedule: nil, check: .init(id: "k", at: nowMs + 3_600_000, recurring: false), cardMessageId: nil)
        #expect(TaskListWords.task(checked, now: now) == "Checks in 1 hr")
    }

    @Test func schedulesReadAsTheWebSaysThem() {
        #expect(TaskListWords.schedule(.init(at: "09:00", days: ["mon", "wed"])).hasSuffix(" at " + TaskListWords.clock("09:00")))
        #expect(TaskListWords.trigger(.init(type: "schedule", localTime: "08:00", rrule: "FREQ=DAILY")).hasPrefix("Daily at "))
        #expect(TaskListWords.trigger(.init(type: "schedule", localTime: "08:00", rrule: "FREQ=MONTHLY")) == "On a schedule")
        #expect(TaskListWords.trigger(.init(type: "event-bus", eventName: "mail.received")) == "When mail.received arrives")
    }

    @Test func theLiveEventIsRead() {
        guard case .taskListChanged(let chat, let follows) = LiveEventsSocket.decode(name: "tasks_changed", data: .object(["chatId": .string("c")])) else {
            Issue.record("not read"); return
        }
        #expect(chat == "c" && !follows && LiveTopic.chatTasks("c") == "chat.tasks:c")
        guard case .taskListChanged(_, true) = LiveEventsSocket.decode(name: "tasks_changed", data: .object(["chatId": .string("c"), "follows": .bool(true)])) else {
            Issue.record("follows not read"); return
        }
    }

    /// The list says on or off; the connector list only adds unavailable,
    /// when the follow's service cannot deliver it now, as the web reads it.
    @Test func aFollowIsUnavailableWhenItsServiceCannotDeliver() throws {
        let json = #"""
        {"connectors":[
         {"service":"github","state":"working","capabilities":{"chat":{"state":"unlocked"},"act":{"state":"unlocked"},"watch":{"state":"unlocked","follows":[{"target":"rome-os/rome","state":"active"},{"target":"rome-os/old","state":"unavailable"}]}}},
         {"service":"gmail","state":"broken","capabilities":{"watch":{"state":"needs-auth","missingGrants":[]}}},
         {"service":"slack","state":"working","capabilities":{"watch":{"state":"unlocked","degradation":{"reason":"limit"}}}}
        ]}
        """#
        let body = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let list = (body["connectors"]?.array ?? []).compactMap(ConnectorState.init(json:))
        #expect(list.first?.watch == .init(state: "unlocked", degraded: false, follows: ["rome-os/rome": "active", "rome-os/old": "unavailable"]))
        func follow(_ source: String, _ target: String, _ state: String = "active") -> TaskListItem.Follow {
            .init(source: source, label: source, target: target, state: state, digestTimes: [])
        }
        #expect(ConnectorState.followState(follow("github", "rome-os/rome"), in: list) == "active")
        #expect(ConnectorState.followState(follow("github", "rome-os/old"), in: list) == "unavailable")
        #expect(ConnectorState.followState(follow("gmail", "me"), in: list) == "unavailable")
        #expect(ConnectorState.followState(follow("slack", "#news"), in: list) == "unavailable")
        // It never turns a follow on or off, and a list not read or not
        // naming the service leaves the row as the task list says.
        #expect(ConnectorState.followState(follow("gmail", "me", "off"), in: list) == "off")
        #expect(ConnectorState.followState(follow("github", "rome-os/rome"), in: nil) == "active")
        #expect(ConnectorState.followState(follow("linear", "team"), in: list) == "active")
    }

    /// The tab reads the connector list for its follows, and again when a
    /// follow changes; the list shows without waiting for it.
    @Test func theTabReadsTheConnectorsForItsFollows() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        backend.connectorReads = [[ConnectorState(service: "github", state: "broken", watch: .init(state: "needs-auth"))]]
        let store = TaskListStore(chatId: "concierge", backend: backend)
        store.open()
        for _ in 0..<50 where store.connectors == nil { try? await Task.sleep(for: .milliseconds(10)) }
        guard case .follow(let listed)? = store.groups.first(where: { $0.key == .onItsOwn })?.items.first else { Issue.record("no follow"); return }
        #expect(listed.state == "active" && store.shown(listed).state == "unavailable")
        #expect(backend.connectorReadCount == 1)
        // Another change, with no follow in it, reads the list alone.
        backend.bus.emit(LiveTopic.chatTasks("concierge"), .taskListChanged(chatId: "concierge"))
        for _ in 0..<50 where backend.taskListReads < 2 { try? await Task.sleep(for: .milliseconds(10)) }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(backend.connectorReadCount == 1)
        backend.bus.emit(LiveTopic.chatTasks("concierge"), .taskListChanged(chatId: "concierge", follows: true))
        for _ in 0..<50 where backend.connectorReadCount < 2 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.connectorReadCount == 2)
        store.stop()
    }

    /// A follow that changes while the connector list is being read is read
    /// again once that read is done: the older answer never counts as fresh.
    @Test func aFollowChangeDuringAConnectorReadReadsAgain() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        backend.connectorReads = [[ConnectorState(service: "github", state: "broken", watch: .init(state: "needs-auth"))],
                                  [ConnectorState(service: "github", state: "working", watch: .init(state: "unlocked"))]]
        backend.duringConnectorRead = {
            backend.bus.emit(LiveTopic.chatTasks("concierge"), .taskListChanged(chatId: "concierge", follows: true))
        }
        let store = TaskListStore(chatId: "concierge", backend: backend)
        store.open()
        for _ in 0..<100 where backend.connectorReadCount < 2 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.connectorReadCount == 2)
        for _ in 0..<50 where store.connectors?.first?.watch?.state != "unlocked" { try? await Task.sleep(for: .milliseconds(10)) }
        guard case .follow(let listed)? = store.groups.first(where: { $0.key == .onItsOwn })?.items.first else { Issue.record("no follow"); return }
        #expect(store.shown(listed).state == "active")
        store.stop()
    }

    /// A change on the chat's topic reads the list again.
    @Test func aChangeReadsTheListAgain() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        let store = TaskListStore(chatId: "concierge", backend: backend)
        store.open()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.groups.count == 4 && backend.taskListReads == 1)
        backend.bus.emit(LiveTopic.chatTasks("concierge"), .taskListChanged(chatId: "concierge"))
        for _ in 0..<50 where backend.taskListReads == 1 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.taskListReads == 2)
        store.stop()
    }

    /// Stop shows at once; a failure takes the row back and says so.
    @Test func aFailedStopTakesTheRowBack() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        backend.stopListedError = .network
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        store.stopTask("t1")
        #expect(store.stopping == ["t1"])
        for _ in 0..<50 where store.failure == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.stopping.isEmpty && store.failure == "Failed to stop the task" && backend.stoppedFromList == ["t1"])
    }

    /// A stop that went through keeps the row pending until it reads ended.
    @Test func aStopHoldsUntilTheTaskEnds() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        store.stopTask("t1")
        for _ in 0..<50 where backend.taskListReads < 2 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.stopping == ["t1"])
        var list = try decoded()
        if case .task(var item) = list.groups[0].items[0] {
            item.task.status = "ended"
            item.task.endReason = "stopped"
            list.groups = [TaskListGroup(key: .ended, items: [.task(item)])]
        }
        backend.taskLists["concierge"] = list
        await store.load()
        #expect(store.stopping.isEmpty)
    }
}


@Suite struct TaskLinkTests {
    @Test func readsAndBuildsTheLinkTheConciergeWrites() {
        #expect(TaskLink.chatId(ofHref: "#rome-task=abc-123") == "abc-123")
        #expect(TaskLink.chatId(ofHref: "#rome-task=a%2Fb%20c") == "a/b c")
        #expect(TaskLink.chatId(of: URL(string: "#rome-task=c1")!) == "c1")
        #expect(TaskLink.url(chatId: "a b").flatMap(TaskLink.chatId(of:)) == "a b")
        #expect(TaskLink.chatId(ofHref: nil) == nil)
        #expect(TaskLink.chatId(ofHref: "https://example.com/#rome-task=c1") == nil)
        #expect(TaskLink.chatId(ofHref: "#rome-task=") == nil)
        #expect(TaskLink.chatId(ofHref: "#rome-task=%E0%A4%A") == nil)
    }

    @Test func findsEveryTaskChatATextNames() {
        let text = "On it: [Flights](#rome-task=c1) and [Hotels](#rome-task=c2), not [a page](https://example.com)."
        #expect(TaskLink.ids(in: text) == ["c1", "c2"])
        #expect(TaskLink.ids(in: "no links") == [])
    }

    @Test func marksEachStatusWithItsOwnSymbol() {
        func symbol(_ status: String, _ reason: String? = nil) -> String {
            TaskLinkInfo(id: "c", name: "N", status: status, endReason: reason).symbol
        }
        #expect(symbol("needs_you") == "exclamationmark.circle")
        #expect(symbol("active") == "arrow.triangle.2.circlepath")
        #expect(symbol("later") == "clock")
        #expect(symbol("ended", "done") == "checkmark.circle")
        #expect(symbol("ended", "failed") == "xmark.circle")
        #expect(symbol("ended", "stopped") == "stop.circle")
        #expect(symbol("ended", "no_response") == "circle")
        // A status this build does not know reads as active.
        #expect(symbol("sleeping") == "arrow.triangle.2.circlepath")
    }

    @Test func coloursEachStatusAsTheWebDoes() {
        func tone(_ status: String, _ reason: String? = nil) -> TaskMarkTone {
            TaskLinkInfo(id: "c", name: "N", status: status, endReason: reason).tone
        }
        #expect(tone("active") == .running)
        #expect(tone("needs_you") == .needsYou)
        #expect(tone("ended", "done") == .done)
        #expect(tone("ended", "failed") == .failed)
        #expect(tone("ended", "stopped") == .quiet)
        #expect(tone("ended", "no_response") == .quiet)
        #expect(tone("later") == .quiet)
        // Read as leniently as the symbol: an unknown status runs, an ended task with no reason is done.
        #expect(tone("sleeping") == .running)
        #expect(tone("ended") == .done)
    }

    @Test func turnsTheRunningRingOnceAPeriod() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        #expect(TaskMarkRing.frame(at: start) == 0)
        #expect(TaskMarkRing.frame(at: start.addingTimeInterval(TaskMarkRing.frameInterval * 1.5)) == 1)
        #expect(TaskMarkRing.frame(at: start.addingTimeInterval(TaskMarkRing.period)) == 0)
    }

    @MainActor
    @Test func aStoppedWorkspaceStopsListeningForTaskLinks() async {
        let backend = FakeBackend()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-task-links-stop-\(UUID().uuidString)/Drafts"), instance: "t"))
        let links = workspace.taskLinks(forChat: "topic-1")
        links?.register(["c1"])
        #expect(backend.bus.isListening(to: LiveTopic.chatTasks("topic-1")))
        workspace.stop()
        #expect(!backend.bus.isListening(to: LiveTopic.chatTasks("topic-1")))
    }

    @Test func readsTheLinksResponseLeniently() throws {
        let json = #"{"tasks":[{"id":"c1","name":"Flights","status":"needs_you","endReason":null},{"id":"c2","name":"Hotels","status":"ended","endReason":"stopped"}]}"#
        let response = try JSONDecoder().decode(TaskLinksResponse.self, from: Data(json.utf8))
        #expect(response.tasks.map(\.id) == ["c1", "c2"])
        #expect(response.tasks[1].endReason == "stopped")
        // An older server has no such route; a body with no tasks reads as none.
        #expect(try JSONDecoder().decode(TaskLinksResponse.self, from: Data("{}".utf8)).tasks.isEmpty)
    }

    @Test func readsAnOlderServersTaskListWithRowsThisBuildNoLongerDraws() throws {
        // A row from before: a title, a summary, no task chat, a card message.
        let json = #"{"chatId":"c","groups":[{"key":"later","items":[{"kind":"task","task":{"id":"t","title":"Old row","state":"next","status":"later","summary":"x","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"createdAt":1,"updatedAt":1},"schedule":null,"check":null,"cardMessageId":null}]}]}"#
        let list = try JSONDecoder().decode(TaskListResponse.self, from: Data(json.utf8))
        #expect(list.groups.first?.items.count == 1)
    }
}

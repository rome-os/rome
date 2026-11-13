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

    @Test func schedulesReadAsTheWebSaysThem() {
        #expect(TaskListWords.schedule(.init(at: "09:00", days: ["mon", "wed"])).hasSuffix(" at " + TaskListWords.clock("09:00")))
        #expect(TaskListWords.trigger(.init(type: "schedule", localTime: "08:00", rrule: "FREQ=DAILY")).hasPrefix("Daily at "))
        #expect(TaskListWords.trigger(.init(type: "schedule", localTime: "08:00", rrule: "FREQ=MONTHLY")) == "On a schedule")
        #expect(TaskListWords.trigger(.init(type: "event-bus", eventName: "mail.received")) == "When mail.received arrives")
    }

    @Test func theLiveEventIsRead() {
        guard case .taskListChanged(let chat) = LiveEventsSocket.decode(name: "tasks_changed", data: .object(["chatId": .string("c")])) else {
            Issue.record("not read"); return
        }
        #expect(chat == "c" && LiveTopic.chatTasks("c") == "chat.tasks:c")
    }

    /// A change on the chat's topic reads the list again.
    @Test func aChangeReadsTheListAgain() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try decoded()
        let store = TaskListStore(chatId: "concierge", backend: backend)
        store.start()
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
        for _ in 0..<50 where store.failures == 0 { try? await Task.sleep(for: .milliseconds(10)) }
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

import Foundation
import Testing
@testable import Rome

/// A task list as a real instance sent it (#2108's dev stack), with titles,
/// names and ids replaced: watching and dropped states, a card wait with no
/// props, a routine run by hand, follows with no created time.
private let realList = #"""
{"chatId":"concierge","groups":[{"key":"later","items":[{"kind":"task","task":{"id":"id-1","title":"Task 1","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":1794613620000,"summary":"Summary 1","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-2","name":"Task chat 1"},"threadRoot":"id-3","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-4","createdAt":1794523487628,"updatedAt":1794527235772,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":{"at":"15:47","days":null},"check":{"id":"id-5","at":1794613620000,"recurring":true},"cardMessageId":null},{"kind":"task","task":{"id":"id-6","title":"Task 2","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 2","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-7","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-8","createdAt":1794510814550,"updatedAt":1794510814550,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-9","title":"Task 3","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 3","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-10","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-11","createdAt":1794516720302,"updatedAt":1794516720302,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null}]},{"key":"on_its_own","items":[{"kind":"follow","source":"github","label":"Github","target":"github-target","state":"active","digestTimes":["09:00","18:00"]},{"kind":"follow","source":"gmail","label":"Gmail","target":"gmail-target","state":"active","digestTimes":["09:00","18:00"]},{"kind":"routine","id":"id-12","name":"Routine 4","trigger":{"type":"manual"},"enabled":true,"nextRunAt":null,"lastRun":{"status":"success","firedAt":1794523358000}}]},{"key":"ended","items":[{"kind":"task","task":{"id":"id-13","title":"Task 5","state":"dropped","status":"ended","endReason":"stopped","waitingSince":1794540147000,"openWait":{"kind":"card","id":"id-16","messageId":"id-16","render":{"kind":"inline","componentId":"streak"},"since":1794540147000},"laterAt":null,"summary":"Summary 5","waitingOn":null,"dueAt":null,"rank":1,"chat":{"id":"id-14","name":"Task chat 5"},"threadRoot":null,"conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-15","createdAt":1793780980955,"updatedAt":1794562348339,"completedAt":1794562348366,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-17","title":"Task 6","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 6","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-18","name":"Task chat 6"},"threadRoot":"id-19","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-20","createdAt":1794562075368,"updatedAt":1794562197560,"completedAt":1794562212574,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-21","title":"Task 7","state":"dropped","status":"ended","endReason":"stopped","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 7","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-22","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-23","createdAt":1794513074919,"updatedAt":1794551794735,"completedAt":1794551794762,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-24","title":"Task 8","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 8","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-25","name":"Task chat 8"},"threadRoot":"id-26","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":null,"createdAt":1794543256109,"updatedAt":1794543320549,"completedAt":1794543327943,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-27","title":"Task 9","state":"dropped","status":"ended","endReason":"stopped","waitingSince":null,"openWait":null,"laterAt":null,"summary":null,"waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-28","name":"Task chat 9"},"threadRoot":"id-29","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-29","createdAt":1794542656727,"updatedAt":1794542677666,"completedAt":1794542677355,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-30","title":"Task 10","state":"dropped","status":"ended","endReason":"no_response","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 10","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-31","name":"Task chat 10"},"threadRoot":"id-32","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-33","createdAt":1794515952161,"updatedAt":1794516215897,"completedAt":1794516229639,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-34","title":"Task 11","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":null,"waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-35","name":"Task chat 11"},"threadRoot":"id-36","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-37","createdAt":1794515951078,"updatedAt":1794515970261,"completedAt":1794516005185,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-38","title":"Task 12","state":"dropped","status":"ended","endReason":"failed","waitingSince":null,"openWait":null,"laterAt":null,"summary":null,"waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-39","name":"Task chat 12"},"threadRoot":"id-40","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-40","createdAt":1794513799292,"updatedAt":1794513837271,"completedAt":1794513918406,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-41","title":"Task 13","state":"dropped","status":"ended","endReason":"no_response","waitingSince":null,"openWait":null,"laterAt":null,"summary":null,"waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-42","name":"Task chat 13"},"threadRoot":"id-43","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-44","createdAt":1794510695344,"updatedAt":1794513087601,"completedAt":1794513099011,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-45","title":"Task 14","state":"dropped","status":"ended","endReason":"failed","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 14","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-46","name":"Task chat 14"},"threadRoot":"id-47","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-47","createdAt":1794454996894,"updatedAt":1794455091091,"completedAt":1794510637860,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-48","title":"Task 15","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 15","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-49","name":"Task chat 15"},"threadRoot":null,"conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-50","createdAt":1794342886132,"updatedAt":1794342941372,"completedAt":1794342941372,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-51","title":"Task 16","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 16","waitingOn":null,"dueAt":1794333600000,"rank":1,"chat":null,"threadRoot":null,"conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-52","createdAt":1794262392988,"updatedAt":1794262392988,"completedAt":1794333600000,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null}]}]}
"""#

/// The Tasks tab reads real lists, and one odd row never fails the list.
@Suite struct TaskListRealTests {
    @Test func aRealListDecodes() throws {
        let list = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        #expect(list.groups.map(\.key) == [.later, .onItsOwn, .ended])
        #expect(list.groups.map(\.items.count) == [3, 3, 12])
        #expect(list.groups[1].items.compactMap { if case .follow(let follow) = $0 { follow.createdAt } else { nil } }.isEmpty)
        guard case .routine(let routine) = list.groups[1].items.last else { Issue.record("no routine"); return }
        #expect(routine.trigger.type == "manual" && routine.nextRunAt == nil && routine.lastRun?.status == "success")
    }

    /// An unknown group, an unknown row kind, an unknown state and odd
    /// optional fields leave the rest of the list standing.
    @Test func oddValuesDegradeOneRowAtMost() throws {
        let json = #"""
        {"chatId":"c","groups":[
         {"key":"someday","items":[]},
         {"key":"later","items":[
          {"kind":"task","task":{"id":"t1","title":"T","state":"pondering","status":"later","createdAt":1,"updatedAt":1},"schedule":{"at":5},"check":{"id":"k"},"cardMessageId":7},
          {"kind":"task","task":{"title":"no id"}},
          {"kind":"portal"}
         ]},
         {"key":"on_its_own","items":[
          {"kind":"follow","target":"x"},
          {"kind":"routine","id":"r","name":"R","trigger":{"cron":"* *"},"lastRun":"soon"}
         ]}
        ]}
        """#
        let list = try JSONDecoder().decode(TaskListResponse.self, from: Data(json.utf8))
        #expect(list.groups.map(\.key) == [.later, .onItsOwn])
        guard case .task(let task) = list.groups[0].items.first else { Issue.record("no task"); return }
        #expect(list.groups[0].items.count == 1)
        #expect(task.task.state == .next && task.schedule == nil && task.check?.recurring == false && task.cardMessageId == nil)
        guard case .follow(let follow) = list.groups[1].items.first, case .routine(let routine) = list.groups[1].items.last else { Issue.record("shapes"); return }
        #expect(follow.state == "active" && follow.digestTimes.isEmpty)
        #expect(routine.enabled && routine.lastRun == nil && TaskListWords.trigger(routine.trigger) == "On a schedule")
    }

    /// A read that fails after one worked keeps the list; one superseded by
    /// a newer read never puts an older list up.
    @MainActor @Test func aFailedReadKeepsTheListShown() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        #expect(store.groups.count == 3 && !store.loadFailed)
        backend.taskLists = [:]
        await store.load()
        #expect(store.groups.count == 3 && !store.loadFailed)
    }

    /// Open, close, open again: each open reads the list, the list read
    /// before shows at once, and nothing reads as failed.
    @MainActor @Test func openCloseReopenReadsAgain() async throws {
        let backend = FakeBackend()
        backend.taskLists["concierge"] = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        let store = TaskListStore(chatId: "concierge", backend: backend)
        store.open()
        for _ in 0..<100 where store.groups.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.groups.count == 3 && !store.loadFailed)
        store.stop()
        let before = backend.taskListReads
        store.open()
        // Shown at once from the last read, and read again.
        #expect(store.groups.count == 3 && !store.loadFailed)
        for _ in 0..<100 where backend.taskListReads == before { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.taskListReads > before && !store.loadFailed)
        store.stop()
    }

    /// The failure shows only after a read that failed, never after one
    /// that was given up on; reopening a failed tab tries again visibly.
    @MainActor @Test func theFailureFollowsOnlyAFailedRead() async throws {
        let backend = FakeBackend()
        backend.taskListError = CancellationError()
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        #expect(!store.loadFailed)
        backend.taskListError = APIError.server(status: 500, message: nil)
        await store.load()
        #expect(store.loadFailed && store.groups.isEmpty)
        // Reopened: the spinner, not the old failure, while the new read runs.
        backend.taskListError = nil
        backend.taskLists["concierge"] = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        store.open()
        #expect(!store.loadFailed && !store.loaded)
        for _ in 0..<100 where store.groups.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.groups.count == 3 && !store.loadFailed)
        store.stop()
    }
}

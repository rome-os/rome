import Foundation
import Testing
@testable import Rome

/// A task list as a real instance sent it (#2108's dev stack, its paged
/// Ended), with titles, names and ids replaced: watching and dropped states,
/// a card wait with no props, a routine run by hand, follows with no created
/// time, schedules and checks.
private let realList = #"""
{"chatId":"concierge","groups":[{"key":"later","items":[{"kind":"task","task":{"id":"id-1","title":"Task 1","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":1794613620000,"summary":"Summary 1","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-2","name":"Task chat 1"},"threadRoot":"id-3","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-4","createdAt":1794523487628,"updatedAt":1794527235772,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":{"at":"15:47","days":null},"check":{"id":"id-5","at":1794613620000,"recurring":true},"cardMessageId":null},{"kind":"task","task":{"id":"id-6","title":"Task 2","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 2","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-7","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-8","createdAt":1794510814550,"updatedAt":1794510814550,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-9","title":"Task 3","state":"watching","status":"later","endReason":null,"waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 3","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-10","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-11","createdAt":1794516720302,"updatedAt":1794516720302,"completedAt":null,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null}]},{"key":"on_its_own","items":[{"kind":"follow","source":"github","label":"Github","target":"github-target","state":"active","digestTimes":["09:00","18:00"]},{"kind":"follow","source":"gmail","label":"Gmail","target":"gmail-target","state":"active","digestTimes":["09:00","18:00"]},{"kind":"routine","id":"id-12","name":"Routine 4","trigger":{"type":"manual"},"enabled":true,"nextRunAt":null,"lastRun":{"status":"success","firedAt":1794523358000},"createdAt":1794523358000}]},{"key":"ended","total":120,"nextCursor":"1794530852037_id-85","items":[{"kind":"task","task":{"id":"id-13","title":"Task 5","state":"dropped","status":"ended","endReason":"stopped","waitingSince":1794540147000,"openWait":{"kind":"card","id":"id-16","messageId":"id-16","render":{"kind":"inline","componentId":"streak"},"since":1794540147000},"laterAt":null,"summary":"Summary 5","waitingOn":null,"dueAt":null,"rank":1,"chat":{"id":"id-14","name":"Task chat 5"},"threadRoot":null,"conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-15","createdAt":1793780980955,"updatedAt":1794562348339,"completedAt":1794562348366,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-17","title":"Task 6","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 6","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-18","name":"Task chat 6"},"threadRoot":"id-19","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-20","createdAt":1794562075368,"updatedAt":1794562197560,"completedAt":1794562212574,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-21","title":"Task 7","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 7","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-22","name":"Task chat 7"},"threadRoot":"id-23","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-24","createdAt":1794557736413,"updatedAt":1794557956494,"completedAt":1794557956288,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-25","title":"Task 8","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 8","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-26","name":"Task chat 8"},"threadRoot":"id-27","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-28","createdAt":1794556547392,"updatedAt":1794556603851,"completedAt":1794556612112,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-29","title":"Task 9","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 9","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-30","name":"Task chat 9"},"threadRoot":"id-31","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-32","createdAt":1794555647100,"updatedAt":1794555691941,"completedAt":1794555701797,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-33","title":"Task 10","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 10","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-34","name":"Task chat 10"},"threadRoot":"id-35","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-36","createdAt":1794555547632,"updatedAt":1794555605267,"completedAt":1794555617908,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-37","title":"Task 11","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 11","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-38","name":"Task chat 11"},"threadRoot":"id-39","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-40","createdAt":1794555446854,"updatedAt":1794555513204,"completedAt":1794555528772,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-41","title":"Task 12","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 12","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-42","name":"Task chat 12"},"threadRoot":"id-43","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-44","createdAt":1794555342015,"updatedAt":1794555407915,"completedAt":1794555463398,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-45","title":"Task 13","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 13","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-46","name":"Task chat 13"},"threadRoot":"id-47","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-48","createdAt":1794554356449,"updatedAt":1794555036241,"completedAt":1794555179759,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-49","title":"Task 14","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 14","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-50","name":"Task chat 14"},"threadRoot":"id-51","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-52","createdAt":1794553047469,"updatedAt":1794553081150,"completedAt":1794553088910,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-53","title":"Task 15","state":"dropped","status":"ended","endReason":"stopped","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 15","waitingOn":null,"dueAt":null,"rank":null,"chat":null,"threadRoot":"id-54","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-55","createdAt":1794513074919,"updatedAt":1794551794735,"completedAt":1794551794762,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-56","title":"Task 16","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 16","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-57","name":"Task chat 16"},"threadRoot":"id-58","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-59","createdAt":1794544286475,"updatedAt":1794544380436,"completedAt":1794544380435,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-60","title":"Task 17","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 17","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-61","name":"Task chat 17"},"threadRoot":"id-62","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-63","createdAt":1794544217743,"updatedAt":1794544296992,"completedAt":1794544313721,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-64","title":"Task 18","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 18","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-65","name":"Task chat 18"},"threadRoot":"id-66","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-67","createdAt":1794544052162,"updatedAt":1794544128475,"completedAt":1794544140183,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-68","title":"Task 19","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 19","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-69","name":"Task chat 19"},"threadRoot":"id-70","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":null,"createdAt":1794543256109,"updatedAt":1794543320549,"completedAt":1794543327943,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-71","title":"Task 20","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 20","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-72","name":"Task chat 20"},"threadRoot":"id-73","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":null,"createdAt":1794542950585,"updatedAt":1794542961790,"completedAt":1794542984127,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-74","title":"Task 21","state":"dropped","status":"ended","endReason":"stopped","waitingSince":null,"openWait":null,"laterAt":null,"summary":null,"waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-75","name":"Task chat 21"},"threadRoot":"id-76","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-76","createdAt":1794542656727,"updatedAt":1794542677666,"completedAt":1794542677355,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-77","title":"Task 22","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 22","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-78","name":"Task chat 22"},"threadRoot":"id-79","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-80","createdAt":1794529964940,"updatedAt":1794530998814,"completedAt":1794531041613,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-81","title":"Task 23","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 23","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-82","name":"Task chat 23"},"threadRoot":"id-83","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-84","createdAt":1794529964588,"updatedAt":1794531023049,"completedAt":1794531041613,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null},{"kind":"task","task":{"id":"id-85","title":"Task 24","state":"done","status":"ended","endReason":"done","waitingSince":null,"openWait":null,"laterAt":null,"summary":"Summary 24","waitingOn":null,"dueAt":null,"rank":null,"chat":{"id":"id-86","name":"Task chat 24"},"threadRoot":"id-87","conciergeChat":{"id":"concierge","name":"Main chat","main":true},"sourceMessageId":"id-88","createdAt":1794529989031,"updatedAt":1794530832888,"completedAt":1794530852037,"archivedAt":null,"notSynced":false},"schedule":null,"check":null,"cardMessageId":null}]}]}
"""#

/// The Tasks tab reads real lists, and one odd row never fails the list.
@Suite struct TaskListRealTests {
    @Test func aRealListDecodes() throws {
        let list = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        #expect(list.groups.map(\.key) == [.later, .onItsOwn, .ended])
        #expect(list.groups.map(\.items.count) == [3, 3, 20])
        #expect(list.groups[2].total == 120 && list.groups[2].nextCursor == "1794530852037_id-85")
        #expect(list.groups[1].items.compactMap { if case .follow(let follow) = $0 { follow.createdAt } else { nil } }.isEmpty)
        guard case .routine(let routine) = list.groups[1].items.last else { Issue.record("no routine"); return }
        #expect(routine.trigger.type == "manual" && routine.nextRunAt == nil && routine.lastRun?.status == "success")
    }

    /// Ended is paged: the header counts them all, and "Show more" reads the
    /// next page by its cursor, then the one after, until there is none.
    @MainActor @Test func showMoreReadsTheNextEndedPage() async throws {
        let backend = FakeBackend()
        let list = try JSONDecoder().decode(TaskListResponse.self, from: Data(realList.utf8))
        backend.taskLists["concierge"] = list
        // The next page: twenty older rows, one repeated from the first page.
        let first = list.groups[2].items
        let older = (0..<20).map { index -> TaskListItem in
            guard index > 0, case .task(var item) = first[index % first.count] else { return first[0] }
            item.task = ConciergeTask(id: "older-\(index)", title: "Older \(index)", state: .done, createdAt: 1, updatedAt: 1, status: "ended", endReason: "done")
            return .task(item)
        }
        backend.endedPages["1794530852037_id-85"] = TaskListResponse(chatId: "concierge", groups: [TaskListGroup(key: .ended, items: older, total: 120, nextCursor: "c2")])
        let store = TaskListStore(chatId: "concierge", backend: backend)
        await store.load()
        #expect(store.endedTotal == 120 && store.endedItems.count == 20 && store.endedMore == 100)
        store.showMoreEnded()
        for _ in 0..<100 where store.endedItems.count == 20 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.endedReads == ["1794530852037_id-85"])
        // The repeated row shows once.
        #expect(store.endedItems.count == 39 && store.endedMore == 81)
        // The next page goes by the cursor the last one gave; a failed read says so.
        store.showMoreEnded()
        for _ in 0..<100 where store.failures == 0 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.endedReads == ["1794530852037_id-85", "c2"] && store.failure == "Failed to load tasks")
        // The list read again keeps the older pages.
        await store.load()
        #expect(store.endedItems.count == 39)
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

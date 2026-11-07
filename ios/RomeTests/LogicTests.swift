import Foundation
import Testing
@testable import Rome

private func task(_ id: String, _ state: TaskState, updated: Double, completed: Double? = nil, archived: Double? = nil, rank: Double? = nil) -> ConciergeTask {
    ConciergeTask(
        id: id, title: id, state: state, summary: nil, waitingOn: nil, dueAt: nil, rank: rank, chat: nil,
        sourceMessageId: nil, createdAt: updated, updatedAt: updated, completedAt: completed, archivedAt: archived, notSynced: nil
    )
}

@Suite struct TaskGroupingTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    @Test func twoGroupsInOrderWithoutArchived() {
        let groups = TasksStore.group([
            task("done", .done, updated: nowMs, completed: nowMs),
            task("needs", .needsUser, updated: nowMs - 60_000),
            task("gone", .doing, updated: nowMs, archived: nowMs),
            task("doing", .doing, updated: nowMs),
            task("next", .next, updated: nowMs - 120_000),
            task("watching", .watching, updated: nowMs - 30_000),
        ], showAllDone: false, now: now)
        #expect(groups.map(\.key) == [.inProgress, .done])
        // Waiting on the guardian first, then the latest update.
        #expect(groups[0].tasks.map(\.id) == ["needs", "doing", "watching", "next"])
        #expect(groups[1].tasks.map(\.id) == ["done"])
    }

    @Test func onlyDoneLeavesTheProgressGroupOut() {
        let groups = TasksStore.group([task("done", .done, updated: nowMs, completed: nowMs)], showAllDone: false, now: now)
        #expect(groups.map(\.key) == [.done])
    }

    @Test func oldFinishedRowsHideBehindShowMore() {
        let old = nowMs - 10 * 86_400_000
        let groups = TasksStore.group([
            task("recent", .done, updated: nowMs, completed: nowMs),
            task("old", .done, updated: old, completed: old),
            task("dropped", .dropped, updated: old, completed: old),
        ], showAllDone: false, now: now)
        #expect(groups.first?.tasks.map(\.id) == ["recent"])
        #expect(groups.first?.hidden == 2)
        let all = TasksStore.group([task("old", .done, updated: old, completed: old)], showAllDone: true, now: now)
        #expect(all.first?.tasks.map(\.id) == ["old"])
    }

    @Test func severalWaitingOnesSortByLatestUpdate() {
        let groups = TasksStore.group([
            task("old", .needsUser, updated: 1),
            task("doing", .doing, updated: 5),
            task("new", .needsUser, updated: 3),
        ], showAllDone: false, now: now)
        #expect(groups.first?.tasks.map(\.id) == ["new", "old", "doing"])
    }

    @Test func theMutedLineSaysOneThing() {
        let waiting = task("w", .needsUser, updated: nowMs - 2 * 3_600_000)
        #expect(TasksStore.rowLine(waiting, status: .waiting, now: now) == "Waiting on you")
        let failed = task("f", .doing, updated: nowMs)
        #expect(TasksStore.rowLine(failed, status: .failed, now: now) == "Didn't finish")
        let doing = task("d", .doing, updated: nowMs - 2 * 3_600_000)
        #expect(TasksStore.rowLine(doing, status: .plain, now: now) == RelativeTime.ago(Date(timeIntervalSince1970: (nowMs - 2 * 3_600_000) / 1000), now: now))
        // A finished row counts from when it finished.
        let done = task("x", .done, updated: nowMs, completed: nowMs - 86_400_000)
        #expect(TasksStore.rowLine(done, status: .plain, now: now) == RelativeTime.ago(Date(timeIntervalSince1970: (nowMs - 86_400_000) / 1000), now: now))
    }

    @Test func rowStatusIsWaitingFailedOrPlain() {
        let failedChat = ChatSession(id: "c", name: "c", running: false, lastTurnFailed: true)
        let runningChat = ChatSession(id: "c", name: "c", running: true, lastTurnFailed: true)
        #expect(TasksStore.rowStatus(task("w", .needsUser, updated: 1), chat: nil) == .waiting)
        #expect(TasksStore.rowStatus(task("f", .doing, updated: 1), chat: failedChat) == .failed)
        #expect(TasksStore.rowStatus(task("r", .doing, updated: 1), chat: runningChat) == .plain)
        #expect(TasksStore.rowStatus(task("n", .next, updated: 1), chat: nil) == .plain)
        #expect(TasksStore.rowStatus(task("d", .done, updated: 1, completed: 1), chat: failedChat) == .plain)
    }

    @MainActor @Test func olderUpsertsAreIgnoredAndArchivedRowsLeave() {
        let store = TasksStore(backend: StubBackend())
        store.apply(task("x", .doing, updated: 10))
        store.apply(task("x", .needsUser, updated: 5))
        #expect(store.tasks.first?.state == .doing)
        store.apply(task("x", .done, updated: 20, archived: 20))
        #expect(store.tasks.isEmpty)
    }
}

@Suite struct MarkdownTests {
    @Test func parsesBlocks() {
        let blocks = MarkdownParser.parse("""
        # Title

        Para one
        line two

        - a
        - b

        1. x
        2. y

        > quoted

        ```swift
        let a = 1
        ```
        ---
        """)
        #expect(blocks == [
            .heading(level: 1, text: "Title"),
            .paragraph("Para one\nline two"),
            .list(ordered: false, start: 1, items: ["a", "b"]),
            .list(ordered: true, start: 1, items: ["x", "y"]),
            .quote("quoted"),
            .code(language: "swift", text: "let a = 1"),
            .rule,
        ])
    }

    @Test func unterminatedCodeStillRenders() {
        #expect(MarkdownParser.parse("```\nabc") == [.code(language: nil, text: "abc")])
    }

    @Test func plainDropsMarks() {
        #expect(MarkdownParser.plain("**bold** and `code`") == "bold and code")
    }
}

@Suite struct RoutineTextTests {
    @Test func describesSchedules() {
        #expect(RoutineText.frequency("FREQ=DAILY") == "Daily")
        #expect(RoutineText.frequency("FREQ=DAILY;INTERVAL=3") == "Every 3 days")
        #expect(RoutineText.frequency("FREQ=WEEKLY;BYDAY=MO,FR") == "Weekly on Mon, Fri")
        #expect(RoutineText.frequency("FREQ=HOURLY;INTERVAL=2") == "Every 2 hours")
        #expect(RoutineText.title("price_watch") == "Price watch")
        #expect(RoutineText.title("每日简报") == "每日简报")
        #expect(RoutineText.frequency("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") == "Weekdays")
        #expect(RoutineText.frequency("FREQ=WEEKLY;BYDAY=SA,SU") == "Weekends")
        #expect(RoutineText.frequency("FREQ=WEEKLY;BYDAY=MO") == "Mondays")
    }

    private func routine(_ rule: String?, next: TimeInterval?, enabled: Bool = true, type: String = "schedule") -> Routine {
        var trigger: [String: JSONValue] = ["type": .string(type), "localTime": .string("09:00")]
        if let rule { trigger["rrule"] = .string(rule) }
        return Routine(id: "r", name: "r", enabled: enabled, trigger: .object(trigger),
                       nextRunAt: next.map { RomeDate.string(now.addingTimeInterval($0)) },
                       managedBy: nil, actionName: nil, lastFiredAt: nil, lastRun: nil)
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    /// "Next" only where the schedule does not already say it.
    @Test func showsNextOnlyWhenNotObvious() {
        // Every day or weekday, next within a day: the schedule tells.
        #expect(!RoutineText.showsNext(routine("FREQ=DAILY", next: 3600 * 5), now: now))
        #expect(!RoutineText.showsNext(routine("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", next: 3600 * 20), now: now))
        #expect(!RoutineText.showsNext(routine("FREQ=HOURLY", next: 600), now: now))
        // Weekdays on a Friday night: Monday is not obvious.
        #expect(RoutineText.showsNext(routine("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", next: 3600 * 60), now: now))
        // Weekly, monthly, every few days and one-off always say it.
        #expect(RoutineText.showsNext(routine("FREQ=WEEKLY;BYDAY=MO", next: 3600 * 5), now: now))
        #expect(RoutineText.showsNext(routine("FREQ=MONTHLY", next: 3600 * 5), now: now))
        #expect(RoutineText.showsNext(routine("FREQ=DAILY;INTERVAL=3", next: 3600 * 5), now: now))
        #expect(RoutineText.showsNext(routine(nil, next: 3600 * 5), now: now))
        // Paused, or no next run: nothing.
        #expect(!RoutineText.showsNext(routine("FREQ=MONTHLY", next: 3600, enabled: false), now: now))
        #expect(!RoutineText.showsNext(routine("FREQ=MONTHLY", next: nil), now: now))
        #expect(RoutineText.schedule(routine("FREQ=DAILY", next: 3600 * 5), now: now) == "Daily 09:00")
    }
}

@Suite struct AuthTests {
    let issuer = URL(string: "https://romeos.cc")!

    @Test func acceptsAMatchingCallback() throws {
        let url = URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=s1&iss=https://romeos.cc")!
        #expect(try CloudAuth.code(from: url, state: "s1", issuer: issuer) == "abc")
    }

    @Test func rejectsWrongStateIssuerOrError() {
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=other&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=s1&iss=https://evil.example")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?error=access_denied&state=s1&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "evil:/oauth/callback?code=abc&state=s1&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
    }

    @Test func base64URLHasNoPadding() {
        #expect(CloudAuth.base64URL(Data([0xFB, 0xFF])) == "-_8")
    }

    @Test func approvalStatusFollowsTheRecord() {
        #expect(ApprovalStatus.derive(stored: "pending", record: nil) == .pending)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "approved", executionState: "running")) == .executing)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "approved", executionState: "succeeded")) == .executed)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "rejected")) == .rejected)
    }

    @Test func toolCallsReadRunsAndBlocks() {
        let segments: [JSONValue] = [
            .object(["kind": .string("run"), "blocks": .array([
                .object(["type": .string("tool_use"), "tool": .string("mcp__app__web_fetch"), "id": .string("1"), "input": .object(["url": .string("https://a")])]),
                .object(["type": .string("tool_result"), "tool": .string("web_fetch")]),
            ])]),
            .object(["kind": .string("block"), "block": .object(["type": .string("tool_use"), "tool": .string("Bash"), "input": .object(["command": .string("ls\n-la")])])]),
        ]
        let calls = ToolCallExtractor.calls(in: segments)
        #expect(calls.map(\.name) == ["web_fetch", "Bash"])
        #expect(calls.map(\.detail) == ["https://a", "ls -la"])
    }
}

/// A backend that answers nothing, for stores under test.
@MainActor
final class StubBackend: RomeBackend {
    final class Events: LiveEventSource {
        func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID { UUID() }
        func unsubscribe(_ token: UUID) {}
        func pause() {}
        func resume() {}
    }

    let displayOrigin = "stub"
    let events: LiveEventSource = Events()
    func conciergeSession() async throws -> ConciergeSessionInfo { .init(id: "concierge", unread: 0) }
    func conciergeChats() async throws -> [ConciergeChat] { [] }
    func startTopicChat() async throws -> ConciergeChat { throw APIError.network }
    func renameChat(_ id: String, to name: String) async throws {}
    func archiveChat(_ id: String) async throws {}
    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage { .init(messages: []) }
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn { .init() }
    func asset(path: String) async throws -> Data { throw APIError.notFound }
    func apiFile(path: String, query: String?) async throws -> Data { throw APIError.notFound }
    var origin: URL? { nil }
    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws {}
    func markRead(sessionId: String) async {}
    func sessions() async throws -> [ChatSession] { [] }
    func activeTurns(sessionId: String) async throws -> [ActiveTurn] { [] }
    func interrupt(turnId: String) async throws {}
    func tasks() async throws -> [ConciergeTask] { [] }
    func approval(id: String) async throws -> ApprovalRecord { .init(id: id, status: "pending") }
    func resolveApproval(id: String, approve: Bool) async throws {}
    func toolCalls(traceMessageId: String) async throws -> [ToolCall] { [] }
    func aiTools() async throws -> AIToolsStatus { .init() }
    func setConciergeEnabled(_ enabled: Bool) async throws {}
    func search(_ query: String) async throws -> [SearchHit] { [] }
    func me() async throws -> String? { nil }
    func routines() async throws -> [Routine] { [] }
    func setRoutine(_ id: String, enabled: Bool) async throws {}
    func sendFeedback(_ text: String) async throws {}
    func upgradeCheck() async throws -> UpgradeCheck { throw APIError.network }
    func startUpgrade(target: String) async throws -> UpgradeStarted { throw APIError.network }
    func buildInfo() async throws -> BuildInfo { throw APIError.network }
}

@Suite struct AppLanguageTests {
    /// Named in its own language, from what iOS resolved for the app.
    @Test func namesTheResolvedLanguage() {
        #expect(AppLanguage.name("zh-Hans") == "简体中文")
        #expect(AppLanguage.name("en") == "English")
        #expect(AppLanguage.name(nil) == "English")
    }
}

@MainActor
@Suite struct LanguageSyncTests {
    private func defaults() -> UserDefaults {
        let name = "language-sync-\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    @Test func mapsToTheDashboardsCodes() {
        #expect(LanguageSync.code("zh-Hans") == "zh-CN")
        #expect(LanguageSync.code("en") == "en")
        #expect(LanguageSync.code(nil) == "en")
    }

    /// A first run or a new instance only remembers: it never overwrites a
    /// choice made on another device.
    @Test func theFirstSightDoesNotWrite() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes.isEmpty)
    }

    @Test func aChangeWritesOnceAndNoChangeDoesNot() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "en", isGuardian: { true }) { writes.append($0) }
        await sync.check(host: "a", current: "en", isGuardian: { true }) { writes.append($0) }
        #expect(writes.isEmpty)
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes == ["zh-CN"])
        // Each instance remembers its own.
        await sync.check(host: "b", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes == ["zh-CN"])
    }

    @Test func aFailedWriteIsTriedAgain() async {
        let sync = LanguageSync(defaults: defaults())
        var attempts = 0
        await sync.check(host: "a", current: "en", isGuardian: { true }) { _ in }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { _ in
            attempts += 1
            throw APIError.network
        }
        var writes: [String] = []
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(attempts == 1)
        #expect(writes == ["zh-CN"])
    }

    @Test func aVisitorNeverWrites() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "en", isGuardian: { false }) { writes.append($0) }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { false }) { writes.append($0) }
        #expect(writes.isEmpty)
    }
}

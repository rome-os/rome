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

    @Test func groupsInOrderAndSkipsEmptyAndArchived() {
        let groups = TasksStore.group([
            task("done", .done, updated: nowMs, completed: nowMs),
            task("needs", .needsUser, updated: nowMs),
            task("gone", .doing, updated: nowMs, archived: nowMs),
            task("doing", .doing, updated: nowMs),
        ], showAllDone: false, now: now)
        #expect(groups.map(\.key) == [.needsYou, .doing, .done])
        #expect(groups[1].tasks.map(\.id) == ["doing"])
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

    @Test func nextFollowsRankThenCreation() {
        let groups = TasksStore.group([
            task("b", .next, updated: 2, rank: nil),
            task("a", .next, updated: 3, rank: 1),
            task("c", .next, updated: 1, rank: nil),
        ], showAllDone: false, now: now)
        #expect(groups.first?.tasks.map(\.id) == ["a", "c", "b"])
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
    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage { .init(messages: []) }
    func send(sessionId: String, text: String, inputId: String, priority: InputPriority) async throws -> CreatedTurn { .init() }
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
}

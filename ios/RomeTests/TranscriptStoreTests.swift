import Foundation
import Testing
@testable import Rome

/// A backend that serves one chat from memory, paged the way the server pages.
@MainActor
final class FakeBackend: RomeBackend {
    let displayOrigin = "test"
    let bus = LocalEventBus()
    var events: LiveEventSource { bus }

    var stored: [ChatMessage] = []
    var turns: [ActiveTurn] = []
    var interrupted: [String] = []
    /// Whether an interrupt ends the turn on the server.
    var interruptEndsTurn = true

    /// Runs while an older page is in flight, after the page was read.
    var duringOlderFetch: (() async -> Void)?
    /// How many times the newest page and the task list were fetched.
    var newestFetches = 0
    var taskFetches = 0
    /// Runs while the newest page is in flight.
    var duringNewestFetch: (() async -> Void)?

    /// Set, every message read fails with it.
    var messagesError: APIError?

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        pageLimits.append(limit)
        if let messagesError { throw messagesError }
        let end = before.flatMap { cursor in stored.firstIndex { $0.id == cursor } } ?? stored.count
        let start = max(0, end - limit)
        let page = MessagePage(messages: Array(stored[start..<end]), nextCursor: start > 0 ? stored[start].id : nil)
        if before != nil, let hook = duringOlderFetch {
            duringOlderFetch = nil
            await hook()
        }
        if before == nil {
            newestFetches += 1
            if let hook = duringNewestFetch {
                duringNewestFetch = nil
                await hook()
            }
        }
        return page
    }

    /// Set, the active turns cannot be read.
    var activeTurnsError: APIError?

    func activeTurns(sessionId: String) async throws -> [ActiveTurn] {
        if let activeTurnsError { throw activeTurnsError }
        return turns
    }

    func interrupt(turnId: String) async throws {
        interrupted.append(turnId)
        if interruptEndsTurn { turns.removeAll { $0.turnId == turnId } }
    }

    /// The person's main chat, as `/concierge/session` names it; nil fails.
    var mainChat: ConciergeSessionInfo?
    func conciergeSession() async throws -> ConciergeSessionInfo {
        guard let mainChat else { throw APIError.network }
        return mainChat
    }

    /// Topic chats and the calls that start and write to them, in order.
    var topicChats: [ConciergeChat] = []
    var calls: [String] = []
    var startFails = false

    /// Runs inside the chat-list fetch, before it answers.
    var duringChatsFetch: (() async -> Void)?

    func conciergeChats() async throws -> [ConciergeChat] {
        let answer = [ConciergeChat(id: conciergeChatID, name: "", main: true, unread: 0)] + topicChats
        await duringChatsFetch?()
        return answer
    }

    func startTopicChat() async throws -> ConciergeChat {
        calls.append("start")
        if startFails { throw APIError.network }
        let chat = ConciergeChat(id: "topic-\(topicChats.count + 1)", name: "", main: false, unread: 0)
        topicChats.append(chat)
        return chat
    }

    func renameChat(_ id: String, to name: String) async throws {
        calls.append("rename \(id) \(name)")
        if let index = topicChats.firstIndex(where: { $0.id == id }) { topicChats[index].name = name }
    }

    func archiveChat(_ id: String) async throws {
        calls.append("archive \(id)")
        topicChats.removeAll { $0.id == id }
    }

    func deleteChat(_ id: String) async throws {
        calls.append("delete \(id)")
        topicChats.removeAll { $0.id == id }
    }

    /// Share links: what each create asked for, the answer it gets, the
    /// chat's links, and the revokes, in order.
    var shareRequests: [(sessionId: String, turnIds: [String], agentName: String?)] = []
    var shareAnswer: Result<ChatShareLink, APIError> = .success(ChatShareLink(id: "s1", url: "/share/tok1", title: "Trip"))
    var shareLinks: [ChatShareLink] = []
    var revoked: [String] = []
    var revokeError: APIError?

    /// Runs inside a share, after the instance took it.
    var duringShare: (() async -> Void)?

    func shareChat(sessionId: String, turnIds: [String], agentName: String?) async throws -> ChatShareLink {
        shareRequests.append((sessionId, turnIds, agentName))
        await duringShare?()
        return try shareAnswer.get()
    }

    /// The chats whose links were listed, in order.
    var sharesListed: [String] = []
    func chatShares(sessionId: String) async throws -> [ChatShareLink] {
        sharesListed.append(sessionId)
        return shareLinks
    }

    /// Runs inside a revoke, before it answers.
    var duringRevoke: (() async -> Void)?

    func revokeShare(id: String) async throws {
        revoked.append(id)
        await duringRevoke?()
        if let revokeError { throw revokeError }
        shareLinks.removeAll { $0.id == id }
    }

    /// The files of the last send.
    var sentFiles: [OutgoingFile] = []

    func asset(path: String) async throws -> Data { throw APIError.notFound }
    /// Files under `/api`, by path; any other path is not found.
    var apiFiles: [String: Data] = [:]
    /// The `/api` files asked for, in order.
    var apiFileRequests: [String] = []
    /// Runs inside a file request, before it answers.
    var duringApiFile: (() async -> Void)?
    func apiFile(path: String, query: String?) async throws -> Data {
        apiFileRequests.append(path)
        await duringApiFile?()
        guard let data = apiFiles[path] else { throw APIError.notFound }
        return data
    }
    var origin: URL? { nil }

    /// The task list each read answers, by chat; a missing one fails.
    var taskLists: [String: TaskListResponse] = [:]
    var taskListReads = 0
    /// What a Stop from the task list fails with; nil lets it through.
    var stopListedError: APIError?
    var stoppedFromList: [String] = []
    /// Set, every task list read throws it (a cancellation, say).
    var taskListError: Error?
    func taskList(chatId: String) async throws -> TaskListResponse {
        taskListReads += 1
        if let taskListError { throw taskListError }
        guard let list = taskLists[chatId] else { throw APIError.notFound }
        return list
    }
    /// The Ended pages after the first, by cursor; a missing one fails.
    var endedPages: [String: TaskListResponse] = [:]
    var endedReads: [String] = []
    func endedTasks(chatId: String, endedBefore: String) async throws -> TaskListResponse {
        endedReads.append(endedBefore)
        guard let page = endedPages[endedBefore] else { throw APIError.notFound }
        return page
    }
    func stopListedTask(chatId: String, taskId: String) async throws {
        stoppedFromList.append(taskId)
        if let stopListedError { throw stopListedError }
    }

    /// Off, every send fails, as it always did here.
    var sendSucceeds = false

    /// What each send asked for its chat thread, in order.
    var sentThreads: [ThreadTarget?] = []
    /// A thread read's answer, by the message asked for; missing ones fail.
    var threads: [String: [ChatMessage]] = [:]
    var threadReads: [String] = []

    /// Set, every thread read fails with it (a network error, say).
    var threadError: APIError?
    /// Runs inside a thread read, before it answers.
    var duringThreadRead: (() async -> Void)?


    func thread(sessionId: String, messageId: String) async throws -> [ChatMessage] {
        threadReads.append(messageId)
        await duringThreadRead?()
        if let threadError { throw threadError }
        guard let thread = threads[messageId] else { throw APIError.notFound }
        return thread
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, thread: ThreadTarget?) async throws -> CreatedTurn {
        sentThreads.append(thread)
        return try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        sentFiles = files
        sentInputIds.append(inputId)
        calls.append(files.isEmpty ? "send \(sessionId) \(text)" : "send \(sessionId) \(text) [\(files.count) files]")
        if sendSucceeds { return CreatedTurn(turnId: sendTurnId, inputId: inputId, disposition: "started") }
        throw sendError
    }
    /// The input id of each send, in order.
    var sentInputIds: [String] = []
    /// What a send fails with when `sendSucceeds` is off.
    var sendError: APIError = .network
    /// The turn a successful send starts; nil is a send that started none.
    var sendTurnId: String? = "turn"
    var answeredSessions: [String] = []
    var answeredWidgets: [String] = []
    /// What an answer fails with; nil lets it through.
    var answerError: APIError? = .network
    var pending: [PendingApproval] = []
    /// The page size of each fetch, in order.
    var pageLimits: [Int] = []

    func pendingApprovals() async throws -> [PendingApproval] { pending }

    func answerWidget(widgetId: String, name: String, context: JSONValue) async throws -> WidgetEventReply {
        answeredWidgets.append(widgetId)
        if let answerError { throw answerError }
        return WidgetEventReply(answered: true)
    }
    /// The chats marked read, in order.
    var reads: [String] = []
    func markRead(sessionId: String) async { reads.append(sessionId) }
    /// The chat's read mark, as `GET /chat/sessions/:id` gives it, and how
    /// many reads had gone out each time it was asked for.
    var readMarkValue: String?
    var readsBeforeMark: [Int] = []
    func readMark(sessionId: String) async -> String? {
        readsBeforeMark.append(reads.count)
        return readMarkValue
    }
    /// The chats and tasks the lists hold.
    var sessionRows: [ChatSession] = []
    var taskRows: [ConciergeTask] = []
    var stoppedTasks: [String] = []
    func sessions() async throws -> [ChatSession] { sessionRows }
    func tasks() async throws -> [ConciergeTask] {
        taskFetches += 1
        return taskRows
    }
    /// What a stop on a task fails with; nil lets it through.
    var stopError: APIError?
    func stopTask(id: String) async throws {
        if let stopError { throw stopError }
        stoppedTasks.append(id)
    }
    func approval(id: String) async throws -> ApprovalRecord { throw APIError.network }
    /// What a decision on an approval fails with; nil lets it through.
    var resolveError: APIError? = .network
    var resolved: [String] = []
    func resolveApproval(id: String, approve: Bool) async throws {
        if let resolveError { throw resolveError }
        resolved.append(id)
    }
    func toolCalls(traceMessageId: String) async throws -> [ToolCall] { [] }
    func aiTools() async throws -> AIToolsStatus { throw APIError.network }
    func setConciergeEnabled(_ enabled: Bool) async throws {}
    func search(_ query: String) async throws -> [SearchHit] { [] }
    var identity: Result<AccountIdentity?, Error> = .success(nil)
    func me() async throws -> AccountIdentity? { try identity.get() }
    func sendFeedback(_ text: String) async throws {}

    // MARK: Connect cards

    /// The connector list each read answers, in turn; the last one repeats. Nil fails the read.
    var connectorReads: [[ConnectorState]?] = []
    var connectorReadCount = 0
    /// Replies per API path, in turn; the last one repeats.
    var replies: [String: [ConnectReply]] = [:]
    var connectCalls: [(method: String, path: String, body: JSONValue?)] = []
    var notified: [(chatId: String, service: String)] = []

    func connectors() async throws -> [ConnectorState] {
        guard !connectorReads.isEmpty else { return [] }
        let index = min(connectorReadCount, connectorReads.count - 1)
        connectorReadCount += 1
        guard let list = connectorReads[index] else { throw APIError.network }
        return list
    }

    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply {
        connectCalls.append((method, apiPath, body))
        guard var queue = replies[apiPath], !queue.isEmpty else { return ConnectReply(ok: false, body: .object([:])) }
        let reply = queue.count > 1 ? queue.removeFirst() : queue[0]
        replies[apiPath] = queue
        return reply
    }

    func notifyServiceConnected(chatId: String, service: String) async {
        notified.append((chatId, service))
    }

    var check: Result<UpgradeCheck, Error> = .success(UpgradeCheck(current: .init(version: "1.0.0"), latest: .init(version: "1.0.0"), upgradeAvailable: false))
    var startResults: [Result<UpgradeStarted, Error>] = []
    var started: [String] = []
    var buildVersion: String?

    func upgradeCheck() async throws -> UpgradeCheck { try check.get() }

    func startUpgrade(target: String) async throws -> UpgradeStarted {
        started.append(target)
        return try (startResults.isEmpty ? .success(UpgradeStarted(status: "started", target: target)) : startResults.removeFirst()).get()
    }

    func buildInfo() async throws -> BuildInfo {
        guard let buildVersion else { throw APIError.network }
        return BuildInfo(version: buildVersion)
    }
}

private func chatMessage(_ index: Int, role: String = "assistant") -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "message \(index)"]]), encoding: .utf8)!
    return ChatMessage(id: "m\(index)", sessionId: "task", role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index))))
}

@MainActor
@Suite struct TranscriptStoreTests {
    /// 50 messages; the first one is the guardian's brief.
    private func backendWithLongChat() -> FakeBackend {
        let backend = FakeBackend()
        backend.stored = (0..<50).map { chatMessage($0, role: $0 == 0 ? "user" : "assistant") }
        return backend
    }

    @Test func olderPageWaitsUntilPlaced() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.messages.count == 40)
        #expect(store.hasOlder)

        await store.loadOlder()
        #expect(store.olderPage != nil)
        #expect(store.messages.count == 40)

        await store.placeOlderPage()
        #expect(store.olderPage == nil)
        #expect(store.messages.count == 50)
        #expect(!store.hasOlder)
    }

    @Test func reloadKeepsThePagesAlreadyLoaded() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        await store.loadOlder()
        await store.placeOlderPage()

        backend.stored.append(chatMessage(50))
        await store.reload()
        #expect(store.messages.count == 51)
        #expect(!store.hasOlder)
    }

    @Test func briefIsUnknownUntilTheOldestPageIsHeld() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.brief == nil)

        await store.loadOlder()
        await store.placeOlderPage()
        #expect(store.brief?.id == "m0")
    }

    /// The read mark at `seconds` past the base time of `chatMessage`.
    private func readMark(at seconds: TimeInterval) -> String {
        RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    }

    @Test func theUnreadLineIsReadBeforeTheChatIsMarkedReadAndOutlivesIt() async {
        let backend = FakeBackend()
        backend.stored = (0..<4).map { chatMessage($0, role: $0 == 0 ? "user" : "assistant") }
        backend.readMarkValue = readMark(at: 1)
        let store = TranscriptStore(sessionId: "task", kind: .concierge, backend: backend)
        store.beginOpen()
        store.markRead()
        await store.reload()
        for _ in 0..<100 where store.unreadFrom == nil || backend.reads.isEmpty {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(backend.readsBeforeMark == [0])
        #expect(backend.reads == ["task"])
        #expect(store.unreadFrom == "m2")
        let ids = store.rows.map(\.id)
        #expect(ids.firstIndex(of: "unread-divider").map { ids[$0 + 1] } == "m2:0")

        // Read now, and still marked while the chat stays open; closed, it goes.
        store.markRead()
        #expect(store.unreadFrom == "m2")
        store.endOpen()
        #expect(store.unreadFrom == nil)
        #expect(!store.rows.contains(.unreadDivider))
    }

    @Test func aMessageThatArrivesLiveWhileTheChatOpensIsNeverUnread() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage(0, role: "user"), chatMessage(1)]
        backend.readMarkValue = readMark(at: 1)
        backend.duringNewestFetch = {
            backend.bus.emit(LiveTopic.chat("task"), .messageInsert(chatMessage(5)))
        }
        let store = TranscriptStore(sessionId: "task", kind: .concierge, backend: backend)
        store.beginOpen()
        store.markRead()
        store.start()
        for _ in 0..<100 where backend.reads.isEmpty || !store.loaded {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.messages.map(\.id).contains("m5"))
        #expect(store.unreadFrom == nil)
        store.stop()
    }

    @Test func aTaskChatHasNoUnreadLine() async {
        let backend = FakeBackend()
        backend.stored = [chatMessage(0, role: "user"), chatMessage(1)]
        backend.readMarkValue = readMark(at: 0)
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        store.beginOpen()
        await store.reload()
        #expect(backend.readsBeforeMark.isEmpty)
        #expect(store.unreadFrom == nil)
    }

    @Test func stopEndsRunningWithoutALiveEvent() async throws {
        let backend = FakeBackend()
        backend.stored = [chatMessage(0, role: "user")]
        backend.turns = [ActiveTurn(turnId: "t1", status: "running", quiet: false)]
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.running)

        // No socket event arrives here: only the active turns can tell it ended.
        store.stopTurn()
        for _ in 0..<40 where store.running {
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(backend.interrupted == ["t1"])
        #expect(!store.running)
        #expect(!store.stopping)
        #expect(store.stopped)

        backend.turns = [ActiveTurn(turnId: "t2", status: "running", quiet: false)]
        await store.reload()
        #expect(store.running)
        #expect(!store.stopped)
    }

    @Test func rowsWrittenInTheSameSecondKeepTheServersOrder() async {
        func row(_ id: String, turn: String, second: Double, role: String = "assistant") -> ChatMessage {
            ChatMessage(id: id, sessionId: "task", turnId: turn, role: role, content: "[]", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + second)))
        }
        let backend = FakeBackend()
        // Server order: a turn's rows together, the turn's late reply before
        // the next turn, two rows in the same second in the order written.
        backend.stored = [
            row("u1", turn: "t1", second: 0, role: "user"),
            row("a1", turn: "t1", second: 20),
            row("a2", turn: "t1", second: 50),
            row("a3", turn: "t1", second: 50),
            row("u2", turn: "t2", second: 30, role: "user"),
        ]
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        let expected = ["u1", "a1", "a2", "a3", "u2"]
        #expect(store.messages.map(\.id) == expected)

        await store.reload()
        await store.reload()
        #expect(store.messages.map(\.id) == expected)
    }

    @Test func rowsWithoutATurnTieByArrivalNotByID() async {
        func row(_ id: String) -> ChatMessage {
            ChatMessage(id: id, sessionId: "task", turnId: nil, role: "assistant", content: "[]", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
        }
        let backend = FakeBackend()
        // Same second, no turn: the server sent "z-recap" first.
        backend.stored = [row("z-recap"), row("a-card")]
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.messages.map(\.id) == ["z-recap", "a-card"])
        await store.reload()
        #expect(store.messages.map(\.id) == ["z-recap", "a-card"])
    }

    @Test func olderPageFromBeforeAGapIsDropped() async {
        let backend = backendWithLongChat()
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()

        // While the older page is in flight, the chat moves on far enough that
        // the newest page shares nothing with what is held.
        backend.duringOlderFetch = {
            backend.stored = (100..<150).map { chatMessage($0) }
            await store.reload()
        }
        await store.loadOlder()

        #expect(store.olderPage == nil)
        #expect(store.messages.allSatisfy { Int($0.id.dropFirst())! >= 100 })
        #expect(store.hasOlder)
    }
}

/// A first message never sends the chat back to a loading state.
@MainActor
@Suite struct FirstSendTests {
    private func hasBubble(_ store: TranscriptStore, _ text: String) -> Bool {
        store.rows.contains { if case .userText(_, let body, _, _) = $0 { return body == text } else { return false } }
    }

    @Test func anEmptyChatStaysLoadedThroughItsFirstSend() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        #expect(store.loaded && store.rows.isEmpty)
        var loadedDuringFetch: Bool?
        backend.duringNewestFetch = { loadedDuringFetch = store.loaded }
        store.send("Plan my week")
        #expect(store.loaded && hasBubble(store, "Plan my week"))
        await store.reload()
        #expect(loadedDuringFetch == true)
        #expect(store.loaded && hasBubble(store, "Plan my week"))
    }

    /// A blank topic chat hands its message to the new chat's store, shown at once.
    @Test func aNewTopicChatShowsItsFirstMessageWithoutLoading() async {
        let backend = FakeBackend()
        let workspace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "first-send-\(UUID().uuidString)/Drafts"), instance: "t"))
        var loadedDuringFetch: Bool?
        backend.duringNewestFetch = { loadedDuringFetch = workspace.topicStore("topic-1").loaded }
        let id = await workspace.startTopicChat(firstMessage: "Trip ideas")
        #expect(id == "topic-1")
        let store = workspace.topicStore("topic-1")
        #expect(store.loaded)
        #expect(hasBubble(store, "Trip ideas"))
        for _ in 0..<20 where loadedDuringFetch == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(loadedDuringFetch == true)
        #expect(store.loaded && hasBubble(store, "Trip ideas"))
    }
}

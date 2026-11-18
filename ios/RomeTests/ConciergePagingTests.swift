import Foundation
import Testing
import UIKit
@testable import Rome

// A Concierge chat pages by main-line messages, each with the summary of the thread it roots
// (rome-os/rome#2363, docs/domains/chats.md#chat-thread).

private func cmsg(
    _ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, thread: String? = nil,
    read: Bool? = nil, turn: String? = nil, title: String? = nil, parts: [[String: Any]]? = nil
) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: parts ?? [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: "concierge", turnId: turn, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread ?? id, knowsThreads: true, chatThreadTitle: title, read: read)
}

private func summary(_ latest: ChatMessage, total: Int, unread: Int) -> ThreadSummary {
    ThreadSummary(replyCount: total, unreadCount: unread, latest: latest, unreadAt: unread > 0 ? latest.date.timeIntervalSince1970 : 0)
}

/// A page by main-line messages: the newest reply of each thread with a summary comes with its root.
private func page(_ main: [ChatMessage], threads: [String: ThreadSummary] = [:], titles: [String: String] = [:], next: String? = nil) -> MessagePage {
    var body: [ChatMessage] = []
    for message in main {
        body.append(message)
        if let thread = threads[message.id] { body.append(thread.latest) }
    }
    let outside = threads.filter { entry in !main.contains { $0.id == entry.key } }.map(\.value.latest)
    return MessagePage(messages: body + outside, nextCursor: next, concierge: ConciergeAnswer(body: body, oldestAt: main.map(\.date).min(), summaries: threads, titles: titles, root: nil))
}

/// One thread read whole: its root and every reply.
private func whole(_ root: ChatMessage, _ replies: [ChatMessage]) -> MessagePage {
    MessagePage(messages: [root] + replies, nextCursor: nil, concierge: ConciergeAnswer(
        body: [root] + replies, oldestAt: root.date, summaries: ThreadSummary.of(replies: replies).map { [root.id: $0] } ?? [:], titles: [:], root: root.id
    ))
}

/// Answers by the wire, one response after another (the last repeats), and records the requests.
final class ConciergeWireRecorder: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var responses: [(Int, Data)] = []
    static var requests: [URLRequest] { lock.withLock { recorded } }
    static func reset(_ answers: [(Int, Any)]) {
        lock.withLock {
            recorded = []
            responses = answers.map { ($0.0, (try? JSONSerialization.data(withJSONObject: $0.1)) ?? Data()) }
        }
    }
    static func query(_ request: URLRequest) -> [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (code, body) = Self.lock.withLock { () -> (Int, Data) in
            Self.recorded.append(request)
            let index = min(Self.recorded.count - 1, Self.responses.count - 1)
            return Self.responses[index]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// What the instance's answer reads as.
@MainActor
@Suite(.serialized) struct ConciergePageWireTests {
    private func backend() -> LiveBackend {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConciergeWireRecorder.self]
        return LiveBackend(client: APIClient(origin: URL(string: "http://127.0.0.1:4141")!, token: { "t" }, configuration: configuration))
    }

    private func wire(_ id: String, role: String = "assistant", at: String = "2026-11-09T10:00:00Z", thread: String? = nil, read: Bool? = nil) -> [String: Any] {
        var message: [String: Any] = ["id": id, "sessionId": "s", "role": role, "content": "[{\"type\":\"text\",\"content\":\"\(id)\"}]", "createdAt": at]
        if let thread { message["chatThreadId"] = thread }
        if let read { message["read"] = read }
        return message
    }

    private var answer: [String: Any] {
        [
            "type": "concierge",
            "mainLine": [
                ["message": wire("r", role: "user", at: "2026-11-09T10:00:00Z", thread: "r", read: true),
                 "thread": ["replyCount": 5, "unreadCount": 2, "latestReply": wire("a5", at: "2026-11-09T10:05:00Z", thread: "r", read: false), "unknownField": ["x": 1]]],
                ["message": wire("x", at: "2026-11-09T10:06:00Z", thread: "x"), "thread": NSNull()],
            ],
            "outside": [["root": "old", "title": "Book a table", "replyCount": 3, "unreadCount": 1, "latestUnread": wire("o1", at: "2026-11-08T09:00:00Z", thread: "old", read: false), "extra": true]],
            "traces": [["id": "t1", "sessionId": "s", "role": "trace", "content": "[]", "createdAt": "2026-11-09T10:00:01Z", "turnId": "turn-1"]],
            "nextCursor": "cursor-1", "hasMore": true, "layout": NSNull(), "someNewField": ["a": 1],
        ]
    }

    @Test func aPageAsksForMainLineMessagesAndReadsItsSummaries() async throws {
        ConciergeWireRecorder.reset([(200, answer)])
        let page = try await backend().conciergeMessages(sessionId: "chat-1", before: nil, limit: 40, through: nil)
        let request = try #require(ConciergeWireRecorder.requests.last)
        #expect(request.url?.path == "/api/chat/sessions/chat-1/messages")
        #expect(ConciergeWireRecorder.query(request) == ["type": "concierge", "limit": "40"])
        let concierge = try #require(page.concierge)
        // The main line, the newest reply of each thread, the waiting reply and the traces, once each.
        #expect(page.messages.map(\.id) == ["r", "a5", "x", "o1", "t1"])
        #expect(concierge.body.map(\.id) == ["r", "a5", "x"])
        #expect(page.nextCursor == "cursor-1")
        let thread = try #require(concierge.summaries["r"])
        #expect(thread.replyCount == 5 && thread.unreadCount == 2 && thread.latest.id == "a5" && thread.unreadAt > 0)
        #expect(concierge.summaries["x"] == nil)
        // A thread that waits outside the page: its newest unread reply, its counts and its name.
        let waiting = try #require(concierge.summaries["old"])
        #expect(waiting.replyCount == 3 && waiting.unreadCount == 1 && waiting.latest.id == "o1")
        #expect(concierge.titles == ["old": "Book a table"])
        #expect(concierge.oldestAt == RomeDate.parse("2026-11-09T10:00:00Z"))
        #expect(concierge.root == nil)
    }

    @Test func anOlderPageSendsItsCursorAndAThroughReadItsKey() async throws {
        ConciergeWireRecorder.reset([(200, ["mainLine": [], "outside": [], "nextCursor": NSNull()])])
        let page = try await backend().conciergeMessages(sessionId: "chat-1", before: "a b/c==", limit: 40, through: "m 1")
        let query = ConciergeWireRecorder.query(try #require(ConciergeWireRecorder.requests.last))
        #expect(query == ["type": "concierge", "limit": "40", "before": "a b/c==", "through": "m 1"])
        #expect(page.concierge != nil && page.messages.isEmpty && page.nextCursor == nil)
    }

    /// Every field the instance may leave out is optional.
    @Test func missingFieldsAreOptional() async throws {
        ConciergeWireRecorder.reset([(200, [
            "mainLine": [
                ["message": wire("r", role: "user", thread: "r"), "thread": ["latestReply": wire("a1", thread: "r")]],
                ["message": wire("q", role: "user", thread: "q"), "thread": [String: Any]()],
            ],
        ])])
        let page = try await backend().conciergeMessages(sessionId: "chat-1", before: nil, limit: 40, through: nil)
        let concierge = try #require(page.concierge)
        #expect(page.messages.map(\.id) == ["r", "a1", "q"] && page.messages.allSatisfy { $0.read == nil })
        #expect(concierge.summaries["r"]?.replyCount == 0 && concierge.summaries["r"]?.unreadCount == 0)
        #expect(concierge.summaries["q"] == nil && concierge.titles.isEmpty && page.nextCursor == nil)
    }

    @Test func oneThreadReadWholeHasItsRootAndItsReplies() async throws {
        ConciergeWireRecorder.reset([(200, [
            "mainLine": [["message": wire("r", role: "user", thread: "r"), "thread": [
                "replyCount": 2, "unreadCount": 1, "latestReply": wire("a2", at: "2026-11-09T10:02:00Z", thread: "r", read: false),
                "replies": [wire("a1", at: "2026-11-09T10:01:00Z", thread: "r", read: true), wire("a2", at: "2026-11-09T10:02:00Z", thread: "r", read: false)],
            ]]],
            "outside": [], "traces": [], "nextCursor": NSNull(),
        ])])
        let page = try await backend().conciergeThread(sessionId: "chat-1", key: "a2")
        let query = ConciergeWireRecorder.query(try #require(ConciergeWireRecorder.requests.last))
        #expect(query == ["type": "concierge", "thread": "a2"])
        #expect(page.messages.map(\.id) == ["r", "a1", "a2"] && page.concierge?.root == "r")
        // A thread the chat does not hold comes back with no messages.
        ConciergeWireRecorder.reset([(200, ["mainLine": [], "outside": [], "traces": [], "nextCursor": NSNull()])])
        let none = try await backend().conciergeThread(sessionId: "chat-1", key: "gone")
        #expect(none.messages.isEmpty && none.concierge?.root == nil)
    }

    /// An instance before the mode ignores `type` and answers a turn page: the answer has no
    /// `concierge`, and the caller reads the chat the way it did.
    @Test func aTurnPageIsReadAsOne() async throws {
        let turn: [String: Any] = ["messages": [wire("m1", role: "user"), wire("m2")], "nextCursor": "turn-cursor"]
        ConciergeWireRecorder.reset([(200, turn)])
        let page = try await backend().conciergeMessages(sessionId: "chat-1", before: nil, limit: 40, through: nil)
        #expect(page.concierge == nil && page.messages.map(\.id) == ["m1", "m2"] && page.nextCursor == "turn-cursor")
        ConciergeWireRecorder.reset([(200, turn)])
        let thread = try await backend().conciergeThread(sessionId: "chat-1", key: "m1")
        #expect(thread.concierge == nil && thread.messages.count == 2)
    }

    /// A chat that is no Concierge chat refuses, and is read by turns, `limit` of them.
    @Test func notConciergeFallsBackToTurns() async throws {
        let refusal: [String: Any] = ["error": "Not a Concierge chat", "code": "not_concierge"]
        ConciergeWireRecorder.reset([(400, refusal), (200, ["messages": [wire("m1")], "nextCursor": NSNull()])])
        let page = try await backend().conciergeMessages(sessionId: "chat-1", before: nil, limit: 40, through: nil)
        #expect(page.concierge == nil && page.messages.map(\.id) == ["m1"])
        let requests = ConciergeWireRecorder.requests
        #expect(requests.count == 2)
        #expect(ConciergeWireRecorder.query(requests[0])["type"] == "concierge")
        #expect(ConciergeWireRecorder.query(requests[1]) == ["limit": "40"])
        // Through a message, the turn read reaches it.
        ConciergeWireRecorder.reset([(400, refusal), (200, ["messages": [], "nextCursor": NSNull()])])
        _ = try await backend().conciergeMessages(sessionId: "chat-1", before: nil, limit: 40, through: "m9")
        #expect(ConciergeWireRecorder.query(ConciergeWireRecorder.requests[1]) == ["limit": "40", "through": "m9"])
        // Any other refusal is an error, not a fallback.
        ConciergeWireRecorder.reset([(400, ["error": "Invalid before cursor"])])
        await #expect(throws: APIError.self) { _ = try await backend().conciergeMessages(sessionId: "chat-1", before: "x", limit: 40, through: nil) }
        #expect(ConciergeWireRecorder.requests.count == 1)
    }
}

/// A Concierge chat paged by main-line messages, in a store.
@MainActor
@Suite struct ConciergePagedStoreTests {
    private func chat(_ backend: FakeBackend) async -> TranscriptStore {
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<100 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private let root = cmsg("r", role: "user", "plan the trip", at: 0, read: true)
    private let a5 = cmsg("a5", "done", at: 50, thread: "r", read: false)

    /// The stack reads the instance's numbers, not the replies that are loaded.
    private func paged(_ backend: FakeBackend, total: Int = 5, unread: Int = 2) {
        backend.conciergePage = { [root, a5] _, _, _ in
            page([root, cmsg("x", "weather?", at: 60, read: true)], threads: ["r": summary(a5, total: total, unread: unread)])
        }
    }

    @Test func theNewestPageIsReadByMainLineMessages() async {
        let backend = FakeBackend()
        paged(backend)
        let store = await chat(backend)
        #expect(store.conciergePaged)
        #expect(backend.conciergeReads.count == 1 && backend.conciergeReads[0].before == nil && backend.conciergeReads[0].limit == 40 && backend.conciergeReads[0].through == nil)
        // The reply that came with its root is not on the main line; the stack says 5, 2 of them unread.
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
        let stack = store.threads.stacks["r"]
        #expect(stack?.total == 5 && stack?.unread == 2 && stack?.preview == "done" && stack?.layered == true)
        #expect(store.info(for: .userText(id: "r:0", text: "plan the trip", pending: nil)).stack == stack)
        #expect(store.pills == ["r"])
    }

    @Test func aChatThatIsNotPagedKeepsTheOldWay() async {
        let backend = FakeBackend()
        backend.stored = [cmsg("r", role: "user", "plan", at: 0), cmsg("a1", at: 10, thread: "r", read: false), cmsg("a2", at: 20, thread: "r", read: true)]
        let store = await chat(backend)
        // An instance before the mode answers a turn page: the stacks count the replies loaded.
        #expect(!store.conciergePaged && backend.conciergeReads.count == 1)
        #expect(store.threads.stacks["r"]?.total == 2 && store.threads.stacks["r"]?.unread == 1)
        // A page that is turn-shaped from a paged call says the same.
        let task = TranscriptStore(sessionId: "t1", kind: .task, backend: backend)
        await task.reload()
        #expect(!task.conciergePaged && backend.conciergeReads.count == 1)
    }

    /// Older pages come with the cursor the page gave, and a turn cursor is never mixed with it.
    @Test func olderPagesUseTheCursorOfTheirMode() async {
        let backend = FakeBackend()
        backend.conciergePage = { before, _, _ in
            before == nil ? page([cmsg("m2", at: 20, read: true)], next: "cursor-A") : page([cmsg("m1", at: 10, read: true)], next: nil)
        }
        let store = await chat(backend)
        #expect(store.hasOlder)
        await store.loadOlder()
        #expect(backend.conciergeReads.map(\.before) == [nil, "cursor-A"] && backend.conciergeReads.map(\.limit) == [40, 40])
        #expect(store.rows.compactMap(\.ownMessageId) == ["m1", "m2"] && !store.hasOlder)
        // A chat read by turns pages by turns.
        let old = FakeBackend()
        old.stored = (0..<50).map { cmsg("m\($0)", role: "user", at: TimeInterval($0), turn: "t\($0)") }
        let turned = await chat(old)
        await turned.loadOlder()
        #expect(old.conciergeReads.count == 1 && old.pageLimits == [40, 40] && turned.messages.count == 50)
    }

    // MARK: Summaries

    /// A reply that comes live adds one, once; a copy of it adds nothing.
    @Test func aLiveReplyCountsOnce() async {
        let backend = FakeBackend()
        paged(backend)
        let store = await chat(backend)
        let live = cmsg("a6", "one more", at: 70, thread: "r", read: false)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(live))
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(live))
        var stack = store.threads.stacks["r"]
        #expect(stack?.total == 6 && stack?.unread == 3 && stack?.lastId == "a6" && stack?.preview == "one more")
        // The reply the page held counts no more when it comes again.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(a5))
        stack = store.threads.stacks["r"]
        #expect(stack?.total == 6)
        // The reply is no message of the main line.
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
        // A reply no automation said only: an automated one changes nothing.
        var automated = cmsg("auto", role: "user", "routine", at: 80, thread: "r", read: false)
        automated.sender = MessageSender(kind: "automated", sourceType: "routine", name: "Daily", onBehalfOf: nil)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(automated))
        #expect(store.threads.stacks["r"]?.total == 6)
        // A reply to a thread the chat holds no summary of starts one.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(cmsg("b1", "hello", at: 90, thread: "x", read: false)))
        #expect(store.threads.stacks["x"]?.total == 1 && store.threads.stacks["x"]?.unread == 1)
    }

    /// The owner's reply counts once the instance has taken it, and its stored copy no more.
    @Test func theOwnersReplyCountsOnlyOnceTheServerTookIt() async {
        let backend = FakeBackend()
        paged(backend)
        let store = await chat(backend)
        store.reply(to: "x")
        let target = store.composerThread
        // Turned down: the stack is as it was.
        #expect(store.send("and tomorrow?", fromComposer: true, thread: target))
        store.composerSent()
        await settle { store.pending.first?.state == .failed(.unreachable) }
        #expect(store.threads.stacks["x"] == nil && store.threads.stacks["r"]?.total == 5)
        // Taken: one more in the thread of the message replied to, and the stack's line is the reply.
        backend.sendSucceeds = true
        store.retry(store.pending[0].id)
        await settle { store.threads.stacks["x"] != nil }
        let stack = store.threads.stacks["x"]
        #expect(stack?.total == 1 && stack?.unread == 0 && stack?.preview == "and tomorrow?")
        // The instance's copy, read later, is not counted again, whichever way it arrives.
        let stored = cmsg(store.pending[0].id, role: "user", "and tomorrow?", at: 100, thread: "x", read: true)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(stored))
        #expect(store.threads.stacks["x"]?.total == 1)
    }

    /// Marking a thread read zeroes its unread count, here and on the instance.
    @Test func markingAThreadReadZeroesItsUnreadCount() async {
        let backend = FakeBackend()
        paged(backend)
        let a1 = cmsg("a1", "first", at: 10, thread: "r", read: false)
        backend.conciergeThreads["r"] = whole(root, [a1, cmsg("a2", at: 20, thread: "r", read: true), a5])
        let store = await chat(backend)
        #expect(store.threads.stacks["r"]?.unread == 2)
        store.openChatThread("r")
        await settle { store.thread != nil }
        #expect(store.thread?.root == "r")
        #expect(store.threads.stacks["r"]?.unread == 0 && store.threads.stacks["r"]?.total == 3)
        await settle { !backend.markedRead.isEmpty }
        #expect(Set(backend.markedRead.first?.ids ?? []) == ["a1", "a5"])
        #expect(store.pills.isEmpty)
    }

    /// A thread read whole sets its summary from the replies it brought.
    @Test func aWholeThreadRecomputesItsSummary() async {
        let backend = FakeBackend()
        paged(backend, total: 9, unread: 7)
        let replies = [cmsg("a1", "one", at: 10, thread: "r", read: true), cmsg("a2", "two", at: 20, thread: "r", read: false), cmsg("u1", role: "user", "me", at: 30, thread: "r", read: true)]
        backend.conciergeThreads["r"] = whole(root, replies)
        let store = await chat(backend)
        let key = await store.ensureThreadWhole("r")
        #expect(key == "r")
        // 3 replies, 1 unread, the owner's the newest: not 9 and 7.
        let stack = store.threads.stacks["r"]
        #expect(stack?.total == 3 && stack?.unread == 1 && stack?.lastId == "u1")
        #expect(backend.conciergeThreadReads == ["r"])
    }

    // MARK: Reading a thread whole

    @Test func aThreadIsReadWholeTheFirstTimeItOpens() async {
        let backend = FakeBackend()
        paged(backend)
        backend.conciergeThreads["r"] = whole(root, [cmsg("a1", at: 10, thread: "r", read: true), a5])
        let store = await chat(backend)
        // Nothing opens before it is read, and the read names the root pressed.
        store.openChatThread("r")
        #expect(store.thread == nil)
        await settle { store.thread != nil }
        #expect(backend.conciergeThreadReads == ["r"] && store.thread?.root == "r")
        #expect(store.thread?.messages.map(\.id) == ["r", "a1", "a5"])
        // Closed and opened again: it is whole already.
        store.closeThread()
        store.openChatThread("r")
        #expect(store.thread != nil && backend.conciergeThreadReads == ["r"])
        // A live reply keeps it whole.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(cmsg("a6", "more", at: 70, thread: "r", read: false)))
        #expect(store.thread?.messages.map(\.id) == ["r", "a1", "a5", "a6"])
    }

    /// A thread that cannot be read does not open, and the chat says so.
    @Test func aThreadThatCannotBeReadDoesNotOpen() async {
        let backend = FakeBackend()
        paged(backend)
        let store = await chat(backend)
        backend.conciergeThreadError = .network
        store.openChatThread("r")
        await settle { store.notice != nil }
        #expect(store.thread == nil && store.notice == "Couldn't open the thread")
        // Not held by the instance: the same.
        backend.conciergeThreadError = nil
        backend.conciergeThreads["r"] = MessagePage(messages: [], nextCursor: nil, concierge: ConciergeAnswer(body: [], oldestAt: nil, summaries: [:], titles: [:], root: nil))
        store.openChatThread("r")
        await settle { backend.conciergeThreadReads.count == 2 }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(store.thread == nil)
    }

    /// Reply from the main line opens the thread, read whole, once the instance took the reply.
    @Test func aReplyFromTheMainLineOpensItsThreadWhole() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        paged(backend)
        let sent = cmsg("in-1", role: "user", "and tomorrow?", at: 100, thread: "x", read: true)
        backend.conciergeThreads["x"] = whole(cmsg("x", "weather?", at: 60, read: true), [sent])
        let store = await chat(backend)
        store.reply(to: "x")
        #expect(store.send("and tomorrow?", fromComposer: true, thread: store.composerThread))
        store.composerSent()
        await settle { store.thread != nil }
        #expect(store.thread?.root == "x" && backend.conciergeThreadReads == ["x"])
    }

    /// A quote in a thread's reply, a link and Respond all read the thread the same way.
    @Test func aJumpToAHiddenReplyReadsItsThread() async {
        let backend = FakeBackend()
        paged(backend)
        backend.conciergeThreads["a5"] = whole(root, [cmsg("a1", at: 10, thread: "r", read: true), a5])
        let store = await chat(backend)
        // The reply is held (the page's newest) and stacked: its thread opens on it.
        store.jump(to: "a5")
        await settle { store.thread != nil }
        #expect(store.thread?.anchor.id == "a5" && store.thread?.root == "r")
        #expect(backend.conciergeThreadReads == ["a5"])
        store.closeThread()
        // A card not held is read with its thread and then opened.
        let card = cmsg("c1", at: 5, thread: "r", read: true, parts: [["type": "task_chat", "chatId": "t1", "title": "Flights", "show": "ask"]])
        backend.conciergeThreads["c1"] = whole(root, [card, a5])
        await store.revealCard("c1")
        await settle { store.thread != nil }
        #expect(store.thread?.root == "r" && backend.conciergeThreadReads.contains("c1"))
    }

    // MARK: Pills

    /// A thread that waits outside the page has its pill, named by the page, and no stack to draw.
    @Test func aPillForAnUnloadedRootReadsThroughToItFirst() async throws {
        let backend = FakeBackend()
        let old = cmsg("old", role: "user", "book a table", at: 1, read: true)
        let o1 = cmsg("o1", "found one", at: 5, thread: "old", read: false)
        backend.conciergePage = { before, _, through in
            if through == "old" {
                // The read down to the root: the root and its context, with the thread's summary.
                return page([old, cmsg("m0", at: 2, read: true)], threads: ["old": summary(o1, total: 3, unread: 1)], next: nil)
            }
            return page([cmsg("m1", at: 20, read: true)], threads: ["old": summary(o1, total: 3, unread: 1)], titles: ["old": "Book a table"], next: "cursor-A")
        }
        backend.conciergeThreads["old"] = whole(old, [cmsg("o0", at: 3, thread: "old", read: false), cmsg("o1b", at: 4, thread: "old", read: false), o1])
        let store = await chat(backend)
        // A pill, named by the page's `outside`, and nothing on the main line for the reply.
        #expect(store.pills == ["old"] && store.threadName("old") == "Book a table")
        #expect(store.rows.compactMap(\.ownMessageId) == ["m1"])
        store.showStack("old")
        await settle { store.jumps == 1 }
        // One read down to the root (through it, from the cursor the page gave), then the thread whole.
        #expect(backend.conciergeReads.last?.through == "old" && backend.conciergeReads.last?.before == "cursor-A")
        #expect(backend.conciergeThreadReads == ["old"])
        #expect(store.message("old") != nil)
        #expect(store.jumpTarget == store.stackHosts["old"] && store.tintedStack == "old" && store.thread == nil)
        // The thread was read whole before it was marked read: every unread reply, and the pill goes.
        await settle { !backend.markedRead.isEmpty }
        #expect(Set(backend.markedRead.first?.ids ?? []) == ["o0", "o1b", "o1"])
        #expect(store.pills.isEmpty && store.threads.stacks["old"]?.unread == 0)
    }

    @Test func aPillThatCannotBeReadSaysSoAndKeepsItself() async {
        let backend = FakeBackend()
        let o1 = cmsg("o1", "found one", at: 5, thread: "old", read: false)
        backend.conciergePage = { _, _, _ in page([cmsg("m1", at: 20, read: true)], threads: ["old": summary(o1, total: 3, unread: 1)], next: nil) }
        backend.conciergeThreadError = .network
        let store = await chat(backend)
        store.showStack("old")
        await settle { store.notice != nil }
        #expect(store.notice == "Couldn't open the thread" && store.jumps == 0 && store.pills == ["old"])
    }

    // MARK: A gap in the live connection

    /// A resync reads the loaded range again in one request and replaces it.
    @Test func aResyncReadsTheLoadedRangeAgainAndReplacesIt() async {
        let backend = FakeBackend()
        let m1 = cmsg("m1", "old one", at: 10, read: true)
        let m2 = cmsg("m2", "gone later", at: 20, read: true)
        let late = cmsg("n1", "late reply", at: 31, thread: "m1", read: false)
        backend.conciergePage = { before, _, through in
            if through != nil { return page([m1, cmsg("m3", "new", at: 30, read: true)], threads: ["m1": summary(late, total: 4, unread: 2)], next: "cursor-B") }
            return before == nil ? page([m2, cmsg("m3", "new", at: 30, read: true)], next: "cursor-A") : page([m1], next: nil)
        }
        backend.conciergeThreads["m1"] = whole(m1, [cmsg("n0", "first reply", at: 11, thread: "m1", read: true)])
        let store = await chat(backend)
        await store.loadOlder()
        #expect(store.rows.compactMap(\.ownMessageId) == ["m1", "m2", "m3"])
        // A thread was read whole.
        _ = await store.ensureThreadWhole("m1")
        #expect(store.threads.stacks["m1"]?.total == 1)
        // The connection came back.
        await store.reload(resync: true)
        // One read, through the oldest main-line message; its answer is the loaded range: a message it lacks is gone.
        #expect(backend.conciergeReads.last?.through == "m1" && backend.conciergeReads.last?.before == nil)
        #expect(store.rows.compactMap(\.ownMessageId) == ["m1", "m3"])
        // Every summary is read again.
        #expect(store.threads.stacks["m1"]?.total == 4 && store.threads.stacks["m1"]?.unread == 2)
        // What was read whole is forgotten: the thread is read again when it opens.
        store.openChatThread("m1")
        await settle { store.thread != nil }
        #expect(backend.conciergeThreadReads == ["m1", "m1"])
        // The older cursor is the answer's.
        #expect(store.hasOlder)
        await store.loadOlder()
        #expect(backend.conciergeReads.last?.before == "cursor-B")
    }

    @Test func aResyncReadsTheOpenThreadAgain() async {
        let backend = FakeBackend()
        paged(backend)
        backend.conciergeThreads["r"] = whole(root, [cmsg("a1", at: 10, thread: "r", read: true), a5])
        let store = await chat(backend)
        store.openChatThread("r")
        await settle { store.thread != nil }
        backend.conciergeThreads["r"] = whole(root, [cmsg("a1", at: 10, thread: "r", read: true), a5, cmsg("a6", "while away", at: 70, thread: "r", read: false)])
        backend.conciergePage = { [root] _, _, _ in
            // The loaded range's answer: the root with its newest reply.
            page([root], threads: ["r": summary(cmsg("a6", "while away", at: 70, thread: "r", read: false), total: 3, unread: 1)], next: nil)
        }
        await store.reload(resync: true)
        await settle { backend.conciergeThreadReads.count == 2 }
        #expect(backend.conciergeThreadReads == ["r", "r"])
        await settle { store.thread?.messages.count == 4 }
        #expect(store.thread?.messages.map(\.id) == ["r", "a1", "a5", "a6"])
    }

    // MARK: Share

    /// A share is of whole turns: the loaded range is read again by turns first, and by main-line messages after.
    @Test func aShareReadsTheLoadedRangeByTurns() async {
        let backend = FakeBackend()
        paged(backend)
        backend.stored = [root, cmsg("a1", at: 10, thread: "r", read: true), a5, cmsg("x", "weather?", at: 60, read: true)]
        let store = await chat(backend)
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
        store.share.begin(turn: nil)
        await settle { !backend.throughReads.isEmpty }
        #expect(backend.throughReads == ["r"])
        // The picker shows every message, replies included.
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "a1", "a5", "x"])
        let reads = backend.conciergeReads.count
        store.share.cancel()
        await settle { backend.conciergeReads.count > reads }
        #expect(backend.conciergeReads.last?.through == "r")
        await settle { store.rows.compactMap(\.ownMessageId) == ["r", "x"] }
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
    }

    @Test func aShareThatCannotReadTheRangeEnds() async {
        let backend = FakeBackend()
        paged(backend)
        let store = await chat(backend)
        backend.messagesError = .network
        store.share.begin(turn: nil)
        await settle { !store.share.isSelecting }
        #expect(!store.share.isSelecting && store.notice == "Couldn't load the chat to share")
    }
}

import Foundation
import Testing
import UIKit
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, thread: String? = nil, title: String? = nil, knows: Bool = true, session: String = "concierge", parts: [[String: Any]]? = nil) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: parts ?? [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: knows, chatThreadTitle: title)
}

/// What the wire says about chat threads, and what an older instance leaves out.
@MainActor
@Suite struct ChatThreadWireTests {
    private func decode(_ json: String) throws -> ChatMessage {
        try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
    }

    @Test func aMessageSaysItsRoot() throws {
        let placed = try decode(#"{"id":"m2","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":"m1"}"#)
        #expect(placed.chatThreadId == "m1" && placed.knowsThreads && placed.threadRoot == "m1")
        // A message that replies to nothing is its own root.
        let alone = try decode(#"{"id":"m3","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":"m3"}"#)
        #expect(alone.chatThreadId == "m3" && alone.knowsThreads && alone.threadRoot == "m3")
        let unsaid = try decode(#"{"id":"m5","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":null}"#)
        #expect(unsaid.chatThreadId == nil && unsaid.knowsThreads && unsaid.threadRoot == "m5")
        // An instance before chat threads leaves the field out.
        let older = try decode(#"{"id":"m4","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z"}"#)
        #expect(older.chatThreadId == nil && !older.knowsThreads)
    }

    /// A kept copy reads back the same, null included.
    @Test func aKeptMessageKeepsItsThread() throws {
        for kept in [message("a", at: 0, thread: "r"), message("b", at: 0, thread: nil, knows: true), message("c", at: 0, thread: nil, knows: false)] {
            let back = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(kept))
            #expect(back == kept)
        }
    }

    /// A message arrives with its root: no event places it later.
    @Test func noPlacementEventIsRead() {
        #expect(LiveEventsSocket.decode(name: "message_chat_thread", data: .object(["sessionId": .string("s"), "messageId": .string("m2"), "chatThreadId": .string("m1")])) == nil)
        #expect(LiveEventsSocket.decode(name: "chat_thread_retired", data: .object(["sessionId": .string("s"), "chatThreadId": .string("m1")])) == nil)
    }

    /// A message carries the name of a thread a task started in, and a kept copy keeps it.
    @Test func aMessageCarriesItsTasksTitle() throws {
        let placed = try decode(#"{"id":"m2","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":"m1","chatThreadTitle":"Book a table"}"#)
        #expect(placed.chatThreadTitle == "Book a table")
        let back = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(placed))
        #expect(back == placed)
    }

    /// A reply names the message it quotes, and the thread view it was
    /// sent from when one was open.
    @Test func aReplyNamesItsMessageAndThread() {
        #expect(ThreadTarget(messageId: "m2", instanceKnowsThreads: true, quote: true).body == ["replyToMessageId": .string("m2")])
        #expect(ThreadTarget(messageId: "m2", instanceKnowsThreads: true, quote: true, thread: "m1").body == ["replyToMessageId": .string("m2"), "chatThread": .string("m1")])
    }
}

/// Threads, names and quotes in the transcript (docs/domains/chats.md#chat-thread).
@MainActor
@Suite struct ThreadQuoteTests {
    private func rows(_ messages: [ChatMessage]) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showNotices: true))
    }

    private func quote(of id: String, _ original: String, author: String = "guardian", text: String = "plan") -> [[String: Any]] {
        [["type": "reply_to", "messageId": original, "author": author, "text": text], ["type": "text", "content": "said \(id)"]]
    }

    /// A message of a thread of more than one is in it, by its root. One that
    /// replies to nothing and has no reply is in none.
    @Test func aMessageIsInTheThreadOfItsRoot() {
        let alone = [message("r", role: "user", "plan", at: 0, thread: "r"), message("x", at: 1, thread: "x")]
        #expect(TranscriptBuilder.threadRoots(alone).isEmpty)
        // The root is in its thread once a loaded message replies in it, whether or not the root was sent with its own key.
        let grown = [message("r", role: "user", "plan", at: 0, thread: "r"), message("a1", at: 1, thread: "r"), message("x", at: 2, thread: "x")]
        #expect(TranscriptBuilder.threadRoots(grown) == ["r": "r", "a1": "r"])
        // A reply whose root is not loaded is in the thread.
        #expect(TranscriptBuilder.threadRoots([message("a1", at: 1, thread: "r")]) == ["a1": "r"])
        // An instance before chat threads names none.
        #expect(TranscriptBuilder.threadRoots([message("a", at: 0, thread: nil, knows: false)]).isEmpty)
    }

    /// A thread a task started in is named by the title its messages carry,
    /// any other by the start of its root's text.
    @Test func aThreadIsNamedByItsTaskOrItsRoot() {
        let root = message("r", role: "user", "## Plan Kyoto\nthen the hotels", at: 0, thread: "r")
        let thread = [root, message("a1", at: 1, thread: "r"), message("x", role: "user", at: 2, thread: "x"), message("a2", at: 3, thread: "r")]
        #expect(TranscriptBuilder.threadTitles(thread) == ["r": "Plan Kyoto"])
        // Cut short with an ellipsis; a task's title wins; a root with no text, or not loaded, gives none.
        let long = message("r", role: "user", "Compare every ryokan along the Kamo river for the April trip please", at: 0)
        #expect(TranscriptBuilder.startOfText(long) == "Compare every ryokan along the Kamo river for the…")
        #expect(TranscriptBuilder.threadTitles([root, message("a1", at: 1, thread: "r", title: "Book")]) == ["r": "Book"])
        #expect(TranscriptBuilder.threadTitles([message("r", role: "user", "   ", at: 0, thread: "r"), message("a1", at: 1, thread: "r")]).isEmpty)
        #expect(TranscriptBuilder.threadTitles([message("a1", at: 1, thread: "r")]).isEmpty)
    }

    /// No row names a task under a message, whatever thread it is in. The
    /// source of a turn still shows, in the same place.
    @Test func noTaskLabelUnderAnyMessage() {
        let messages = [
            message("u", role: "user", "book a table", at: 0, thread: "u", title: "Book a table"),
            message("x", role: "user", "weather?", at: 5, thread: "x"),
            message("a1", "on it", at: 10, thread: "u", title: "Book a table"),
            message("a2", "done", at: 20, thread: "u", title: "Book a table"),
        ]
        let built = rows(messages)
        #expect(built.allSatisfy { if case .sourceLabel = $0 { return true } else { return !$0.id.hasPrefix("label-") } })
        #expect(built.filter { $0.id.hasPrefix("label-") }.isEmpty)
    }

    /// A reply that sits right under what it answers draws a rail and no quote
    /// text; one that does not draws its quote. Both are on the first bubble only.
    @Test func anAgentReplyShowsAQuoteOrARail() throws {
        let adjacent = [
            message("u", role: "user", "plan", at: 0, thread: "u"),
            message("a1", at: 1, thread: "u", parts: quote(of: "a1", "u") + [["type": "text", "content": "second bubble"]]),
        ]
        let infos = RowInfo.build(rows: rows(adjacent), messages: adjacent, pending: [], kind: .concierge)
        let first = try #require(infos["a1:1"])
        #expect(first.quote?.messageId == "u" && first.rail == .hook && first.quoteLeads)
        #expect(infos["a1:2"]?.quote == nil && infos["a1:2"]?.rail == nil)
        // With a message between, the reply shows its quote.
        let apart = [adjacent[0], message("x", at: 1, thread: "x"), adjacent[1]]
        let spaced = RowInfo.build(rows: rows(apart), messages: apart, pending: [], kind: .concierge)
        #expect(spaced["a1:1"]?.quote?.author == "guardian" && spaced["a1:1"]?.rail == nil)
    }

    /// A reply is adjacent to the message right above it, or to a reply of the
    /// same sender above it that answers the same message, which a line joins.
    @Test func adjacentRepliesAreJoinedByAHookOrALine() {
        let q = message("q", role: "user", "plan", at: 0, thread: "q")
        let a = message("a", at: 1, thread: "q", parts: quote(of: "a", "q"))
        let b = message("b", at: 2, thread: "q", parts: quote(of: "b", "q"))
        let c = message("c", at: 3, thread: "q", parts: quote(of: "c", "q"))
        #expect(TranscriptBuilder.replyJoins([q, a, b, c]) == ["a": .hook, "b": .line, "c": .line])
        // An owner reply to the agent's message above, and the agent's answer to that.
        let r = message("r", role: "user", "ok", at: 4, thread: "q", parts: quote(of: "r", "c"))
        let s = message("s", at: 5, thread: "q", parts: quote(of: "s", "r"))
        #expect(TranscriptBuilder.replyJoins([q, a, b, c, r, s])["r"] == .hook)
        #expect(TranscriptBuilder.replyJoins([q, a, b, c, r, s])["s"] == .hook)
        // Another sender's reply to the same message sits on the other side, so it is a hook.
        let other = message("o", role: "user", "me too", at: 2, thread: "q", parts: quote(of: "o", "q"))
        #expect(TranscriptBuilder.replyJoins([q, a, other])["o"] == .hook)
        // A message between, a trace aside, breaks adjacency; a message that replies to nothing has none.
        var trace = message("t", at: 1)
        trace.role = "trace"
        trace.content = "[]"
        #expect(TranscriptBuilder.replyJoins([q, trace, a])["a"] == .hook)
        #expect(TranscriptBuilder.replyJoins([q, message("x", at: 1), a])["a"] == nil)
        #expect(TranscriptBuilder.replyJoins([q, a])["q"] == nil)
    }

    /// A line spans the gap to the reply above only when that reply's row is
    /// the row right above; a time line between makes it a hook.
    @Test func aLineNeedsTheSiblingRightAbove() {
        let q = message("q", role: "user", "plan", at: 0, thread: "q")
        let a = message("a", at: 1, thread: "q", parts: quote(of: "a", "q"))
        let b = message("b", at: 2, thread: "q", parts: quote(of: "b", "q"))
        let close = [q, a, b]
        let near = RowInfo.build(rows: rows(close), messages: close, pending: [], kind: .concierge)
        #expect(near["a:1"]?.rail == .hook)
        #expect(near["b:1"]?.rail == .line(gap: 3))
        // An hour apart, the time line stands between them.
        let far = [q, a, message("b", at: 4000, thread: "q", parts: quote(of: "b", "q"))]
        #expect(RowInfo.build(rows: rows(far), messages: far, pending: [], kind: .concierge)["b:1"]?.rail == .hook)
    }

    /// A quote shows the first line of the message it quotes, as plain text.
    @Test func aQuoteShowsTheFirstLineOfTheOriginal() {
        func line(_ text: String) -> String { MessagePart.ReplyQuote(messageId: "m", author: "agent", name: nil, text: text).line }
        #expect(line("Yes, €200 minimum.\n\n> Back room: €200\n> Main room: none") == "Yes, €200 minimum.")
        #expect(line("## Plan Kyoto\nthen the hotels") == "Plan Kyoto")
        #expect(line("```py\nx = 1\n```") == "x = 1")
        #expect(line("  \n") == "")
    }

    /// A quote leads to the thread view of its reply, or to the original when
    /// the reply is alone, as one kept from before reply chains is.
    @Test func aQuoteLeadsToTheThreadOrTheOriginal() throws {
        let reply = message("a1", at: 1, thread: "u", parts: quote(of: "a1", "u"))
        let held = [message("u", role: "user", "plan", at: 0, thread: "u"), reply]
        #expect(RowInfo.build(rows: rows(held), messages: held, pending: [], kind: .concierge)["a1:1"]?.quoteLeads == true)
        // A quote kept from before: the reply is its own root, so it can only go to the original.
        let legacy = message("a1", at: 1, thread: "a1", parts: quote(of: "a1", "u"))
        let leads = { (messages: [ChatMessage]) in RowInfo.build(rows: self.rows(messages), messages: messages, pending: [], kind: .concierge)["a1:1"]?.quoteLeads }
        #expect(leads([message("u", role: "user", "plan", at: 0, thread: "u"), legacy]) == true)
        #expect(leads([legacy]) == false)
    }

    /// A source label stays under a reply in a thread.
    @Test func theSourceLabelStaysUnderAReplyInAThread() {
        var routine = message("r", at: 1, thread: "u")
        routine.turnId = "t-r"
        var trace = message("trace", at: 1)
        trace.role = "trace"
        trace.turnId = "t-r"
        trace.content = "[]"
        trace.traceSummary = TraceSummary(totalSteps: 0, automatedInput: .init(type: "routine", name: "Daily summary"))
        let built = rows([message("u", role: "user", "plan", at: 0, thread: "u"), trace, routine])
        #expect(built.contains { if case .sourceLabel = $0 { return true } else { return false } })
    }
}

/// A chat thread open over its chat.
@MainActor
@Suite struct ThreadStoreTests {
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage]) async -> TranscriptStore {
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        // Started, so the chat hears events as it does on screen.
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<50 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func anInstanceWithThreadsReadsTheWholeThread() async {
        let backend = FakeBackend()
        let older = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        // The chat holds only the reply; the read brings the rest.
        let store = await chat(backend, [reply])
        backend.threads["r"] = [older, reply]
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.messages.count == 2 }
        // The read names the thread by its root, whichever message opened it.
        #expect(backend.threadReads == ["r"])
        #expect(thread.messages.map(\.id) == ["r", "a1"])
        #expect(thread.root == "r")
        #expect(store.composerThread?.thread == "r")
        store.closeThread()
        #expect(store.thread == nil)
    }

    /// A root only the thread read brought follows its status and reaction live.
    @Test func aRootOnlyTheReadBroughtFollowsItsBadge() async {
        let backend = FakeBackend()
        let root = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        let store = await chat(backend, [reply])
        backend.threads["r"] = [root, reply]
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.messages.count == 2 }
        let row = { thread.rows.first { $0.messageId == "r" }! }
        backend.bus.emit(LiveTopic.chat("concierge"), .status(sessionId: "concierge", messageId: "r", status: "working"))
        #expect(thread.info(for: row()).mark?.emoji == "👀")
        backend.bus.emit(LiveTopic.chat("concierge"), .reaction(sessionId: "concierge", messageId: "r", reaction: "👍"))
        backend.bus.emit(LiveTopic.chat("concierge"), .status(sessionId: "concierge", messageId: "r", status: nil))
        #expect(thread.info(for: row()).mark?.emoji == "👍")
    }

    /// An older instance has no thread read: the message shows alone.
    @Test func anOlderInstanceShowsTheMessageAlone() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("x", role: "user", "q", at: 0, knows: false), message("a", "answer", at: 10, knows: false)])
        store.openThread(at: "a")
        let thread = store.thread!
        await settle { thread.loaded }
        #expect(backend.threadReads.isEmpty)
        #expect(thread.messages.map(\.id) == ["a"])
    }

    @Test func aFailedReadKeepsWhatTheChatHolds() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("r", role: "user", "plan", at: 0, thread: "r"), message("a1", "sure", at: 10, thread: "r"), message("o", "other", at: 20)])
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.loaded }
        #expect(thread.messages.map(\.id) == ["r", "a1"])
    }

    /// New messages of the thread show live, with no event of their own;
    /// one in another thread does not.
    @Test func theThreadFollowsTheChat() async {
        let backend = FakeBackend()
        let root = message("r", role: "user", "plan", at: 0, thread: "r")
        let reply = message("a1", "sure", at: 10, thread: "r")
        let store = await chat(backend, [root, reply])
        backend.threads["r"] = [root, reply]
        store.openThread(at: "r")
        let thread = store.thread!
        await settle { backend.threadReads.count == 1 }
        // A new reply in the thread, and one in another.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("a2", "more", at: 20, thread: "r")))
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("b", "elsewhere", at: 21, thread: "z")))
        #expect(thread.messages.map(\.id) == ["r", "a1", "a2"])
        // The guardian's reply arrives the same way.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("u", role: "user", "and then?", at: 30, thread: "r")))
        #expect(thread.messages.map(\.id) == ["r", "a1", "a2", "u"])
        store.closeThread()
    }

    /// A send from the thread view replies to the labelled message in its
    /// thread, and a retry keeps it.
    @Test func aSendFromTheThreadGoesToIt() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("a1", "sure", at: 10, thread: "r", title: "T")])
        store.openThread(at: "a1")
        let target = store.composerThread!
        // The send names the thread by its root.
        #expect(target == ThreadTarget(messageId: "a1", instanceKnowsThreads: true, quote: true, thread: "r", bare: true))
        #expect(store.send("and then?", thread: target))
        await settle { !backend.sentThreads.isEmpty }
        #expect(backend.sentThreads == [target])
        // It failed: Retry goes to the same thread.
        await settle { store.pending.first?.state == .failed(.unreachable) }
        backend.sendSucceeds = true
        store.retry(store.pending[0].id)
        await settle { backend.sentThreads.count == 2 }
        #expect(backend.sentThreads == [target, target])
        // A send from the chat itself names no thread.
        store.closeThread()
        #expect(store.send("new thing"))
        await settle { backend.sentThreads.count == 3 }
        #expect(backend.sentThreads.last == .some(nil))
    }

    /// The label opens the view for reading and tints its message; Reply
    /// inside keeps the view open and moves the reply; the reply bar's ✕
    /// closes both.
    @Test func replyInsideTheThreadViewKeepsItOpen() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("u", role: "user", at: 0, thread: "u", title: "T"), message("a1", "sure", at: 10, thread: "u", title: "T"), message("a2", "more", at: 20, thread: "u", title: "T")])
        store.openThread(at: "a2")
        #expect(store.thread != nil && store.tinted == "a2" && store.replies == 0)
        // Opened from its label: no reply bar.
        #expect(!store.showsQuoteBar)
        store.reply(to: "a1")
        #expect(store.thread != nil && store.replies == 1)
        // Reply inside goes to the thread, quoting no message, and its bar names the task.
        #expect(store.composerThread?.body == ["chatThread": .string("u")])
        #expect(store.showsQuoteBar && store.threadReplyTitle == "T" && store.quotedMessage == nil)
        store.cancelQuote()
        #expect(store.thread == nil && store.quote == nil && !store.showsQuoteBar && store.threadReplyTitle == nil)
    }

    /// Task chats have no chat threads.
    @Test func aTaskChatOpensNoThread() async {
        let backend = FakeBackend()
        backend.stored = [message("a", "done", at: 0, thread: "a", session: "t1")]
        let store = TranscriptStore(sessionId: "t1", kind: .task, backend: backend)
        await store.reload()
        store.openThread(at: "a")
        #expect(store.thread == nil)
    }
}

/// The main chat's header names the Concierge as the dashboard does.
@MainActor
@Suite struct AgentNameTests {
    @Test func theNameIsTrimmedAndBlankFallsBack() {
        #expect(AgentName.display("  Milo ") == "Milo")
        #expect(AgentName.display("   ") == nil)
        #expect(AgentName.display(nil) == nil)
    }

    @Test func aRenameIsHeardLive() {
        guard case .agentName(let name) = LiveEventsSocket.decode(name: "agent_name_changed", data: .object(["agentName": .string("Pebble")])) else {
            Issue.record("not read"); return
        }
        #expect(name == "Pebble")
    }

    /// An instance with no name set, or none readable, calls the Agent Rome:
    /// never "Chat", the screen's name, or "Concierge", the code's.
    @Test func withoutANameTheAgentIsRome() async {
        let workspace = Workspace(backend: FakeBackend(), instanceName: "T", host: "t", accountLabel: "t", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-agent-name-\(UUID().uuidString)/Drafts"), instance: "t"))
        #expect(workspace.agentName == nil)
        #expect(workspace.agentDisplayName == "Rome")
        workspace.debugSetAgentName("  ")
        #expect(workspace.agentDisplayName == "Rome")
        workspace.debugSetAgentName("Milo")
        #expect(workspace.agentDisplayName == "Milo")
        // The update copy says the same.
        #expect(UpdateCopy.agent(nil) == "Rome" && UpdateCopy.banner(UpdateCopy.agent(nil)) == "Rome has an update")
        workspace.stop()
    }

    @Test func theFallbackNameIsRome() {
        #expect(AgentName.shown(nil) == "Rome")
        #expect(AgentName.shown(" ") == "Rome")
        #expect(AgentName.shown(" Milo ") == "Milo")
    }
}

/// The "…" menu names the chat on one line.
@MainActor
@Suite struct MenuTitleTests {
    @Test func aLongNameIsCutAtTheEnd() {
        let font = UIFont.systemFont(ofSize: 13)
        let long = "家里装修：厨房翻新、浴室防水和客厅灯具的预算与师傅安排"
        let cut = MenuTitle.oneLine(long, width: 200, font: font)
        #expect(cut.hasSuffix("…"))
        #expect(long.hasPrefix(String(cut.dropLast())))
        #expect((cut as NSString).size(withAttributes: [.font: font]).width <= 200)
        #expect(MenuTitle.oneLine("Milo", width: 200, font: font) == "Milo")
    }
}

/// Reply opens the reply bar alone; the quote of a reply leads to the
/// thread view or to the original (docs/domains/chats.md#chat-thread).
@MainActor
@Suite struct QuoteReplyTests {
    private func chat(_ messages: [ChatMessage]) async -> TranscriptStore {
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func reply(_ id: String, to original: String, at seconds: TimeInterval, thread: String? = nil, title: String? = nil) -> ChatMessage {
        message(id, role: "user", at: seconds, thread: thread, title: title, parts: [
            ["type": "reply_to", "messageId": original, "author": "agent", "text": "sunny"],
            ["type": "text", "content": "and tomorrow?"],
        ])
    }

    @Test func replyOpensOnlyTheReplyBar() async {
        let store = await chat([message("q", role: "user", at: 0), message("a", "sunny", at: 10), message("b", at: 20, thread: "q", title: "T")])
        for id in ["a", "b"] {
            store.reply(to: id)
            #expect(store.thread == nil)
            #expect(store.quotedMessage?.id == id)
            #expect(store.composerThread?.body == ["replyToMessageId": .string(id)])
        }
        store.cancelQuote()
        #expect(store.composerThread == nil)
    }

    /// Only the Agent's text offers Reply: no card of any kind, open or folded.
    @Test func cardsOfferNoReply() {
        #expect(ConciergeRow.offersReply(.agentText(id: "a:0", text: "x", long: false, forwardedFrom: nil, position: .single)))
        #expect(!ConciergeRow.offersReply(.userText(id: "u:0", text: "x", pending: nil)))
        #expect(!ConciergeRow.offersReply(.taskCard(id: "c:0", chatId: "c", title: "T")))
        #expect(!ConciergeRow.offersReply(.taskAsk(id: "k:0", chatId: "c", title: "T", card: nil)))
        #expect(!ConciergeRow.offersReply(.webOnly(id: "w:0", kind: .unknown)))
    }

    /// The quote is read from its part, and shows nothing of its own.
    @Test func aReplyCarriesItsQuote() {
        let parts = reply("r", to: "a", at: 0).parts
        #expect(parts.compactMap(\.replyQuote) == [MessagePart.ReplyQuote(messageId: "a", author: "agent", name: nil, text: "sunny")])
        let built = TranscriptBuilder.rows(messages: [reply("r", to: "a", at: 0)], pending: [], answers: [:], options: .init())
        #expect(built.map(\.id) == ["sep-r", "r:1"])
    }

    /// A reply in a chat thread opens the thread view, tinting the
    /// original; a message in none jumps to the original and tints it.
    @Test func theQuoteLeadsToTheThreadOrTheOriginal() async {
        let store = await chat([
            message("a", "sunny", at: 0),
            reply("r1", to: "a", at: 10),
            reply("r2", to: "a", at: 20, thread: "a", title: "Weather"),
        ])
        // r1 is its own root, as a quote kept from before reply chains is.
        store.quoteAction(reply: "r1", original: "a")?()
        #expect(store.thread == nil && store.jumpTarget == "a" && store.jumps == 1 && store.tinted == "a")
        // r2 is in the thread rooted at a.
        store.quoteAction(reply: "r2", original: "a")?()
        #expect(store.thread?.anchor.id == "r2" && store.tinted == "a")
        // A send from the thread view goes to the thread, quoting nothing.
        #expect(store.composerThread?.body == ["chatThread": .string("a")] && !store.showsQuoteBar)
        store.closeThread()
        // An original not held leads nowhere.
        #expect(store.quoteAction(reply: "r1", original: "gone") == nil)
    }

    /// A draft keeps its reply and thread view, and a relaunch brings them back.
    @Test func aDraftsReplyComesBack() async throws {
        let target = ThreadTarget(messageId: "a", instanceKnowsThreads: true, quote: true)
        let back = try JSONDecoder().decode(ThreadTarget.self, from: JSONEncoder().encode(target))
        #expect(back == target && back.isQuote && back.threadMessage == nil)
        // Drafts written before quotes were written in a thread view.
        let old = try JSONDecoder().decode(ThreadTarget.self, from: Data(#"{"messageId":"a","instanceKnowsThreads":true}"#.utf8))
        #expect(!old.isQuote && old.threadMessage == "a")
        let store = await chat([message("a", at: 0, thread: "a", title: "T"), message("b", at: 10, thread: "a", title: "T")])
        store.reopenThread(target)
        #expect(store.thread == nil && store.quote == target)
        store.closeThread()
        store.reopenThread(ThreadTarget(messageId: "b", instanceKnowsThreads: true, quote: true, thread: "a"))
        #expect(store.thread?.anchor.id == "a" && store.quote?.messageId == "b")
        store.closeThread()
        #expect(store.quote == nil)
    }
}

/// The Concierge's messages in a task chat it started (rome-os/rome#1976).
@Suite struct ConciergeSenderTests {
    private func decode(_ sender: String) throws -> ChatMessage {
        try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m","sessionId":"s","role":"user","content":"[]","createdAt":"2026-11-10T10:00:00Z","sender":\#(sender)}"#.utf8))
    }

    @Test func anAgentOnNoOnesBehalfIsTheConcierge() throws {
        let concierge = try decode(#"{"kind":"automated","sourceType":"agent","name":"Yo","iconUrl":null}"#)
        #expect(concierge.saidByAgent && concierge.sender?.name == "Yo")
        // On the guardian's behalf, it is the guardian's own message.
        #expect(try !decode(#"{"kind":"automated","sourceType":"agent","name":"Yo","onBehalfOf":{"kind":"guardian","name":"Lin","avatarUrl":null}}"#).saidByAgent)
        #expect(try !decode(#"{"kind":"automated","sourceType":"routine","name":"Daily"}"#).saidByAgent)
        #expect(try !decode(#"{"kind":"guardian","name":"Lin","avatarUrl":null}"#).saidByAgent)
        // A shape the app does not know keeps the message.
        #expect(try decode(#""odd""#).sender == nil)
        // A kept copy reads back the same.
        let back = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(concierge))
        #expect(back.sender == concierge.sender)
    }
}

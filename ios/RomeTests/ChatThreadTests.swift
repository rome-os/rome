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

    @Test func aMessageSaysItsThreadOrThatItIsAlone() throws {
        let placed = try decode(#"{"id":"m2","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":"m1"}"#)
        #expect(placed.chatThreadId == "m1" && placed.knowsThreads && placed.threadRoot == "m1")
        let alone = try decode(#"{"id":"m3","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","chatThreadId":null}"#)
        #expect(alone.chatThreadId == nil && alone.knowsThreads && alone.threadRoot == "m3")
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

    @Test func thePlacementEventIsRead() {
        guard case .messageThread(let session, let id, let thread, let title) = LiveEventsSocket.decode(name: "message_chat_thread", data: .object(["sessionId": .string("s"), "messageId": .string("m2"), "chatThreadId": .string("m1"), "chatThreadTitle": .string("Book a table")])) else {
            Issue.record("not read"); return
        }
        #expect(session == "s" && id == "m2" && thread == "m1" && title == "Book a table")
        guard case .messageThread(_, _, let none, _) = LiveEventsSocket.decode(name: "message_chat_thread", data: .object(["sessionId": .string("s"), "messageId": .string("m2"), "chatThreadId": .null])) else {
            Issue.record("not read"); return
        }
        #expect(none == nil)
        guard case .threadRetired(let chat, let root) = LiveEventsSocket.decode(name: "chat_thread_retired", data: .object(["sessionId": .string("s"), "chatThreadId": .string("m1")])) else {
            Issue.record("not read"); return
        }
        #expect(chat == "s" && root == "m1")
    }

    /// A message carries its task's title, and a kept copy keeps it.
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

/// Where the `↳ <task title>` label shows (docs/domains/chats.md#chat-thread).
@Suite struct ThreadLabelTests {
    private func rows(_ messages: [ChatMessage], threads: Bool = true) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showThreads: threads))
    }

    private func labels(_ rows: [TranscriptRow]) -> [String: String] {
        var out: [String: String] = [:]
        for row in rows { if case .threadLabel(_, let id, let title) = row { out[id] = title } }
        return out
    }

    /// A Concierge message in a task's thread gets one, right under it:
    /// plain text, a forward and a question shown alone alike. Of a run of
    /// three, the middle one shows none.
    @Test func everyConciergeMessageOfATaskThreadIsLabelled() {
        let ask: [[String: Any]] = [["type": "task_chat", "chatId": "c1", "title": "Book", "show": "ask"]]
        let forward: [[String: Any]] = [["type": "text", "content": "Done", "forwardedFrom": ["chatId": "c1", "title": "Book"]]]
        let messages = [
            message("u", role: "user", "book a table", at: 0, thread: "u", title: "Book a table"),
            message("a1", "on it", at: 10, thread: "u", title: "Book a table"),
            message("a2", at: 20, thread: "u", parts: ask),
            message("a3", at: 30, thread: "u", parts: forward),
        ]
        let built = rows(messages)
        #expect(labels(built) == ["a1": "Book a table", "a3": "Book a table"])
        // Right under its own message.
        let index = built.firstIndex { $0.id == "label-a1" }!
        #expect(built[index - 1].id == "a1:0")
    }

    /// None on the guardian's own messages, on a task card, in no thread,
    /// in a thread no task has, or inside the thread view.
    @Test func noLabelWhereTheRuleSaysNone() {
        let card: [[String: Any]] = [["type": "task_chat", "chatId": "c1", "title": "Book", "show": "task"]]
        let legacyCard: [[String: Any]] = [["type": "task_chat", "chatId": "c1", "title": "Book"]]
        let messages = [
            message("u", role: "user", at: 0, thread: "u", title: "Book"),
            message("c", at: 10, thread: "u", title: "Book", parts: card),
            message("l", at: 11, thread: "u", title: "Book", parts: legacyCard),
            message("x", at: 20),
            message("old", at: 30, thread: "z"),
        ]
        #expect(labels(rows(messages)).isEmpty)
        let threaded = [message("a", at: 0, thread: "u", title: "Book")]
        #expect(labels(rows(threaded, threads: false)).isEmpty)
    }

    /// Only the first and last of a run are labelled; a run of one or two
    /// labels each. Another thread, or the guardian, ends the run.
    @Test func onlyTheEndsOfARunAreLabelled() {
        let messages = [
            message("a1", at: 0, thread: "u", title: "Book"),
            message("a2", at: 1, thread: "u"),
            message("a3", at: 2, thread: "u"),
            message("a4", at: 3, thread: "u"),
            // Another thread ends it.
            message("b1", at: 4, thread: "v", title: "Fly"),
            message("a5", at: 5, thread: "u"),
            message("a6", at: 6, thread: "u"),
            // The guardian ends it too.
            message("q", role: "user", at: 7),
            message("a7", at: 8, thread: "u"),
            // A message in no thread ends it.
            message("x", at: 9),
            message("a8", at: 10, thread: "u"),
            message("a9", at: 11, thread: "u"),
            message("a10", at: 12, thread: "u"),
        ]
        #expect(labels(rows(messages)) == [
            "a1": "Book", "a4": "Book", "b1": "Fly", "a5": "Book", "a6": "Book", "a7": "Book", "a8": "Book", "a10": "Book",
        ])
    }

    /// The title comes from any message of the thread, a live placement too.
    @Test func theTitleComesFromTheThread() {
        let messages = [message("a1", at: 0, thread: "u", title: "Book"), message("a2", at: 10, thread: "u")]
        #expect(labels(rows(messages)) == ["a1": "Book", "a2": "Book"])
    }

    /// A label sits tight under its message and apart from the next one.
    @Test func theLabelSitsTightUnderItsMessage() {
        let label = TranscriptRow.threadLabel(id: "label-a", messageId: "a", title: "T")
        let bubble = TranscriptRow.agentText(id: "a:0", text: "x", long: false, forwardedFrom: nil, position: .single)
        let next = TranscriptRow.agentText(id: "b:0", text: "y", long: false, forwardedFrom: nil, position: .single)
        #expect(TranscriptSpacing.top(label, after: bubble) < TranscriptSpacing.top(next, after: label))
        // A tint covers the message, not its label.
        #expect(label.ownMessageId == nil && bubble.ownMessageId == "a" && !label.isGuardian)
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
        backend.threads["a1"] = [older, reply]
        store.openThread(at: "a1")
        let thread = store.thread!
        await settle { thread.messages.count == 2 }
        #expect(backend.threadReads == ["a1"])
        #expect(thread.messages.map(\.id) == ["r", "a1"])
        #expect(thread.root == "r")
        #expect(store.composerThread?.thread == "a1")
        store.closeThread()
        #expect(store.thread == nil)
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

    /// New messages of the thread show live; one placed elsewhere leaves it.
    @Test func theThreadFollowsEvents() async {
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
        // The guardian's message is placed here: the thread is read again.
        let mine = message("u", role: "user", "and then?", at: 30, thread: "r")
        backend.threads["r"] = [root, reply, message("a2", "more", at: 20, thread: "r"), mine]
        backend.bus.emit(LiveTopic.chat("concierge"), .messageThread(sessionId: "concierge", messageId: "u", chatThreadId: "r"))
        await settle { thread.messages.count == 4 }
        #expect(thread.messages.last?.id == "u")
        // A reply moved to another thread leaves this one.
        backend.bus.emit(LiveTopic.chat("concierge"), .messageThread(sessionId: "concierge", messageId: "a1", chatThreadId: "z"))
        #expect(!thread.messages.contains { $0.id == "a1" })
        // The chat learns the placement too.
        #expect(store.message("a1")?.chatThreadId == "z")
        store.closeThread()
    }

    /// A send from the thread view replies to the labelled message in its
    /// thread, and a retry keeps it.
    @Test func aSendFromTheThreadGoesToIt() async {
        let backend = FakeBackend()
        let store = await chat(backend, [message("a1", "sure", at: 10, thread: "r", title: "T")])
        store.openThread(at: "a1")
        let target = store.composerThread!
        #expect(target == ThreadTarget(messageId: "a1", instanceKnowsThreads: true, quote: true, thread: "a1", bare: true))
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
        #expect(store.composerThread?.body == ["chatThread": .string("a2")])
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

    /// A reply in a task's thread opens the thread view, tinting the
    /// original; any other jumps to the original and tints it.
    @Test func theQuoteLeadsToTheThreadOrTheOriginal() async {
        let store = await chat([
            message("a", "sunny", at: 0),
            reply("r1", to: "a", at: 10),
            reply("r2", to: "a", at: 20, thread: "r2", title: "Weather"),
        ])
        store.quoteAction(reply: "r1", original: "a")?()
        #expect(store.thread == nil && store.jumpTarget == "a" && store.jumps == 1 && store.tinted == "a")
        store.quoteAction(reply: "r2", original: "a")?()
        #expect(store.thread?.anchor.id == "r2" && store.tinted == "a")
        // A send from the thread view goes to the thread, quoting nothing.
        #expect(store.composerThread?.body == ["chatThread": .string("r2")] && !store.showsQuoteBar)
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

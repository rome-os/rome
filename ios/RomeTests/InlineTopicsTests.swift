import Foundation
import Testing
import UIKit
@testable import Rome

/// A message of a Concierge chat as the instance sends it with chat threads
/// and read marks (docs/domains/chats.md#chat-thread).
private func msg(
    _ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, thread: String? = nil,
    read: Bool? = nil, title: String? = nil, session: String = "concierge", parts: [[String: Any]]? = nil
) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: parts ?? [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: true, chatThreadTitle: title, read: read)
}

/// The stacks the main line draws for its threads, and the replies they stand for.
@MainActor
@Suite struct ThreadStackTests {
    private let root = msg("r", role: "user", "plan the trip", at: 0, thread: "r", read: true)

    @Test func repliesLeaveTheMainLineForTheirRootsStack() throws {
        let a1 = msg("a1", "on it", at: 10, thread: "r", read: false)
        let a2 = msg("a2", "done", at: 20, thread: "r", read: true)
        let elsewhere = msg("x", "weather?", at: 30, thread: "x", read: false)
        let held = [root, a1, a2, elsewhere]
        let threads = ThreadStacks.build(held)
        #expect(threads.stacked == ["a1", "a2"])
        let stack = try #require(threads.stacks["r"])
        #expect(stack.total == 2 && stack.unread == 1 && stack.lastId == "a2" && stack.preview == "done")
        // The rows draw the root and the message that is in no thread, and no reply.
        let built = TranscriptBuilder.rows(messages: held, pending: [], answers: [:], options: .init(showNotices: true, stacked: threads.stacked))
        #expect(built.compactMap(\.ownMessageId) == ["r", "x"])
        // Without the stacks, every message is a row, as in a share.
        let flat = TranscriptBuilder.rows(messages: held, pending: [], answers: [:], options: .init(showNotices: true))
        #expect(flat.compactMap(\.ownMessageId) == ["r", "a1", "a2", "x"])
    }

    /// The stack shows the newest reply by its time, and a tie by arrival, never by the list's order.
    @Test func theNewestReplyIsByTimeThenArrival() throws {
        let newer = msg("newer", "second", at: 20, thread: "r")
        let older = msg("older", "first", at: 10, thread: "r")
        // The store's order follows its turns, so the newest can come first.
        #expect(try #require(ThreadStacks.build([root, newer, older]).stacks["r"]).lastId == "newer")
        // Messages of one second: the one that arrived last, whichever stands later in the list.
        let a = msg("a", "from a", at: 10, thread: "r")
        let b = msg("b", "from b", at: 10, thread: "r")
        #expect(try #require(ThreadStacks.build([root, a, b]).stacks["r"]).lastId == "b")
        #expect(try #require(ThreadStacks.build([root, a, b], arrival: ["a": 5, "b": 3, "r": 0]).stacks["r"]).lastId == "a")
        #expect(try #require(ThreadStacks.build([root, a, b], arrival: ["a": 5, "b": 3, "r": 0]).stacks["r"]).preview == "from a")
    }

    @Test func theCountIsTheUnreadRepliesElseAll() throws {
        let unread = try #require(ThreadStacks.build([root, msg("a1", at: 10, thread: "r", read: false), msg("a2", at: 11, thread: "r", read: false), msg("a3", at: 12, thread: "r", read: true)]).stacks["r"])
        #expect(unread.hasUnread && unread.count == 2 && unread.total == 3)
        let seen = try #require(ThreadStacks.build([root, msg("a1", at: 10, thread: "r", read: true), msg("a2", at: 11, thread: "r", read: true)]).stacks["r"])
        #expect(!seen.hasUnread && seen.count == 2)
        // The owner's own reply is read when said and is never unread.
        let own = try #require(ThreadStacks.build([root, msg("u", role: "user", "and then?", at: 10, thread: "r", read: false)]).stacks["r"])
        #expect(own.unread == 0 && own.total == 1)
    }

    @Test func aSecondLayerNeedsTwoReplies() throws {
        #expect(try #require(ThreadStacks.build([root, msg("a1", at: 10, thread: "r")]).stacks["r"]).layered == false)
        #expect(try #require(ThreadStacks.build([root, msg("a1", at: 10, thread: "r"), msg("a2", at: 11, thread: "r")]).stacks["r"]).layered)
    }

    /// An instance that keeps no read marks sends none: everything reads as seen.
    @Test func withoutReadMarksEverythingIsRead() throws {
        let older = [msg("r", role: "user", "plan", at: 0, thread: "r"), msg("a1", at: 10, thread: "r"), msg("a2", at: 11, thread: "r")]
        #expect(older.allSatisfy { $0.read == nil && $0.isRead })
        let threads = ThreadStacks.build(older)
        let stack = try #require(threads.stacks["r"])
        #expect(stack.unread == 0 && stack.total == 2)
        #expect(threads.waiting(seen: [], threadOpen: false).isEmpty)
        // The field is optional on the wire, and a kept copy reads back the same.
        let wire = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z"}"#.utf8))
        #expect(wire.read == nil && wire.isRead)
        let marked = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","read":false}"#.utf8))
        #expect(marked.read == false && !marked.isRead)
        #expect(try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(marked)) == marked)
        // A shape the app does not know costs the message nothing.
        let odd = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m","sessionId":"s","role":"assistant","content":"x","createdAt":"2026-11-09T10:00:00Z","read":"yes"}"#.utf8))
        #expect(odd.read == nil)
    }

    @Test func aReplyWhoseRootIsNotLoadedStaysOnTheMainLine() {
        let threads = ThreadStacks.build([msg("a1", at: 10, thread: "r", read: false)])
        #expect(threads.stacks.isEmpty && threads.stacked.isEmpty)
        // A root with no text and no task card has nothing to hang a stack from: its replies stay too.
        let bare = msg("r", role: "user", "  ", at: 0, thread: "r")
        #expect(ThreadStacks.build([bare, msg("a1", at: 10, thread: "r")]).stacked.isEmpty)
        let ask = msg("r", at: 0, thread: "r", parts: [["type": "task_chat", "chatId": "t1", "title": "Flights", "show": "ask"]])
        #expect(ThreadStacks.build([ask, msg("a1", at: 10, thread: "r")]).stacked.isEmpty)
        // A root held before its first reply says no thread of its own, and still holds the stack.
        let early = msg("r", role: "user", "plan", at: 0, thread: nil)
        #expect(ThreadStacks.build([early, msg("a1", at: 10, thread: "r")]).stacked == ["a1"])
    }

    @Test func aThreadHasNoStackInOtherChats() async {
        let backend = FakeBackend()
        backend.stored = [msg("r", role: "user", "plan", at: 0, thread: "r", session: "t1"), msg("a1", at: 10, thread: "r", read: false, session: "t1")]
        let task = TranscriptStore(sessionId: "t1", kind: .task, backend: backend)
        await task.reload()
        #expect(task.threads.stacks.isEmpty && task.threads.stacked.isEmpty)
        #expect(task.rows.compactMap(\.ownMessageId) == ["r", "a1"])
        #expect(task.pills.isEmpty)
    }

    /// The stack goes under the last bubble of its root, and nothing else carries it.
    @Test func theStackHangsUnderTheRootsLastBubble() throws {
        let two = msg("r", at: 0, thread: "r", parts: [["type": "text", "content": "first"], ["type": "text", "content": "second"]])
        let held = [two, msg("a1", role: "user", "ok", at: 5, thread: "r")]
        let threads = ThreadStacks.build(held)
        let built = TranscriptBuilder.rows(messages: held, pending: [], answers: [:], options: .init(showNotices: true, stacked: threads.stacked))
        let infos = RowInfo.build(rows: built, messages: held, pending: [], kind: .concierge, threads: threads)
        #expect(infos["r:0"]?.stack == nil)
        #expect(infos["r:1"]?.stack?.root == "r" && infos["r:1"]?.stack?.preview == "ok")
    }

    @Test func aCardsWordsAreItsPreview() throws {
        let card = msg("c", at: 10, thread: "r", parts: [["type": "task_chat", "chatId": "t1", "title": "Flights"]])
        #expect(try #require(ThreadStacks.build([root, card]).stacks["r"]).preview == "Flights")
        // Markdown and later lines are not the preview.
        let rich = msg("a", "**Done.** Booked.\nSecond line", at: 10, thread: "r")
        #expect(try #require(ThreadStacks.build([root, rich]).stacks["r"]).preview == "Done. Booked.")
    }

    @Test func theUnreadLineLeavesOutWhatAStackStandsFor() {
        let a1 = msg("a1", at: 10, thread: "r", read: false)
        let main = msg("m", at: 20, thread: "m", read: false)
        let held = [root, a1, main]
        #expect(UnreadAtOpen.summary(in: held, unread: ["a1", "m"], hasOlder: false)?.firstId == "a1")
        #expect(UnreadAtOpen.summary(in: held, unread: ["a1", "m"], hasOlder: false, excluding: ["a1"])?.firstId == "m")
        #expect(UnreadAtOpen.summary(in: held, unread: ["a1"], hasOlder: false, excluding: ["a1"]) == nil)
    }
}

/// The pills above the composer (docs/domains/chats.md#chat-thread).
@MainActor
@Suite struct ThreadPillTests {
    private func threads() -> ThreadStacks {
        ThreadStacks.build([
            msg("r1", role: "user", "first", at: 0, thread: "r1"), msg("a1", at: 10, thread: "r1", read: false),
            msg("r2", role: "user", "second", at: 20, thread: "r2"), msg("b1", at: 30, thread: "r2", read: false),
            msg("r3", role: "user", "third", at: 40, thread: "r3"), msg("c1", at: 50, thread: "r3", read: true),
            msg("r0", role: "user", "zeroth", at: 5, thread: "r0"), msg("z1", at: 60, thread: "r0", read: false),
        ])
    }

    /// One pill for each thread with unread replies, the one waiting longest first.
    @Test func oneForEachThreadWithUnreadRepliesOldestFirst() {
        #expect(threads().waiting(seen: [], threadOpen: false) == ["r1", "r2", "r0"])
    }

    @Test func aThreadWhoseStackIsInViewHasNoPill() {
        #expect(threads().waiting(seen: ["r2"], threadOpen: false) == ["r1", "r0"])
        // It comes back when the stack scrolls out of view with the thread still unread.
        #expect(threads().waiting(seen: [], threadOpen: false).contains("r2"))
        #expect(threads().waiting(seen: ["r1", "r2", "r0"], threadOpen: false).isEmpty)
    }

    @Test func noPillShowsWhileAThreadIsOpen() {
        #expect(threads().waiting(seen: [], threadOpen: true).isEmpty)
    }

    @Test func theNameIsCutShortInThePill() {
        #expect(ThreadStacks.pillName("Plan Kyoto") == "Plan Kyoto")
        #expect(ThreadStacks.pillName("Compare every ryokan along the river") == "Compare ever…")
        #expect(ThreadStackCopy.pill("Plan Kyoto") == "New replies in \"Plan Kyoto\"")
        #expect(ThreadStackCopy.pill(nil) == "New replies in \"Thread\"")
        #expect(ThreadStackCopy.pill("") == "New replies in \"Thread\"")
    }
}

/// `[name](#rome-thread=ID)` in the Concierge's text.
@MainActor
@Suite struct ThreadLinkTests {
    @Test func theRootIsReadFromTheHref() {
        #expect(ThreadLink.root(ofHref: "#rome-thread=abc-123") == "abc-123")
        #expect(ThreadLink.root(ofHref: "#rome-thread=a%2Fb%20c") == "a/b c")
        #expect(ThreadLink.root(of: URL(string: "#rome-thread=m1")!) == "m1")
        #expect(ThreadLink.url(root: "a b").flatMap(ThreadLink.root(of:)) == "a b")
        // Any other href, and a root that does not decode, is no thread link.
        #expect(ThreadLink.root(ofHref: nil) == nil)
        #expect(ThreadLink.root(ofHref: "https://example.com/#rome-thread=m1") == nil)
        #expect(ThreadLink.root(ofHref: "#rome-thread=") == nil)
        #expect(ThreadLink.root(ofHref: "#rome-thread=%E0%A4%A") == nil)
        #expect(ThreadLink.root(ofHref: "#rome-thread=%E0%A4%25A") == nil)
        #expect(ThreadLink.root(ofHref: "#rome-thread=%") == nil && ThreadLink.root(ofHref: "#rome-thread=%2") == nil && ThreadLink.root(ofHref: "#rome-thread=%zz") == nil)
        #expect(ThreadLink.root(ofHref: "#other=m1") == nil)
    }

    private func chat(_ messages: [ChatMessage]) async -> TranscriptStore {
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func text(_ attributed: AttributedString) -> String { String(attributed.characters) }

    /// The chip is "# name" with the thread's own name, else the link's text, and opens the thread.
    @Test func aLinkIsAChipWithTheThreadsNameOrItsText() async {
        let store = await chat([msg("r", role: "user", "plan", at: 0, thread: "r", title: "Plan Kyoto"), msg("a1", at: 10, thread: "r", title: "Plan Kyoto")])
        let named = MarkdownParser.inline("See [the trip](#rome-thread=r) first", linksAsText: false, threads: store.threadLinks)
        #expect(text(named).contains("# Plan Kyoto") && !text(named).contains("the trip"))
        #expect(named.runs.contains { $0.link.flatMap(ThreadLink.root(of:)) == "r" })
        // A thread the chat does not hold: the link's text, and a chip that opens nothing.
        let unknown = MarkdownParser.inline("See [the trip](#rome-thread=gone) first", linksAsText: false, threads: store.threadLinks)
        #expect(text(unknown).contains("# the trip") && !unknown.runs.contains { $0.link != nil })
        // In a thread view it opens nothing either, and without a chat it reads the same.
        let inThread = MarkdownParser.inline("[x](#rome-thread=r)", linksAsText: false, threads: store.threadLinksInThread)
        #expect(text(inThread).contains("# Plan Kyoto") && !inThread.runs.contains { $0.link != nil })
        #expect(text(MarkdownParser.inline("[x](#rome-thread=r)", linksAsText: false, threads: nil)).contains("# x"))
        // As plain text, such as in a card, it is the text.
        #expect(text(MarkdownParser.inline("[the trip](#rome-thread=r)", linksAsText: true, threads: store.threadLinks)) == "the trip")
    }

    @Test func aMalformedLinkIsAPlainLinkAndNeverCrashes() async {
        let store = await chat([])
        for source in ["[odd](#rome-thread=%E0%A4%A)", "[odd](#rome-thread=)", "[odd](#rome-thread", "[](#rome-thread=r)", "#rome-thread=r", "[a](#rome-thread=%)"] {
            let shown = MarkdownParser.inline(source, linksAsText: false, threads: store.threadLinks)
            #expect(!text(shown).contains("# odd"), "\(source) → \(shown.runs.map { ($0.link?.absoluteString ?? "-") })")
        }
    }

    @Test func aChipOpensTheThreadTheChatHolds() async {
        let store = await chat([msg("r", role: "user", "plan", at: 0, thread: "r"), msg("a1", at: 10, thread: "r")])
        #expect(store.threadLinks.canOpen("r") && !store.threadLinks.canOpen("gone") && !store.threadLinksInThread.canOpen("r"))
        store.threadLinksInThread.open("r")
        #expect(store.thread == nil)
        store.threadLinks.open("gone")
        #expect(store.thread == nil)
        store.threadLinks.open("r")
        #expect(store.thread?.root == "r")
        // With one open, a chip opens nothing.
        #expect(!store.threadLinks.canOpen("r"))
    }
}

/// Reading, opening and the pills of a Concierge chat.
@MainActor
@Suite struct ThreadReadingTests {
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage]) async -> TranscriptStore {
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<100 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private var unreadChat: [ChatMessage] {
        [
            msg("r", role: "user", "plan the trip", at: 0, thread: "r", read: true),
            msg("a1", "on it", at: 10, thread: "r", read: false),
            msg("a2", "done", at: 20, thread: "r", read: false),
            msg("x", "weather?", at: 30, thread: "x", read: false),
        ]
    }

    @Test func theMainLineShowsTheRootAndAStack() async {
        let store = await chat(FakeBackend(), unreadChat)
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
        let stack = store.threads.stacks["r"]
        #expect(stack?.unread == 2 && store.info(for: .userText(id: "r:0", text: "plan the trip", pending: nil)).stack == stack)
        #expect(store.pills == ["r"])
    }

    /// Opening a thread marks its messages read, here and on the instance, and its pill goes.
    @Test func openingAThreadMarksItRead() async {
        let backend = FakeBackend()
        let store = await chat(backend, unreadChat)
        store.openChatThread("r")
        #expect(store.thread?.root == "r")
        await settle { !backend.markedRead.isEmpty }
        #expect(backend.markedRead.count == 1 && Set(backend.markedRead[0].ids) == ["a1", "a2"] && backend.markedRead[0].session == "concierge")
        #expect(store.message("a1")?.read == true && store.message("a2")?.read == true)
        // The main line is not the thread's to read.
        #expect(store.message("x")?.read == false)
        #expect(store.threads.stacks["r"]?.unread == 0 && store.pills.isEmpty)
    }

    /// What arrives in the thread while it is open is read as it comes; what arrives elsewhere is not.
    @Test func whatArrivesInTheOpenThreadIsRead() async {
        let backend = FakeBackend()
        let store = await chat(backend, unreadChat)
        store.openChatThread("r")
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("a3", "more", at: 40, thread: "r", read: false)))
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("y", "elsewhere", at: 41, thread: "y", read: false)))
        await settle { backend.markedRead.count == 2 }
        #expect(store.message("a3")?.read == true && store.message("y")?.read == false)
        #expect(backend.markedRead.count == 2 && backend.markedRead.last?.ids == ["a3"])
    }

    /// A message seen stays seen, and a live copy that leaves the mark out keeps the one held.
    @Test func aSeenMessageStaysSeen() async {
        let backend = FakeBackend()
        let store = await chat(backend, unreadChat)
        store.markThreadRead("r")
        #expect(store.message("a1")?.read == true)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("a1", "on it", at: 10, thread: "r", read: false)))
        #expect(store.message("a1")?.read == true)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("x", "weather?", at: 30, thread: "x", read: nil)))
        #expect(store.message("x")?.read == false)
    }

    /// A pill brings the transcript to the stack and tints it, reads the thread, and opens nothing.
    @Test func aPillGoesToTheStackAndReadsTheThread() async throws {
        let backend = FakeBackend()
        let store = await chat(backend, unreadChat)
        #expect(store.pills == ["r"] && store.threadName("r") == "plan the trip")
        // The stack is in view: no pill. Out of view it comes back.
        store.setSeenStacks(["r"])
        #expect(store.pills.isEmpty)
        store.setSeenStacks([])
        #expect(store.pills == ["r"])
        // The list watches the stacks of threads that wait.
        #expect(store.stackWatch == [try #require(store.stackHosts["r"]): "r"])
        store.showStack("r")
        #expect(store.jumpTarget == store.stackHosts["r"] && store.jumps == 1 && store.tintedStack == "r")
        #expect(store.thread == nil && store.tinted == nil)
        #expect(store.pills.isEmpty && store.threads.stacks["r"]?.unread == 0 && store.stackWatch.isEmpty)
        await settle { !backend.markedRead.isEmpty }
        #expect(Set(backend.markedRead.first?.ids ?? []) == ["a1", "a2"])
    }

    @Test func noPillShowsWhileAThreadIsOpen() async {
        let backend = FakeBackend()
        // Two threads wait; with one open, no pill shows, the other's included.
        let store = await chat(backend, [msg("r", role: "user", "plan", at: 0, thread: "r"), msg("a1", at: 10, thread: "r", read: false), msg("x", at: 20, thread: "x"), msg("x1", at: 30, thread: "x", read: false)])
        #expect(Set(store.pills) == ["r", "x"])
        store.openChatThread("r")
        #expect(store.pills.isEmpty)
    }

    @Test func anInstanceWithoutReadMarksHasNoPillsAndMarksNothing() async {
        let backend = FakeBackend()
        let store = await chat(backend, [msg("r", role: "user", "plan", at: 0, thread: "r"), msg("a1", at: 10, thread: "r"), msg("a2", at: 11, thread: "r")])
        #expect(store.threads.stacks["r"]?.total == 2 && store.threads.stacks["r"]?.unread == 0)
        #expect(store.pills.isEmpty && store.stackWatch.isEmpty)
        store.openChatThread("r")
        await settle { false }
        #expect(backend.markedRead.isEmpty)
    }

    /// Share mode picks whole turns: it shows every message and no stacks.
    @Test func aShareShowsEveryMessageAndNoStacks() async {
        let store = await chat(FakeBackend(), unreadChat)
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"])
        store.share.begin(turn: nil)
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "a1", "a2", "x"] && store.threads.stacks.isEmpty)
        store.share.cancel()
        #expect(store.rows.compactMap(\.ownMessageId) == ["r", "x"] && store.threads.stacks["r"] != nil)
    }

    /// A reply that arrives is not a new message on the main line.
    @Test func aReplyInAStackIsNoNewMessage() async {
        let backend = FakeBackend()
        let store = await chat(backend, unreadChat)
        let before = (store.arrivals, store.mainArrivals)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("a3", "more", at: 40, thread: "r", read: false)))
        #expect(store.arrivals == before.0 + 1 && store.mainArrivals == before.1)
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(msg("z", "weather again", at: 50, thread: "z", read: false)))
        #expect(store.mainArrivals == before.1 + 1)
        // The stack stays under its root, with the newest reply.
        #expect(store.threads.stacks["r"]?.lastId == "a3" && store.threads.stacks["r"]?.unread == 3)
    }
}

/// A Reply sent from the main line opens its thread once the instance takes it.
@MainActor
@Suite struct ReplyFromMainTests {
    private func chat(_ backend: FakeBackend, _ messages: [ChatMessage]) async -> TranscriptStore {
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<100 where !until() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func theThreadOpensWhenTheServerAcceptsTheReply() async {
        let backend = FakeBackend()
        let store = await chat(backend, [msg("q", role: "user", "weather?", at: 0, thread: "q"), msg("a", "sunny", at: 10, thread: "a")])
        store.reply(to: "a")
        let target = store.composerThread
        #expect(store.send("and tomorrow?", fromComposer: true, thread: target))
        store.composerSent()
        // Not taken yet: the reply bar is gone and nothing opened.
        #expect(store.thread == nil && store.quote == nil)
        await settle { store.pending.first?.state == .failed(.unreachable) }
        #expect(store.thread == nil)
        // Taken: the thread of the message replied to opens, and the composer goes on into it.
        backend.sendSucceeds = true
        store.retry(store.pending[0].id)
        await settle { store.thread != nil }
        #expect(store.thread?.root == "a" && store.composerThread?.thread == "a" && store.composerThread?.bare == true)
        #expect(!store.showsQuoteBar)
        // What was sent shows in it while it is on its way.
        #expect(store.thread?.rows.contains { if case .userText(_, "and tomorrow?", _, _) = $0 { true } else { false } } == true)
    }

    @Test func aReplyTakenAtOnceOpensItToo() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let store = await chat(backend, [msg("a", "sunny", at: 10, thread: "a")])
        store.reply(to: "a")
        #expect(store.send("and tomorrow?", fromComposer: true, thread: store.composerThread))
        store.composerSent()
        await settle { store.thread != nil }
        #expect(store.thread?.anchor.id == "a")
    }

    /// A send from inside an open thread keeps it open, so the next message goes into it too.
    @Test func aSendFromInsideTheThreadKeepsItOpen() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let store = await chat(backend, [msg("r", role: "user", "plan", at: 0, thread: "r"), msg("a1", at: 10, thread: "r", read: true)])
        store.openChatThread("r")
        store.reply(to: "a1")
        #expect(store.showsQuoteBar)
        #expect(store.send("go on", fromComposer: true, thread: store.composerThread))
        store.composerSent()
        await settle { !backend.sentThreads.isEmpty }
        #expect(store.thread?.root == "r" && store.composerThread?.bare == true && !store.showsQuoteBar)
        #expect(backend.sentThreads.first??.thread == "r")
    }

    /// A resend of a stored message that replied to another never opens a thread: only a Reply the guardian just sent does.
    @Test func aResendOpensNothing() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let lost = msg("u1", role: "user", at: 20, thread: "u1", parts: [
            ["type": "reply_to", "messageId": "a", "author": "agent", "text": "sunny"], ["type": "text", "content": "and tomorrow?"],
        ])
        let store = await chat(backend, [msg("a", "sunny", at: 10, thread: "a"), lost])
        store.retry("u1:1")
        await settle { !backend.sentThreads.isEmpty }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(backend.sentThreads.count == 1 && store.thread == nil)
    }
}

/// `POST /chat/sessions/:id/messages/read`.
final class ReadMarkRecorder: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [(URLRequest, Data)] = []
    nonisolated(unsafe) private static var status = 200
    static var requests: [(URLRequest, Data)] { lock.withLock { recorded } }
    static func reset(status: Int = 200) { lock.withLock { recorded = []; Self.status = status } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let code = Self.lock.withLock { Self.recorded.append((request, body)); return Self.status }
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(code == 200 ? #"{"marked":2}"#.utf8 : #"{"error":"Not found"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
@Suite(.serialized) struct MarkReadRequestTests {
    private func backend() -> LiveBackend {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReadMarkRecorder.self]
        return LiveBackend(client: APIClient(origin: URL(string: "http://127.0.0.1:4141")!, token: { "t" }, configuration: configuration))
    }

    @Test func theRequestNamesTheMessages() async throws {
        ReadMarkRecorder.reset()
        await backend().markMessagesRead(sessionId: "chat 1", ids: ["a", "b"])
        let (request, body) = try #require(ReadMarkRecorder.requests.last)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/chat/sessions/chat%201/messages/read" || request.url?.path == "/api/chat/sessions/chat 1/messages/read")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["ids"] as? [String] == ["a", "b"] && json.count == 1)
    }

    @Test func noMessagesSendNothing() async {
        ReadMarkRecorder.reset()
        await backend().markMessagesRead(sessionId: "chat-1", ids: [])
        #expect(ReadMarkRecorder.requests.isEmpty)
    }

    /// An instance before the route answers 404; the app takes it quietly, and so does a network that fails.
    @Test func anOlderInstanceFailsQuietly() async {
        ReadMarkRecorder.reset(status: 404)
        await backend().markMessagesRead(sessionId: "chat-1", ids: ["a"])
        #expect(ReadMarkRecorder.requests.count == 1)
        ReadMarkRecorder.reset(status: 500)
        await backend().markMessagesRead(sessionId: "chat-1", ids: ["a"])
        #expect(ReadMarkRecorder.requests.count == 1)
    }
}

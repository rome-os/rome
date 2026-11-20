import Foundation
import Testing
import UIKit
@testable import Rome

private func message(_ id: String, role: String = "assistant", _ text: String = "hi", at seconds: TimeInterval, session: String = "concierge", parts: [[String: Any]]? = nil) -> ChatMessage {
    let content = String(data: try! JSONSerialization.data(withJSONObject: parts ?? [["type": "text", "content": text]]), encoding: .utf8)!
    return ChatMessage(id: id, sessionId: session, role: role, content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)))
}

/// How a reply is drawn (docs/domains/chats.md#chat-thread): messages in order,
/// a plain bubble under what it answers, a run of replies to one message close
/// together, and a quote in the bubble for any other reply.
@MainActor
@Suite struct FlatReplyTests {
    private func rows(_ messages: [ChatMessage]) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showNotices: true))
    }

    private func info(_ messages: [ChatMessage]) -> [String: RowInfo] {
        RowInfo.build(rows: rows(messages), messages: messages, pending: [], kind: .concierge)
    }

    /// The parts of a message that replies to `original`, with a text of its own.
    private func quote(of id: String, _ original: String, author: String = "guardian", text: String = "plan") -> [[String: Any]] {
        [["type": "reply_to", "messageId": original, "author": author, "text": text], ["type": "text", "content": "said \(id)"]]
    }

    private func positions(_ messages: [ChatMessage]) -> [BubblePosition] {
        rows(messages).compactMap { if case .agentText(_, _, _, _, let position) = $0 { position } else { nil } }
    }

    /// A reply right under the guardian's message it answers is a plain bubble; a
    /// message that replies to nothing is plain too.
    @Test func aReplyUnderWhatItAnswersIsPlain() {
        let q = message("u", role: "user", "plan", at: 0)
        let reply = message("a1", at: 1, parts: quote(of: "a1", "u"))
        #expect(info([q, reply])["a1:1"]?.quote == nil)
        #expect(info([q, message("a2", at: 2)])["a2:0"]?.quote == nil)
    }

    /// Replies to one message, one after the other, are one run: the first bubble
    /// keeps a small bottom-left corner, the last a small top-left one.
    @Test func repliesToOneMessageFormARun() {
        let q = message("u", role: "user", "plan", at: 0)
        let run = [q] + (1...3).map { message("a\($0)", at: Double($0), parts: quote(of: "a\($0)", "u")) }
        #expect(positions(run) == [.first, .middle, .last])
        // Each reply after the first is in the run: no quote.
        let infos = info(run)
        #expect(["a1:1", "a2:1", "a3:1"].allSatisfy { infos[$0]?.quote == nil })
        // A run stays whole across a gap of minutes, as an acknowledgement and its result are.
        let slow = [q, run[1], message("a2", at: 600, parts: quote(of: "a2", "u"))]
        #expect(positions(slow) == [.first, .last])
    }

    /// Bubbles that reply to nothing, or to different messages, do not join.
    @Test func otherBubblesStandApart() {
        let q = message("u", role: "user", "plan", at: 0)
        let plain = [message("x", at: 1), message("y", at: 2)]
        #expect(positions(plain) == [.single, .single])
        let other = [q, message("a1", at: 1, parts: quote(of: "a1", "u")), message("a2", at: 2, parts: quote(of: "a2", "elsewhere"))]
        #expect(positions(other) == [.single, .single])
    }

    /// A reply with another message between it and its target draws its quote; a
    /// guardian message that replies draws one always.
    @Test func aReplyToAnEarlierMessageDrawsItsQuote() throws {
        let q = message("u", role: "user", "plan", at: 0)
        let other = message("g2", role: "user", "other", at: 1)
        let late = message("a1", at: 2, parts: quote(of: "a1", "u"))
        let shown = try #require(info([q, other, late])["a1:1"])
        #expect(shown.quote?.messageId == "u" && shown.quote?.author == "guardian")
        // The guardian's reply to the message right above it still quotes.
        let agent = message("a0", at: 1)
        let ownReply = message("g3", role: "user", at: 2, parts: quote(of: "g3", "a0", author: "agent"))
        #expect(info([q, agent, ownReply])["g3:1"]?.quote?.messageId == "a0")
    }

    /// A time line, or the guardian's message, ends a run.
    @Test func aTimeLineEndsARun() {
        let q = message("u", role: "user", "plan", at: 0)
        let a1 = message("a1", at: 1, parts: quote(of: "a1", "u"))
        let later = message("a2", at: 4000, parts: quote(of: "a2", "u"))
        #expect(positions([q, a1, later]) == [.single, .single])
        #expect(info([q, a1, later])["a2:1"]?.quote?.messageId == "u")
        let between = [q, a1, message("g2", role: "user", at: 2), message("a2", at: 3, parts: quote(of: "a2", "u"))]
        #expect(positions(between) == [.single, .single])
    }

    /// A card draws no quote.
    @Test func aCardDrawsNoQuote() throws {
        let card: [[String: Any]] = [["type": "task_chat", "chatId": "t1", "title": "Flights", "show": "ask"]]
        let held = [
            message("u", role: "user", "plan", at: 0),
            message("x", role: "user", "other", at: 1),
            message("c1", at: 2, parts: [["type": "reply_to", "messageId": "u", "author": "guardian", "text": "plan"]] + card),
        ]
        let row = try #require(rows(held).first { if case .taskAsk = $0 { true } else { false } })
        #expect(row.ownMessageId == "c1")
        #expect(info(held)[row.id]?.quote == nil)
    }

    /// The gap above a bubble: 2 pt inside a run, 8 pt between other bubbles.
    @Test func theGapAboveABubbleFollowsTheRun() {
        let q = message("u", role: "user", "plan", at: 0)
        let run = [q] + (1...2).map { message("a\($0)", at: Double($0), parts: quote(of: "a\($0)", "u")) }
        let joined = rows(run)
        let (first, second) = (joined.first { $0.id == "a1:1" }!, joined.first { $0.id == "a2:1" }!)
        #expect(TranscriptSpacing.top(second, after: first) == 2)
        let apart = rows([message("x", at: 1), message("y", at: 2)])
        #expect(TranscriptSpacing.top(apart[2], after: apart[1]) == 8)
    }

    /// A quote shows the first line of the message it quotes, as plain text.
    @Test func aQuoteShowsTheFirstLineOfTheOriginal() {
        func line(_ text: String) -> String { MessagePart.ReplyQuote(messageId: "m", author: "agent", name: nil, text: text).line }
        #expect(line("Yes, €200 minimum.\n\n> Back room: €200\n> Main room: none") == "Yes, €200 minimum.")
        #expect(line("## Plan Kyoto\nthen the hotels") == "Plan Kyoto")
        #expect(line("```py\nx = 1\n```") == "x = 1")
        #expect(line("  \n") == "")
    }

    /// A source label stays under a reply.
    @Test func theSourceLabelStaysUnderAReply() {
        var routine = message("r", at: 1)
        routine.turnId = "t-r"
        var trace = message("trace", at: 1)
        trace.role = "trace"
        trace.turnId = "t-r"
        trace.content = "[]"
        trace.traceSummary = TraceSummary(totalSteps: 0, automatedInput: .init(type: "routine", name: "Daily summary"))
        let built = rows([message("u", role: "user", "plan", at: 0), trace, routine])
        #expect(built.contains { if case .sourceLabel = $0 { return true } else { return false } })
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

/// Reply opens the reply bar; the quote of a reply goes to the original
/// (docs/domains/chats.md#chat-thread).
@MainActor
@Suite struct QuoteReplyTests {
    private func chat(_ messages: [ChatMessage], backend: FakeBackend = FakeBackend()) async -> TranscriptStore {
        backend.stored = messages
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        return store
    }

    private func reply(_ id: String, to original: String, at seconds: TimeInterval) -> ChatMessage {
        message(id, role: "user", at: seconds, parts: [
            ["type": "reply_to", "messageId": original, "author": "agent", "text": "sunny"],
            ["type": "text", "content": "and tomorrow?"],
        ])
    }

    @Test func replyOpensTheReplyBar() async {
        let store = await chat([message("q", role: "user", at: 0), message("a", "sunny", at: 10), message("b", at: 20)])
        for id in ["a", "b"] {
            store.reply(to: id)
            #expect(store.quotedMessage?.id == id)
            #expect(store.composerReply?.body == ["replyToMessageId": .string(id)])
        }
        store.cancelQuote()
        #expect(store.composerReply == nil && !store.showsQuoteBar)
    }

    /// Only the Agent's text offers Reply: no card of any kind, open or folded.
    @Test func cardsOfferNoReply() {
        #expect(ConciergeRow.offersReply(.agentText(id: "a:0", text: "x", long: false, forwardedFrom: nil, position: .single)))
        #expect(!ConciergeRow.offersReply(.userText(id: "u:0", text: "x", pending: nil)))
        #expect(!ConciergeRow.offersReply(.taskCard(id: "c:0", chatId: "c", title: "T")))
        #expect(!ConciergeRow.offersReply(.taskAsk(id: "k:0", chatId: "c", title: "T", card: nil)))
        #expect(!ConciergeRow.offersReply(.webOnly(id: "w:0", kind: .unknown)))
    }

    /// A reply sent from the bar replies to the message, and the bar closes.
    @Test func theNextSendRepliesToTheQuotedMessage() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let store = await chat([message("a", "sunny", at: 0)], backend: backend)
        store.reply(to: "a")
        _ = store.send("and tomorrow?", reply: store.composerReply)
        store.cancelQuote()
        for _ in 0..<100 where backend.sentReplies.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.sentReplies == [ReplyTarget(messageId: "a")])
        #expect(store.quote == nil)
    }

    /// The quote is read from its part, and shows nothing of its own.
    @Test func aReplyCarriesItsQuote() {
        let parts = reply("r", to: "a", at: 0).parts
        #expect(parts.compactMap(\.replyQuote) == [MessagePart.ReplyQuote(messageId: "a", author: "agent", name: nil, text: "sunny")])
        let built = TranscriptBuilder.rows(messages: [reply("r", to: "a", at: 0)], pending: [], answers: [:], options: .init())
        #expect(built.map(\.id) == ["sep-r", "r:1"])
    }

    /// A tap on the quote goes to the original and tints it; an original not
    /// held is paged in, and one that never comes ends the search quietly.
    @Test func theQuoteGoesToTheOriginal() async {
        let store = await chat([message("a", "sunny", at: 0), reply("r1", to: "a", at: 10)])
        store.quoteAction(original: "a")?()
        for _ in 0..<100 where store.jumps == 0 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.jumpTarget == "a" && store.jumps == 1 && store.tinted == "a")
        // An original that is nowhere: nothing happens.
        await store.reveal(quoted: "gone")
        #expect(store.jumps == 1)
    }

    /// The guardian wrote twice before either answer came. The server pages the
    /// chat by message, in the order they were said, and the turns' traces ride
    /// along: the rows keep that order, and an answer that is not under its
    /// question carries a quote of it.
    @Test func interleavedTurnsStayInTheOrderTheyWereSaid() async {
        func inTurn(_ message: ChatMessage, _ turn: String) -> ChatMessage {
            var message = message
            message.turnId = turn
            return message
        }
        func answer(_ id: String, to original: String, at seconds: TimeInterval, turn: String) -> ChatMessage {
            inTurn(message(id, at: seconds, parts: [
                ["type": "reply_to", "messageId": original, "author": "guardian", "text": original],
                ["type": "text", "content": "said \(id)"],
            ]), turn)
        }
        let ownerA = inTurn(message("owner-a", role: "user", "First question", at: 0), "turn-a")
        let ownerB = inTurn(message("owner-b", role: "user", "Second question", at: 1), "turn-b")
        let traceA = inTurn(message("trace-a", role: "trace", "[]", at: 2), "turn-a")
        let answerA = answer("answer-a", to: "owner-a", at: 3, turn: "turn-a")
        let answerB = answer("answer-b", to: "owner-b", at: 4, turn: "turn-b")
        let backend = FakeBackend()
        backend.servedPages[nil] = MessagePage(messages: [traceA, answerA, answerB], nextCursor: "older")
        backend.servedPages["older"] = MessagePage(messages: [ownerA, ownerB, traceA], nextCursor: nil)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.messages.map(\.id) == ["trace-a", "answer-a", "answer-b"])

        await store.loadOlder()
        #expect(store.messages.map(\.id) == ["owner-a", "owner-b", "trace-a", "answer-a", "answer-b"])
        #expect(store.rowInfo["answer-a:1"]?.quote?.messageId == "owner-a")
        #expect(store.rowInfo["answer-b:1"]?.quote?.messageId == "owner-b")
    }

    /// A draft keeps its reply, and a relaunch brings it back.
    @Test func aDraftsReplyComesBack() async throws {
        let target = ReplyTarget(messageId: "a")
        let back = try JSONDecoder().decode(ReplyTarget.self, from: JSONEncoder().encode(target))
        #expect(back == target)
        let store = await chat([message("a", at: 0), message("b", at: 10)])
        store.restoreReply(target)
        #expect(store.quote == target)
        store.cancelQuote()
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

/// A reply the app still holds shows its quote at once, before the server stores it.
@MainActor
@Suite struct PendingReplyQuoteTests {
    @Test func aPendingReplyQuotesTheHeldMessage() {
        let original = message("a", "Kyoto hotel\nsecond line", at: 0)
        let other = message("b", "later", at: 1)
        let send = PendingSend(id: "p", text: "go", createdAt: .now, state: .sending, reply: ReplyTarget(messageId: "a"))
        let rows = TranscriptBuilder.rows(messages: [original, other], pending: [send], answers: [:], options: .init(showNotices: true))
        let quote = RowInfo.build(rows: rows, messages: [original, other], pending: [send], kind: .concierge)["p"]?.quote
        #expect(quote?.messageId == "a")
        #expect(quote?.author == "agent")
        #expect(quote?.line == "Kyoto hotel")
    }
}

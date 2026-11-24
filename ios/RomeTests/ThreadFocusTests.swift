import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct ThreadFocusTests {
    private func message(_ id: String, root: String = "root", text: String = "text", role: String = "assistant") -> ChatMessage {
        ChatMessage(id: id, sessionId: "concierge", role: role, content: text, createdAt: "2026-11-22T10:00:00Z", chatThreadId: root)
    }

    private func focus(_ messages: [ChatMessage], older: Bool = false, newer: Bool = false, backend: FakeBackend = FakeBackend()) -> ThreadFocus {
        ThreadFocus(sessionId: "concierge", anchor: messages.first!.id, row: "\(messages.first!.id):0", bubbleY: 250, page: ThreadPage(messages: messages, hasOlder: older, hasNewer: newer), backend: backend)
    }

    @Test func wireFieldIsOptionalOnOlderServers() throws {
        let old = #"{"id":"m","sessionId":"s","role":"assistant","content":"hi","createdAt":"2026-11-22T10:00:00Z"}"#
        #expect(try JSONDecoder().decode(ChatMessage.self, from: Data(old.utf8)).chatThreadId == nil)
        let current = message("m")
        #expect(try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(current)).chatThreadId == "root")
    }

    @Test func opensAroundPressedMessageWithoutChangingMainRowsOrReadMark() async {
        let backend = FakeBackend()
        backend.stored = [message("m"), message("other", root: "other")]
        backend.threadPages["open"] = ThreadPage(messages: [message("m"), message("last")], hasOlder: true, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        let rows = store.rows
        let reads = backend.reads
        await store.openThread(from: "m", row: "m:0", original: "root")
        #expect(backend.threadReads.count == 1)
        #expect(backend.threadReads.first?.anchor == "m" && backend.threadReads.first?.limit == 10)
        #expect(store.rows == rows && backend.reads == reads)
        #expect(store.composerReply?.messageId == "last")
        #expect(store.quotedMessage == nil && !store.showsQuoteBar)
        #expect(store.threadFocus?.transcript.rows.contains(.unreadDivider) == false)
        store.closeThread()
        #expect(store.rows == rows && store.threadFocus == nil && backend.reads == reads)
        #expect(store.composerReply == nil)
    }

    @Test func pagesUseNonTraceIdsAndKeepServerOrderForSameSecond() async {
        let backend = FakeBackend()
        let trace = message("trace", role: "trace")
        let window = focus([message("z"), trace, message("a")], older: true, newer: true, backend: backend)
        backend.threadPages["before:z"] = ThreadPage(messages: [message("older")], hasOlder: false, hasNewer: true)
        await window.load(.before)
        #expect(window.transcript.messages.map(\.id) == ["older", "z", "trace", "a"])
        #expect(!window.hasOlder && window.hasNewer)
        backend.threadPages["after:a"] = ThreadPage(messages: [message("newer")], hasOlder: true, hasNewer: false)
        await window.load(.after)
        #expect(window.transcript.messages.map(\.id) == ["older", "z", "trace", "a", "newer"])
        #expect(!window.hasOlder && !window.hasNewer)
        #expect(backend.threadReads.allSatisfy { $0.anchor == "z" && $0.limit == 20 })
    }

    @Test func liveOnlyAppendsAtNewestEndButLoadedUpdatesAlwaysApply() {
        let window = focus([message("m")], newer: true)
        window.receive(message("n"))
        window.receive(message("other", root: "other"))
        window.receive(message("m", text: "edited"))
        #expect(window.transcript.messages.map(\.id) == ["m"])
        #expect(window.transcript.messages.first?.content == "edited")
        let newest = focus([message("m")])
        newest.receive(message("n"))
        newest.receive(message("other", root: "other"))
        #expect(newest.transcript.messages.map(\.id) == ["m", "n"])
    }

    @Test func newestReadAppendsOwnSendOnlyAcrossSharedBoundary() {
        let window = focus([message("m")])
        window.catchUp([message("n")])
        #expect(window.transcript.messages.map(\.id) == ["m"])
        window.catchUp([message("m"), message("n", role: "user")])
        #expect(window.transcript.messages.map(\.id) == ["m", "n"])
        let gapped = focus([message("m")], newer: true)
        gapped.catchUp([message("m"), message("n")])
        #expect(gapped.transcript.messages.map(\.id) == ["m"])
    }

    @Test func replyUsesLastTextNotLastCardOrTrace() {
        let window = focus([message("m"), message("card", text: #"[{"type":"task_chat","chatId":"t","title":"Task"}]"#), message("trace", role: "trace")])
        #expect(window.reply?.id == "m")
    }

    @Test func failedPagePreservesWindowAndReleasesLoading() async {
        let backend = FakeBackend()
        backend.threadError = .network
        let window = focus([message("m")], older: true, backend: backend)
        await window.load(.before)
        #expect(window.transcript.messages.map(\.id) == ["m"])
        #expect(window.hasOlder && !window.loading)
    }

    @Test func missingEndpointFallsBackToOriginalJump() async {
        let backend = FakeBackend()
        backend.stored = [message("original"), message("m")]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        await store.openThread(from: "m", row: "m:0", original: "original")
        #expect(store.threadFocus == nil && store.jumpTarget == "original")
    }

    @Test func networkFailureDoesNotJumpOrReplaceMountedChat() async {
        let backend = FakeBackend()
        backend.threadError = .network
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.openThread(from: "m", row: "m:0", original: "original")
        #expect(store.threadFocus?.initial == .failed && store.jumpTarget == nil)
        #expect(store.threadFocus?.transcript.messages.isEmpty == true)
    }

    @Test func leavingDuringOpenDiscardsTheLateResponse() async {
        let backend = FakeBackend()
        backend.threadPages["open"] = ThreadPage(messages: [message("m")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        backend.duringThreadFetch = { store.closeThread() }
        await store.openThread(from: "m", row: "m:0", original: "original")
        #expect(store.threadFocus == nil)
    }

    @Test func statusUpdatesOutsideMainWindowStillReachFocus() {
        let window = focus([message("m")], newer: true)
        window.handle(.reaction(sessionId: "concierge", messageId: "m", reaction: "👍"), sessionId: "concierge")
        window.handle(.status(sessionId: "concierge", messageId: "m", status: "working"), sessionId: "concierge")
        #expect(window.transcript.message("m")?.reaction == "👍")
        #expect(window.transcript.message("m")?.status == "working")
    }

    @Test func oldChainReconcilesOwnSendBeforeAlreadyLiveAnswer() async {
        let backend = FakeBackend()
        let window = focus([message("m")], backend: backend)
        let sent = message("sent", role: "user")
        let answer = message("answer")
        window.receive(answer)
        backend.threadPages["after:m"] = ThreadPage(messages: [sent, answer], hasOlder: true, hasNewer: false)
        window.catchUp([sent, answer])
        for _ in 0..<20 { await Task.yield() }
        #expect(backend.threadReads.first?.after == "m")
        #expect(window.transcript.messages.map(\.id) == ["m", "sent", "answer"])
    }

    @Test func liveArrivalDuringReconciliationStaysAfterTheEarlierPage() async {
        let backend = FakeBackend()
        let window = focus([message("m")], backend: backend)
        let sent = message("sent", role: "user")
        let answer = message("answer")
        backend.threadPages["after:m"] = ThreadPage(messages: [sent], hasOlder: true, hasNewer: false)
        backend.duringThreadFetch = { window.receive(answer) }
        window.catchUp([sent])
        for _ in 0..<20 { await Task.yield() }
        #expect(window.transcript.messages.map(\.id) == ["m", "sent", "answer"])
    }

    @Test func acceptedOwnSendReadsFocusBeforeTheDelayedMainRefresh() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.threadPages["open"] = ThreadPage(messages: [message("m")], hasOlder: false, hasNewer: false)
        backend.threadPages["after:m"] = ThreadPage(messages: [message("sent", role: "user")], hasOlder: true, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.openThread(from: "m", row: "m:0", original: "m")
        _ = store.send("next", reply: store.composerReply)
        for _ in 0..<30 { await Task.yield() }
        #expect(backend.threadReads.contains { $0.after == "m" })
        #expect(store.threadFocus?.transcript.messages.last?.id == "sent")
        #expect(backend.sentReplies.first.flatMap { $0 }?.messageId == "m")
        #expect(!store.showsQuoteBar && store.quote == nil)
    }

    @Test func reconciliationWaitsForAnInFlightPage() async {
        let backend = FakeBackend()
        let window = focus([message("m")], older: true, backend: backend)
        backend.threadPages["before:m"] = ThreadPage(messages: [message("older")], hasOlder: false, hasNewer: true)
        backend.threadPages["after:m"] = ThreadPage(messages: [message("sent", role: "user")], hasOlder: true, hasNewer: false)
        backend.duringThreadFetch = {
            backend.duringThreadFetch = nil
            await window.load(.after, reconcile: true)
        }
        await window.load(.before)
        for _ in 0..<30 { await Task.yield() }
        #expect(window.transcript.messages.map(\.id) == ["older", "m", "sent"])
        #expect(backend.threadReads.count == 2)
    }

    @Test func memoryIsVisibleBeforeReadAndHydrationKeepsLocalLiveRows() async {
        let backend = FakeBackend()
        let local = message("m", text: "cached")
        let trace = ChatMessage(id: "trace", sessionId: "concierge", turnId: "turn", role: "trace", content: "[]", createdAt: local.createdAt)
        var withTurn = local
        withTurn.turnId = "turn"
        backend.stored = [message("other", root: "else"), withTurn, trace, message("tail")]
        backend.threadPages["open"] = ThreadPage(messages: [message("older"), local], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        backend.duringThreadFetch = {
            let focus = try! #require(store.threadFocus)
            #expect(focus.transcript.messages.map(\.id) == ["m", "trace", "tail"])
            #expect(focus.initial == .loading && focus.hasOlder && focus.hasNewer)
            await focus.load(.before)
            await focus.load(.after)
            #expect(backend.threadReads.count == 1)
            focus.receive(self.message("m", text: "live edit"))
            focus.receive(self.message("live"))
            #expect(focus.transcript.message("live") == nil)
            #expect(!store.showsQuoteBar)
        }
        await store.openThread(from: "m", row: "m:0", original: "root")
        let focus = try! #require(store.threadFocus)
        #expect(focus.initial == nil)
        #expect(focus.transcript.messages.map(\.id) == ["older", "m", "trace", "tail", "live"])
        #expect(focus.transcript.message("m")?.content == "live edit")
        #expect(store.composerReply?.messageId == "live" && !store.showsQuoteBar)
    }

    @Test func cachedFailureRetriesWithoutReplacingFocusAndExplicitReplyWins() async {
        let backend = FakeBackend()
        backend.stored = [message("m"), message("last")]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        store.reply(to: "m")
        backend.threadError = .network
        await store.openThread(from: "m", row: "m:0", original: "root")
        let focus = try! #require(store.threadFocus)
        #expect(focus.initial == .failed && focus.transcript.messages.count == 2)
        #expect(store.composerReply?.messageId == "m" && store.showsQuoteBar)
        store.dismissQuote()
        #expect(store.threadFocus === focus && !store.showsQuoteBar)
        #expect(store.composerReply?.messageId == "last" && store.quote == nil)
        backend.threadError = nil
        backend.threadPages["open"] = ThreadPage(messages: [message("m"), message("last")], hasOlder: false, hasNewer: false)
        store.retryThread()
        for _ in 0..<30 { await Task.yield() }
        #expect(store.threadFocus === focus && focus.initial == nil)
        #expect(backend.threadReads.count == 2 && !store.showsQuoteBar)
        store.closeThread()
        #expect(store.quote == nil && store.composerReply == nil)
    }

    @Test func oldReadCannotReplaceNewFocusAndPermissionDropsMemory() async {
        let backend = FakeBackend()
        backend.stored = [message("m"), message("new", root: "new")]
        backend.threadPages["open"] = ThreadPage(messages: [message("m")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        backend.duringThreadFetch = {
            backend.duringThreadFetch = nil
            store.closeThread()
            backend.threadPages["open"] = ThreadPage(messages: [self.message("new", root: "new")], hasOlder: false, hasNewer: false)
            await store.openThread(from: "new", row: "new:0", original: "new")
        }
        await store.openThread(from: "m", row: "m:0", original: "root")
        #expect(store.threadFocus?.anchor == "new")
        #expect(store.threadFocus?.transcript.messages.map(\.id) == ["new"])
        store.closeThread()
        backend.threadError = .server(status: 403, message: nil)
        await store.openThread(from: "m", row: "m:0", original: "root")
        #expect(store.threadFocus == nil)
    }

    @Test func explicitReplyToBackfilledMessageKeepsPriorityAndCancelStaysInThread() async {
        let backend = FakeBackend()
        backend.stored = [message("m")]
        backend.threadPages["open"] = ThreadPage(messages: [message("backfilled"), message("m"), message("last")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        await store.openThread(from: "m", row: "m:0", original: "root")
        let focus = store.threadFocus
        store.reply(to: "backfilled")
        #expect(store.showsQuoteBar && store.quotedMessage?.id == "backfilled")
        _ = store.send("explicit", reply: store.composerReply)
        for _ in 0..<20 { await Task.yield() }
        #expect(backend.sentReplies.first.flatMap { $0 }?.messageId == "backfilled")
        store.dismissQuote()
        #expect(store.threadFocus === focus && store.composerReply?.messageId == "last")
        #expect(!store.showsQuoteBar)
    }

    @Test func retryMissingStillFallsBackToTheOriginalQuote() async {
        let backend = FakeBackend()
        backend.stored = [message("original"), message("m")]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        backend.threadError = .network
        await store.openThread(from: "m", row: "m:0", original: "original")
        #expect(store.threadFocus?.initial == .failed)
        backend.threadError = .notFound
        store.retryThread()
        for _ in 0..<20 { await Task.yield() }
        #expect(store.threadFocus == nil && store.jumpTarget == "original")
    }

    @Test func settledCardDuringInitialReadWinsOverItsOldServerCopy() throws {
        let card = #"{"kind":"approval","id":"ap","title":"Send","actionName":"send","since":7}"#
        let content = #"[{"type":"task_chat","chatId":"task","title":"T","card":\#(card)}]"#
        let held = message("m", text: content)
        let window = ThreadFocus(sessionId: "concierge", anchor: "m", row: "m:0", bubbleY: nil, page: ThreadPage(messages: [held], hasOlder: true, hasNewer: true), backend: FakeBackend(), pending: true)
        let settled = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"kind":"approval","id":"ap","title":"Send","actionName":"send","since":7,"outcome":{"kind":"approved"}}"#.utf8))
        window.handle(.cardSettled(sessionId: "concierge", card: settled), sessionId: "concierge")
        #expect(window.transcript.messages[0].content.contains("approved"))
        window.hydrate(ThreadPage(messages: [held], hasOlder: false, hasNewer: false))
        #expect(window.transcript.messages[0].content.contains("approved"))
    }

    @Test func stoppingTheChatWhileReadIsHeldDiscardsItsResponse() async {
        let backend = FakeBackend()
        backend.stored = [message("m")]
        backend.threadPages["open"] = ThreadPage(messages: [message("m"), message("late")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        backend.duringThreadFetch = { store.stop() }
        await store.openThread(from: "m", row: "m:0", original: "root")
        #expect(store.threadFocus == nil && store.messages.map(\.id) == ["m"])
    }

    @Test func aSendToTheChainShowsInItWhileItSendsAndAfterItFails() async throws {
        let backend = FakeBackend()
        backend.threadPages["open"] = ThreadPage(messages: [message("m")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.openThread(from: "m", row: "m:0", original: "m")
        let focus = try #require(store.threadFocus)
        #expect(store.send("next", reply: store.composerReply))
        #expect(focus.transcript.pending.map(\.text) == ["next"])
        for _ in 0..<20 { await Task.yield() }
        let failed = try #require(focus.transcript.pending.first)
        guard case .failed = failed.state else { Issue.record("the send did not fail"); return }
        #expect(focus.transcript.rows.contains { $0.id == failed.id || $0.id.hasPrefix("\(failed.id):") })
        // Its Retry and Delete act on the chat, which holds the send.
        store.actions.remove(failed.id)
        #expect(store.pending.isEmpty && focus.transcript.pending.isEmpty)
        // A send to no message of the chain stays the chat's alone.
        #expect(store.send("elsewhere"))
        #expect(store.pending.count == 1 && focus.transcript.pending.isEmpty)
    }

    @Test func aHydratedEditSurvivesAnUnrelatedArrivalInTheChat() async throws {
        let backend = FakeBackend()
        backend.stored = [message("m", text: "cached")]
        backend.threadPages["open"] = ThreadPage(messages: [message("m", text: "edited")], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try? await Task.sleep(for: .milliseconds(10)) }
        await store.openThread(from: "m", row: "m:0", original: "m")
        let focus = try #require(store.threadFocus)
        #expect(focus.transcript.message("m")?.content == "edited")
        backend.bus.emit(LiveTopic.chat("concierge"), .messageInsert(message("other", root: "other")))
        #expect(store.message("other") != nil && store.message("m")?.content == "cached")
        #expect(focus.transcript.message("m")?.content == "edited")
    }

    @Test func aRetrysReadSupersedesLiveEditsDrawnBeforeIt() async throws {
        let backend = FakeBackend()
        backend.stored = [message("m", text: "cached")]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        backend.threadError = .network
        await store.openThread(from: "m", row: "m:0", original: "m")
        let focus = try #require(store.threadFocus)
        #expect(focus.initial == .failed)
        focus.receive(message("m", text: "early edit"))
        focus.receive(message("late"))
        #expect(focus.transcript.message("m")?.content == "early edit" && focus.transcript.message("late") == nil)
        backend.threadError = nil
        backend.threadPages["open"] = ThreadPage(messages: [message("m", text: "newest")], hasOlder: false, hasNewer: false)
        store.retryThread()
        for _ in 0..<30 { await Task.yield() }
        #expect(focus.initial == nil)
        #expect(focus.transcript.message("m")?.content == "newest")
        // An arrival not drawn before the retry still joins at the newest end.
        #expect(focus.transcript.messages.map(\.id) == ["m", "late"])
    }

    @Test func shareFromAFocusedRowClosesTheChainAndPicksTheRowsTurn() async {
        let backend = FakeBackend()
        var answer = message("answer")
        answer.turnId = "t9"
        backend.stored = [message("m")]
        backend.threadPages["open"] = ThreadPage(messages: [message("m"), answer], hasOlder: false, hasNewer: false)
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        await store.reload()
        await store.openThread(from: "m", row: "m:0", original: "m")
        #expect(store.message("answer") == nil)
        store.actions.share(fromRow: "answer:0")
        #expect(store.threadFocus == nil)
        #expect(store.share.selection == ["t9"])
    }

    @Test func closeReleasesFocusTranscript() {
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: FakeBackend())
        weak var child: TranscriptStore?
        do {
            let window = focus([message("m")])
            child = window.transcript
            store.threadFocus = window
        }
        store.closeThread()
        #expect(child == nil)
    }
}

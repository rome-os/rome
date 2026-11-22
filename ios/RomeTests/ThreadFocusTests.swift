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
        #expect(store.quotedMessage?.id == "last")
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
        #expect(store.threadFocus == nil && store.jumpTarget == nil)
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

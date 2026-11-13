import Foundation
import Testing
import UIKit
@testable import Rome

/// A message that did not go through shows an icon and a menu, not lines of text.
@MainActor
@Suite struct SendProblemTests {
    @Test func eachStateSaysWhyAndWhatCanBeDone() throws {
        let retryable = try #require(SendProblem(.failed(.offline), onRetry: {}, onDelete: {}))
        #expect(retryable.title == "Not sent · No network" && retryable.retryTitle == "Retry" && !retryable.calm)
        // A refusal stays one: no Retry, the text can still be copied or the send deleted.
        let refused = try #require(SendProblem(.failed(.archived), onRetry: {}, onDelete: {}))
        #expect(refused.retryTitle == nil && refused.onDelete != nil)
        // Not delivered joins a failed send: one icon, and Retry hands it over again.
        let lost = try #require(SendProblem(.notDelivered, onRetry: {}, onDelete: nil))
        #expect(lost.title == "Not delivered" && lost.retryTitle == "Retry" && !lost.calm && lost.onDelete == nil)
        // Unconfirmed is less than a failure: a calmer icon, and "Send again".
        let unsure = try #require(SendProblem(.unconfirmed, onRetry: {}, onDelete: nil))
        #expect(unsure.title == "Not sure Chat got this. You can send it again." && unsure.retryTitle == "Send again" && unsure.calm)
        #expect(SendProblem(.sending, onRetry: {}, onDelete: nil) == nil)
        #expect(SendProblem(nil, onRetry: {}, onDelete: nil) == nil)
    }

    private func stored(_ id: String, inputState: String?, text: String = "hello", extra: String = "", thread: String? = nil, seconds: Double = 0) -> ChatMessage {
        let body = String(data: try! JSONEncoder().encode(text), encoding: .utf8)!
        var message = ChatMessage(id: id, sessionId: conciergeChatID, role: "user", content: "[\(extra){\"type\":\"text\",\"content\":\(body)}]", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), chatThreadId: thread, knowsThreads: true)
        message.inputState = inputState
        return message
    }

    /// A resend goes where the message went: its task thread, replying to the
    /// message it quoted.
    @Test func aResendKeepsItsThreadAndReply() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let quote = #"{"type":"reply_to","messageId":"m-9","text":"Which day?"},"#
        backend.stored = [stored("in-3", inputState: "failed", extra: quote, thread: "root-1")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-3:1")
        for _ in 0..<100 where backend.sentThreads.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        let target = backend.sentThreads.first ?? nil
        #expect(target?.body == ["replyToMessageId": .string("m-9"), "chatThread": .string("root-1")])
        #expect(store.pending.first?.thread == target)
    }

    /// A message in a thread with no quote goes back to the thread alone; one
    /// in neither goes to the chat.
    @Test func aResendTargetFollowsTheStoredMessage() {
        let inThread = TranscriptStore.resendTarget(of: stored("a", inputState: "failed", thread: "root-1"))
        #expect(inThread?.body == ["chatThread": .string("root-1")])
        #expect(TranscriptStore.resendTarget(of: stored("b", inputState: "failed")) == nil)
    }

    /// A resend hides only its own original, by the pair recorded when it
    /// went, and a relaunch keeps the pair. A later message that only repeats
    /// the words, or an independent photo, hides nothing.
    @Test func aResentMessageStaysHiddenAfterARelaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "rome-resend-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let drafts = DraftStore(root: root, instance: "t")
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.stored = [
            stored("in-4", inputState: "failed"),
            // Never resent: the same words later, and an unrelated failure.
            stored("in-5", inputState: "failed", text: "ok", seconds: 1),
            stored("in-6", inputState: nil, text: "ok", seconds: 2),
        ]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.drafts = ChatDrafts(store: drafts, chat: conciergeChatID)
        await store.reload()
        store.retry("in-4:0")
        for _ in 0..<100 where backend.sentInputIds.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        let copy = try #require(backend.sentInputIds.first)
        #expect(store.resends == ["in-4": copy])

        // A relaunch: a new store reads the pair, and the copy is stored.
        await drafts.flush()
        backend.stored.append(stored(copy, inputState: nil, seconds: 10))
        let fresh = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        fresh.drafts = ChatDrafts(store: drafts, chat: conciergeChatID)
        await fresh.reload()
        let ids = fresh.rows.compactMap { row -> String? in if case .userText(let id, _, _, _) = row { return id } else { return nil } }
        #expect(ids == ["in-5:0", "in-6:0", "\(copy):0"])
    }

    /// A copy that never reached the instance and is gone (a relaunch drops
    /// it) brings its original back, Retry and all.
    @Test func aLostCopyBringsTheOriginalBack() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "rome-resend-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let drafts = DraftStore(root: root, instance: "t")
        drafts.saveResends(chat: conciergeChatID, ["in-9": "lost-copy"])
        await drafts.flush()
        let backend = FakeBackend()
        backend.stored = [stored("in-9", inputState: "failed")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.drafts = ChatDrafts(store: drafts, chat: conciergeChatID)
        await store.reload()
        #expect(store.rows.contains { $0.id == "in-9:0" })
    }

    /// The thread view pairs a resend as the timeline does: its copy shows
    /// in the original's place, on its way or stored only in the thread's
    /// own read, never both and never neither.
    @Test func theThreadViewShowsTheCopyNotTheOriginal() async throws {
        let backend = FakeBackend()
        backend.sendError = .network
        var root = stored("root", inputState: nil, text: "plan the trip", thread: "root")
        root.chatThreadTitle = "Trip"
        backend.stored = [root, stored("in-11", inputState: "failed", text: "and hotels", thread: "root", seconds: 5)]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.openThread(at: "root")
        let thread = try #require(store.thread)
        store.retry("in-11:0")
        for _ in 0..<100 where store.pending.first?.state == .sending || store.pending.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        let copy = try #require(store.pending.first?.id)
        func ids() -> [String] { thread.rows(answers: [:]).compactMap { row -> String? in if case .userText(let id, _, _, _) = row { return id } else { return nil } } }
        // On its way: the copy in the original's place.
        #expect(ids() == ["root:0", copy])
        // Sent and stored, but held only by the thread's own read: the copy
        // shows once, and the original stays hidden.
        backend.sendError = .network
        backend.sendSucceeds = true
        store.retry(copy)
        for _ in 0..<100 where store.pending.first?.state != .sent { try? await Task.sleep(for: .milliseconds(10)) }
        var stored = stored(copy, inputState: nil, text: "and hotels", thread: "root", seconds: 9)
        stored.chatThreadTitle = "Trip"
        backend.threads["root"] = [root, backend.stored[1], stored]
        await thread.load()
        #expect(ids() == ["root:0", "\(copy):0"])
        store.closeThread()
    }

    /// A resend of a document keeps it: sent as a file, and drawn as a tile
    /// in the pending bubble, not an empty one.
    @Test func aDocumentResendShowsItsFile() async {
        let backend = FakeBackend()
        let paper = "fedcba9876543210fedcba9876543210.pdf"
        backend.apiFiles = ["/assets/\(paper)": Data("%PDF".utf8)]
        backend.stored = [stored("in-10", inputState: "failed", text: "- File 1: [plan.pdf](</api/assets/\(paper)>)")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-10:0")
        for _ in 0..<200 where store.pending.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        let tiles = store.rows.compactMap { row -> [UserImage]? in if case .userText(let id, _, let images, _) = row, id == store.pending.first?.id { return images } else { return nil } }.first
        #expect(tiles?.count == 1)
        if case .stored(let upload)? = tiles?.first { #expect(upload.name == "plan.pdf" && !upload.isImage) } else { Issue.record("no tile") }
    }

    /// A resend carries the message's files as files, read back from the
    /// instance, not as the link lines the instance wrote into its text.
    @Test func aResendSendsItsFilesAsFiles() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        let picture = "0123456789abcdef0123456789abcdef.png", paper = "fedcba9876543210fedcba9876543210.pdf"
        backend.apiFiles = [
            "/assets/\(picture)": UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) },
            "/assets/\(paper)": Data("%PDF".utf8),
        ]
        let text = "Look\n\n- File 1: [shot.png](</api/assets/\(picture)>)\n- File 2: [plan.pdf](</api/assets/\(paper)>)"
        backend.stored = [stored("in-7", inputState: "failed", text: text)]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-7:0")
        for _ in 0..<200 where backend.sentInputIds.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.calls.last == "send \(conciergeChatID) Look [2 files]")
        #expect(backend.sentFiles.map(\.mimeType) == ["image/jpeg", "application/pdf"])
        #expect(backend.sentFiles.last?.name == "plan.pdf")
        #expect(store.pending.first?.images.count == 1)
    }

    /// A resend the guardian then deletes brings the stored message back.
    @Test func deletingAResendShowsTheStoredMessageAgain() async {
        let backend = FakeBackend()
        backend.stored = [stored("in-8", inputState: "failed")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-8:0")
        for _ in 0..<100 where store.pending.first?.state == .sending || store.pending.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        store.removePending(store.pending[0].id)
        let ids = store.rows.compactMap { row -> String? in if case .userText(let id, _, _, _) = row { return id } else { return nil } }
        #expect(ids == ["in-8:0"])
    }

    /// Retry on a stored message is a new send with a fresh id (the instance drops
    /// the old id as a duplicate), and the stored bubble gives way to it.
    @Test func retryOfAStoredMessageIsANewSendThatReplacesIt() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.stored = [stored("in-1", inputState: "failed")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        #expect(!store.isPending("in-1:0"))
        store.retry("in-1:0")
        for _ in 0..<100 where backend.sentInputIds.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.sentInputIds.count == 1 && backend.sentInputIds[0] != "in-1")
        #expect(backend.calls.last == "send \(conciergeChatID) hello")
        // One bubble for the message: the stored one is not drawn beside the new one.
        let texts = store.rows.compactMap { row -> String? in if case .userText(_, let text, _, _) = row { return text } else { return nil } }
        #expect(texts == ["hello"])
        #expect(Array(store.resends.keys) == ["in-1"])
    }

    /// A send the app still holds keeps its own id when retried: the instance's dedupe is right there.
    @Test func retryOfAPendingSendKeepsItsId() async {
        let backend = FakeBackend()
        backend.sendError = .network
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.send("later")
        for _ in 0..<50 { try? await Task.sleep(for: .milliseconds(10)) }
        let id = store.pending[0].id
        #expect(store.isPending(id))
        backend.sendError = .network
        store.retry(id)
        for _ in 0..<50 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.sentInputIds == [id, id])
        store.removePending(id)
        #expect(!store.isPending(id))
    }

    /// A retry that fails again is the new bubble's own failure, with its own icon.
    @Test func aFailedRetryOfAStoredMessageShowsItsOwnIcon() async {
        let backend = FakeBackend()
        backend.sendError = .network
        backend.stored = [stored("in-2", inputState: "unknown")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-2:0")
        for _ in 0..<100 where store.pending.first?.state == .sending || store.pending.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.pending.first?.state == .failed(.unreachable))
        #expect(store.isPending(store.pending[0].id))
    }
}

/// A failed load is tried again where the guardian can see it.
@MainActor
@Suite struct LoadRetryTests {
    private func failedStore(_ backend: FakeBackend) async -> TranscriptStore {
        backend.messagesError = .server(status: 404, message: nil)
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        #expect(store.loadFailed)
        return store
    }

    /// One bar: a retry turns its Retry into a spinner, and a failed one
    /// shows Retry again and shakes; a good one takes the bar away.
    @Test func retryKeepsOneBarAndShakesOnFailure() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        store.retryHold = .milliseconds(50)
        #expect(store.loadBar == .failed && store.retryFailures == 0)
        store.retryLoad()
        #expect(store.loadBar == .retrying && TranscriptBanners.shows(store))
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == .failed && store.retryFailures == 1)

        // The next attempt works: the bar goes, with no shake.
        backend.messagesError = nil
        store.retryLoad()
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == nil && !TranscriptBanners.shows(store) && store.retryFailures == 1)
    }

    /// An attempt that fails at once still shows its spinner for the hold,
    /// and one that works keeps the spinner until then too.
    @Test func theSpinnerShowsForAtLeastTheHold() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        store.retryHold = .milliseconds(400)
        let started = ContinuousClock.now
        store.retryLoad()
        // The read fails at once; the spinner stays.
        try? await Task.sleep(for: .milliseconds(150))
        #expect(store.loadBar == .retrying)
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(ContinuousClock.now - started >= .milliseconds(400))
        #expect(store.loadBar == .failed)
        // A second press while one runs starts nothing more.
        store.retryHold = .milliseconds(50)
        store.retryLoad()
        let reads = backend.newestFetches
        store.retryLoad()
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.newestFetches <= reads + 1)
    }

    /// Entering a chat whose load failed starts the reload at once: the bar
    /// shows the spinner, not a Retry left from before.
    @Test func comingBackTriesAFailedLoadAtOnce() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        store.retryHold = .milliseconds(50)
        backend.messagesError = nil
        store.chatShown()
        #expect(store.loadBar == .retrying)
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == nil && store.loaded)

        // A chat that loaded fine only looks at its running turn.
        store.chatShown()
        #expect(!store.retrying)
    }

    /// A chat whose first read failed is not known to be empty: no starter
    /// prompts under the bar until a read works.
    @Test func aFailedFirstLoadShowsNoStarters() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        #expect(store.loaded && !store.readOnce)
        #expect(!ConciergeStarters.visible(loaded: store.readOnce, rows: store.rows))
        backend.messagesError = nil
        await store.reload()
        #expect(ConciergeStarters.visible(loaded: store.readOnce, rows: store.rows))
    }

    /// Entering a task chat again after its load failed shows the spinner
    /// at once, then Retry with a shake when that fails too.
    @Test func reenteringAFailedTaskChatRetriesAtOnce() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 503, message: nil)
        let store = TranscriptStore(sessionId: "task-1", kind: .task, backend: backend)
        store.retryHold = .milliseconds(50)
        await store.reload()
        #expect(store.loadBar == .failed)
        store.start()
        #expect(store.loadBar == .retrying)
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == .failed && store.retryFailures == 1)
        store.stop()
    }
}

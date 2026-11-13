import Foundation
import Testing
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

    private func stored(_ id: String, inputState: String) -> ChatMessage {
        var message = ChatMessage(id: id, sessionId: conciergeChatID, role: "user", content: #"[{"type":"text","content":"hello"}]"#, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
        message.inputState = inputState
        return message
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
        #expect(store.replaced == ["in-1"])
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

    /// Retry hides the banner, shows the attempt, and the banner returns only when it fails again.
    @Test func retryShowsTheAttemptAndTheBannerComesBackOnlyOnFailure() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        backend.duringNewestFetch = { }
        store.retryLoad()
        #expect(store.retrying && !store.loadFailed && TranscriptBanners.shows(store))
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(!store.retrying && store.loadFailed)

        // The next attempt works: no banner at all.
        backend.messagesError = nil
        store.retryLoad()
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(!store.retrying && !store.loadFailed && !TranscriptBanners.shows(store))
    }

    /// Coming back to a chat clears an old banner and tries at once.
    @Test func comingBackTriesAFailedLoadAtOnce() async {
        let backend = FakeBackend()
        let store = await failedStore(backend)
        backend.messagesError = nil
        store.chatShown()
        #expect(!store.loadFailed)
        for _ in 0..<100 where store.retrying { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(!store.loadFailed && store.loaded)

        // A chat that loaded fine only looks at its running turn.
        store.chatShown()
        #expect(!store.retrying)
    }
}

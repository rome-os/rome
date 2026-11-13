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

    /// Retry on a stored message hands it over again under the id it has, and only the app's own sends can be deleted.
    @Test func retryRedeliversAStoredMessageWithItsInputId() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.stored = [stored("in-1", inputState: "failed")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        #expect(!store.isPending("in-1:0"))
        store.retry("in-1:0")
        for _ in 0..<100 where backend.sentInputIds.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(backend.sentInputIds == ["in-1"])
        #expect(backend.calls.last == "send \(conciergeChatID) hello")

        // A send the app holds is sent again and can be deleted.
        backend.sendSucceeds = false
        backend.sendError = .network
        store.send("later")
        for _ in 0..<50 { try? await Task.sleep(for: .milliseconds(10)) }
        let pendingId = store.pending[0].id
        #expect(store.isPending(pendingId))
        store.removePending(pendingId)
        #expect(!store.isPending(pendingId))
    }

    @Test func aFailedRedeliverSaysSo() async {
        let backend = FakeBackend()
        backend.sendError = .network
        backend.stored = [stored("in-2", inputState: "unknown")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        store.retry("in-2:0")
        for _ in 0..<100 where store.notice == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.notice != nil)
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

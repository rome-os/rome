import Testing
@testable import Rome

/// A failed read of a chat is tried again by itself, and shows only when
/// the try after it fails too.
@MainActor
@Suite struct LoadAutoRetryTests {
    /// One failed read is often a blip, such as the network waking after the
    /// lock screen: nothing shows, and a chat that never loaded keeps its
    /// spinner. The second failure in a row shows, offline as well.
    @Test func onlyASecondFailureInARowShows() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 503, message: nil)
        let store = TranscriptStore(sessionId: "task-1", kind: .task, backend: backend)
        await store.reload()
        #expect(store.loadBar == nil && !store.loaded && !TranscriptBanners.shows(store))
        await store.reload()
        #expect(store.loadBar == .failed && store.loaded)

        // A read that works starts the count over.
        backend.messagesError = nil
        await store.reload()
        #expect(store.loadBar == nil)
        backend.messagesError = .offline
        await store.reload()
        #expect(!TranscriptBanners.shows(store))
        await store.reload()
        #expect(store.loadError == .offline && TranscriptBanners.shows(store))
    }

    /// While a screen runs the store, a failed read is tried again by
    /// itself: the bar comes with the second failure and goes once a try
    /// works, with no Retry pressed.
    @Test func aFailedReadIsTriedAgainByItself() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 502, message: nil)
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.autoRetryFirst = .milliseconds(20)
        store.start()
        for _ in 0..<200 where store.loadBar != .failed { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == .failed && store.retryFailures == 0)
        backend.messagesError = nil
        for _ in 0..<200 where store.loadBar != nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == nil && store.readOnce)
        store.stop()
    }

    /// Back in front, the chat reads at once and again as the socket
    /// confirms: two reads that fail together are one blip, and only the
    /// retry that follows failing too shows the bar.
    @Test func readsThatFailWhileARetryWaitsCountOnce() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 503, message: nil)
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.autoRetryFirst = .milliseconds(300)
        store.start()
        for _ in 0..<200 where backend.pageLimits.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        await store.reload()
        await store.reload()
        #expect(store.loadBar == nil)
        for _ in 0..<200 where store.loadBar != .failed { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.loadBar == .failed)
        store.stop()
    }

    /// A store no screen runs tries nothing more.
    @Test func stoppingEndsTheRetries() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 503, message: nil)
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.autoRetryFirst = .milliseconds(30)
        store.start()
        for _ in 0..<200 where backend.pageLimits.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        store.stop()
        let reads = backend.pageLimits.count
        try? await Task.sleep(for: .milliseconds(200))
        #expect(backend.pageLimits.count == reads)
    }
}

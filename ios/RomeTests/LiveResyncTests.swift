import Foundation
import Testing
@testable import Rome

@Suite struct LiveResyncTests {
    @Test func firstConnectionOwesNothing() {
        var resync = LiveResync()
        resync.connecting(topics: ["a", "b"])
        let owed1 = resync.confirmed("a")
        #expect(!owed1)
        let owed2 = resync.confirmed("b")
        #expect(!owed2)
    }

    @Test func reconnectAfterADropOwesEachHeldTopicOnce() {
        var resync = LiveResync()
        resync.connecting(topics: ["a", "b"])
        resync.dropped()
        resync.connecting(topics: ["a", "b"])
        let owed3 = resync.confirmed("a")
        #expect(owed3)
        let owed4 = resync.confirmed("a")
        #expect(!owed4)
        let owed5 = resync.confirmed("b")
        #expect(owed5)
        // A topic first subscribed on this connection was loaded fresh.
        let owed6 = resync.confirmed("c")
        #expect(!owed6)
    }

    @Test func aConnectionThatFailsBeforeConfirmingStillOwes() {
        var resync = LiveResync()
        resync.connecting(topics: ["a"])
        resync.dropped()
        resync.connecting(topics: ["a"])
        resync.dropped()
        resync.connecting(topics: ["a"])
        let owed7 = resync.confirmed("a")
        #expect(owed7)
    }

    @Test func aHealthyConnectionOwesNothingLater() {
        var resync = LiveResync()
        resync.dropped()
        resync.connecting(topics: ["a"])
        let owed8 = resync.confirmed("a")
        #expect(owed8)
        resync.connecting(topics: ["a"])
        let owed9 = resync.confirmed("a")
        #expect(!owed9)
    }
}

@MainActor
@Suite struct LiveResumeTests {
    /// Nothing listens on port 9, so the socket never receives a frame.
    private func socket() -> LiveEventsSocket {
        LiveEventsSocket(client: APIClient(origin: URL(string: "http://127.0.0.1:9")!, token: { nil }))
    }

    @Test func resumeAsksListenersToRefetchWithoutAnyFrame() {
        let events = socket()
        var refetches = 0
        _ = events.subscribe(LiveTopic.chat("concierge")) { event in
            if case .reconnected = event { refetches += 1 }
        }
        events.pause()
        events.resume()
        #expect(refetches == 1)
        events.pause()
    }

    @Test func resumeWithoutAPauseAsksNothing() {
        let events = socket()
        var refetches = 0
        _ = events.subscribe(LiveTopic.chatStatus) { event in
            if case .reconnected = event { refetches += 1 }
        }
        events.resume()
        events.pause()
        events.pause()
        events.resume()
        #expect(refetches == 1)
        events.pause()
    }
}

@MainActor
@Suite struct ResyncCoalescingTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func aBurstOfRefetchRequestsReloadsOnce() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle()
        let before = backend.newestFetches
        // A resume and two confirmed topics, all at once.
        backend.bus.emit(LiveTopic.chat("concierge"), .reconnected)
        backend.bus.emit(LiveTopic.chatStatus, .reconnected)
        store.resync()
        await settle()
        #expect(backend.newestFetches - before == 1)
    }

    @Test func requestsDuringAReloadAddOneMore() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle()
        let before = backend.newestFetches
        backend.duringNewestFetch = {
            backend.bus.emit(LiveTopic.chat("concierge"), .reconnected)
            backend.bus.emit(LiveTopic.chatStatus, .reconnected)
        }
        store.resync()
        await settle()
        #expect(backend.newestFetches - before == 2)
    }

    @Test func aResumedChatShowsWhatArrivedWhileAway() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle()
        let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "It reported back: ready."]]), encoding: .utf8)!
        backend.stored.append(ChatMessage(id: "late", sessionId: "concierge", role: "assistant", content: content, createdAt: RomeDate.string(.now)))
        backend.bus.emit(LiveTopic.chat("concierge"), .reconnected)
        await settle()
        #expect(store.messages.map(\.id).contains("late"))
    }

    @Test func taskListRefreshesOnceForABurst() async {
        let backend = FakeBackend()
        let store = TasksStore(backend: backend)
        store.start()
        await settle()
        let before = backend.taskFetches
        backend.bus.emit(LiveTopic.conciergeTasks, .reconnected)
        backend.bus.emit(LiveTopic.chatStatus, .reconnected)
        await settle()
        #expect(backend.taskFetches - before == 1)
    }
}

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

    /// A socket that was never paused may have sat through a suspension.
    @Test func resumeWithoutAPauseStillRefetches() {
        let events = socket()
        var refetches = 0
        _ = events.subscribe(LiveTopic.chatStatus) { event in
            if case .reconnected = event { refetches += 1 }
        }
        events.resume()
        #expect(refetches == 1)
        events.resume()
        #expect(refetches == 2)
        events.pause()
    }
}

@Suite struct ForegroundGateTests {
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func backgroundAlwaysRefetches() {
        var gate = ForegroundGate()
        gate.resignedActive(at: start)
        gate.enteredBackground(at: start)
        let refetch1 = gate.becameActive(at: start + 0.2)
        #expect(refetch1)
    }

    /// Without a background notification, as when pausing never ran.
    @Test func longInactiveRefetches() {
        var gate = ForegroundGate()
        gate.resignedActive(at: start)
        let refetch2 = gate.becameActive(at: start + 90)
        #expect(refetch2)
    }

    @Test func aBriefInactiveMomentDoesNot() {
        var gate = ForegroundGate()
        gate.resignedActive(at: start)
        let refetch3 = gate.becameActive(at: start + 0.4)
        #expect(!refetch3)
    }

    @Test func eachTripCountsOnce() {
        var gate = ForegroundGate()
        gate.enteredBackground(at: start)
        let refetch4 = gate.becameActive(at: start + 5)
        #expect(refetch4)
        let refetch5 = gate.becameActive(at: start + 6)
        #expect(!refetch5)
        var fresh = ForegroundGate()
        let freshRefetch = fresh.becameActive(at: start)
        #expect(!freshRefetch)
    }
}

/// Fails the first request with a dead connection, then answers.
final class DeadThenAliveProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requests = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        if Self.requests == 1 {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct ConnectionLostRetryTests {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeadThenAliveProtocol.self]
        return URLSession(configuration: configuration)
    }

    @Test func aGetIsSentOnceMore() async throws {
        DeadThenAliveProtocol.requests = 0
        var request = URLRequest(url: URL(string: "https://rome.test/api/x")!)
        request.httpMethod = "GET"
        _ = try await APIClient.data(for: request, in: session())
        #expect(DeadThenAliveProtocol.requests == 2)
    }

    @Test func aPostIsNotRepeated() async {
        DeadThenAliveProtocol.requests = 0
        var request = URLRequest(url: URL(string: "https://rome.test/api/x")!)
        request.httpMethod = "POST"
        await #expect(throws: URLError.self) { _ = try await APIClient.data(for: request, in: session()) }
        #expect(DeadThenAliveProtocol.requests == 1)
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
        let arrivalsBefore = store.arrivals
        backend.bus.emit(LiveTopic.chat("concierge"), .reconnected)
        await settle()
        #expect(store.messages.map(\.id).contains("late"))
        // Counted like a live reply, so the list can offer "New messages".
        #expect(store.arrivals == arrivalsBefore + 1)
    }

    @Test func theFirstLoadIsNotAnArrival() async {
        let backend = FakeBackend()
        let content = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "content": "Earlier"]]), encoding: .utf8)!
        backend.stored = [ChatMessage(id: "old", sessionId: "concierge", role: "assistant", content: content, createdAt: RomeDate.string(.now))]
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.start()
        await settle()
        #expect(store.messages.count == 1)
        #expect(store.arrivals == 0)
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

import Foundation
import Testing
@testable import Rome

/// A search answer held until the test lets it through.
@MainActor
private final class Gate {
    private var waiting: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { waiting != nil }
    func wait() async { await withCheckedContinuation { waiting = $0 } }
    func open() { waiting?.resume(); waiting = nil }
}

@MainActor
@Suite struct ScreenStateTests {
    private func hit(_ id: String) -> SearchHit {
        SearchHit(session: ChatSession(id: "concierge", name: "Chat"), message: .init(id: id, role: "assistant", snippet: id, createdAt: "2026-11-07T10:00:00Z"))
    }

    /// The older search answers last: the newer one's results stay. A search
    /// still on its way when the field is cleared fills nothing.
    @Test func onlyTheNewestSearchFillsTheResults() async {
        let search = MessageSearch()
        let gate = Gate()
        let older = Task {
            await search.run("ab") { _ in
                await gate.wait()
                return [hit("old")]
            }
        }
        while !gate.isWaiting { await Task.yield() }
        await search.run("abc") { _ in [hit("new")] }
        #expect(search.hits.map(\.id) == ["new"])
        gate.open()
        await older.value
        #expect(search.hits.map(\.id) == ["new"])

        let cleared = Task {
            await search.run("abcd") { _ in
                await gate.wait()
                return [hit("late")]
            }
        }
        while !gate.isWaiting { await Task.yield() }
        search.cancel(clearing: true)
        gate.open()
        await cleared.value
        #expect(search.hits.isEmpty)
        #expect(!search.searched)
        #expect(!search.searching)
    }

    /// The main Chat stays mounted under other pages: replies are marked read
    /// only while it shows, and once when it shows again.
    @Test func hiddenChatMarksNothingRead() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "concierge", kind: .concierge, backend: backend)
        store.arrived()
        store.onScreen = true
        store.arrived()
        store.onScreen = false
        store.arrived()
        store.arrived()
        store.onScreen = true
        for _ in 0..<50 where backend.reads.count < 3 { try? await Task.sleep(for: .milliseconds(10)) }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(backend.reads == ["concierge", "concierge", "concierge"])
    }
}

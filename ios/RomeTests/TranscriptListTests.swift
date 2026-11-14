import SwiftUI
import Testing
@testable import Rome

/// Extra height per row, set by a test to make a row grow after it showed,
/// as a picture or a card that fills in does.
@MainActor
@Observable
private final class Growth {
    var extra: [String: CGFloat] = [:]
    @ObservationIgnored var frames: [String: CGRect] = [:]
}

private struct GrowthHost: View {
    let store: TranscriptStore
    let growth: Growth

    var body: some View {
        TranscriptList(store: store) { row, previous in
            VStack(spacing: 0) {
                switch row {
                case .userText(_, let text, _, let pending): UserBubble(text: text, pending: pending)
                case .agentText(_, let text, _, let forwarded, let position): AgentBubble(text: text, forwardedFrom: forwarded, position: position)
                default: EmptyView()
                }
                Color.clear.frame(height: growth.extra[row.id] ?? 0)
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { growth.frames[row.id] = $0 }
            .padding(.top, TranscriptSpacing.top(row, after: previous))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { Color.gray.frame(height: 66) }
    }
}

/// Rows that change height after they showed: the rows in view stay where
/// they are, and the list on the bottom stays on it.
@MainActor
@Suite(.serialized) struct LateGrowthTests {
    @MainActor
    private struct Shown {
        let window: UIWindow
        let scroll: UIScrollView
        let growth: Growth
        let store: TranscriptStore

        func close() {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }

        var toEnd: CGFloat { scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - scroll.contentOffset.y }

        /// The row nearest the middle of the screen.
        func middleRow() -> (id: String, y: CGFloat)? {
            growth.frames.filter { $0.value.minY > 300 && $0.value.minY < 600 }.min { $0.value.minY < $1.value.minY }.map { ($0.key, $0.value.minY) }
        }

        /// Reading higher up, as after a drag.
        func scrollUp(by distance: CGFloat) async throws {
            scroll.delegate?.scrollViewWillBeginDragging?(scroll)
            scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentOffset.y - distance), animated: false)
            scroll.delegate?.scrollViewDidEndDragging?(scroll, willDecelerate: false)
            try await Task.sleep(for: .milliseconds(300))
        }
    }

    private func show() async throws -> Shown {
        let backend = FakeBackend()
        // One page: no older page goes in during the test.
        backend.stored = (0..<30).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
        let growth = Growth()
        let host = UIHostingController(rootView: GrowthHost(store: store, growth: growth))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        try await Task.sleep(for: .milliseconds(800))
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        return Shown(window: window, scroll: scroll, growth: growth, store: store)
    }

    @Test func aRowAboveTheScreenThatGrowsMovesNothingInView() async throws {
        let shown = try await show()
        defer { shown.close() }
        try await shown.scrollUp(by: 900)
        let anchor = try #require(shown.middleRow())
        // The top row on screen, under the header, well above the one held.
        let above = try #require(shown.growth.frames.filter { $0.value.minY < 150 && $0.value.maxY > 0 }.min { $0.value.minY < $1.value.minY }?.key, "offset \(shown.scroll.contentOffset.y), frames \(shown.growth.frames.values.map { Int($0.minY) }.sorted())")

        shown.growth.extra[above] = 200
        try await Task.sleep(for: .milliseconds(500))
        let after = try #require(shown.growth.frames[anchor.id]).minY
        #expect(abs(after - anchor.y) < 1, "\(anchor.id) moved from \(anchor.y) to \(after) when \(above) grew")
    }

    @Test func aRowBelowTheScreenThatGrowsMovesNothingInView() async throws {
        let shown = try await show()
        defer { shown.close() }
        try await shown.scrollUp(by: 1200)
        let anchor = try #require(shown.middleRow())

        shown.growth.extra[shown.store.rows.last!.id] = 300
        try await Task.sleep(for: .milliseconds(500))
        let after = try #require(shown.growth.frames[anchor.id]).minY
        #expect(abs(after - anchor.y) < 1, "\(anchor.id) moved from \(anchor.y) to \(after)")
    }

    @Test func theLastRowGrowingKeepsTheListOnTheBottom() async throws {
        let shown = try await show()
        defer { shown.close() }
        #expect(abs(shown.toEnd) < 1, "not on the bottom: \(shown.toEnd)")

        // A streamed reply growing, in steps.
        let last = shown.store.rows.last!.id
        for step in 1...6 {
            shown.growth.extra[last] = CGFloat(step) * 40
            try await Task.sleep(for: .milliseconds(100))
            #expect(abs(shown.toEnd) < 1, "step \(step): \(shown.toEnd) from the bottom")
        }
    }
}

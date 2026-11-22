import SwiftUI
import Testing
@testable import Rome

@MainActor
@Suite(.serialized) struct ThreadFocusLayoutTests {
    @Test(arguments: [CGFloat(180), CGFloat(470), CGFloat(700)])
    func firstLayoutKeepsTheAnchorInWindowCoordinates(y: CGFloat) async throws {
        let backend = FakeBackend()
        let messages = (0..<12).map { index in
            ChatMessage(id: "m\(index)", sessionId: "s", role: "user", content: "Message \(index)", createdAt: "2026-11-22T10:00:00Z", chatThreadId: "m0")
        }
        let focus = ThreadFocus(sessionId: "s", anchor: "m10", row: "m10:0", bubbleY: y, page: ThreadPage(messages: messages, hasOlder: true, hasNewer: false), backend: backend)
        let host = UIHostingController(rootView:
            TranscriptList(store: focus.transcript, alignTop: true, thread: focus) { row, previous in
                Text(row.id).frame(height: 70)
                    .padding(.top, TranscriptSpacing.top(row, after: previous))
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 66) }
        )
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
        }
        try await Task.sleep(for: .milliseconds(600))
        let list = try #require(ColdLaunchAnchorTests.transcript(in: host.view) as? UICollectionView)
        let cell = try #require(list.visibleCells.first { $0.accessibilityIdentifier == "m10:0" })
        let index = try #require(focus.transcript.rows.firstIndex { $0.id == "m10:0" })
        let gap = TranscriptSpacing.top(focus.transcript.rows[index], after: index > 0 ? focus.transcript.rows[index - 1] : nil)
        let actual = cell.convert(cell.bounds, to: nil).minY + gap
        #expect(abs(actual - y) < 1, "Expected bubble at \(y), got \(actual)")
        #expect(list.alpha == 1)
        #expect(backend.threadReads.isEmpty, "Opening focus must not page before the reader scrolls")
    }
}

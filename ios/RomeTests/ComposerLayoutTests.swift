import SwiftUI
import Testing
@testable import Rome

/// The + and Send sit centered in an empty composer at every text size.
@Suite struct ComposerCenteringTests {
    @Test func controlsAreCenteredOnTheOnlyLine() {
        for size in DynamicTypeSize.allCases {
            let lineHeight = ComposerTextView.font(for: size).lineHeight
            let inset = ComposerTextView.verticalInset(lineHeight: lineHeight)
            let height = max(ComposerTextView.minHeight, inset * 2 + lineHeight)
            let center = ComposerTextView.controlBottomPadding(height: 36, size: size) + 18
            #expect(abs(center - height / 2) < 0.01, "\(size)")
            #expect(inset >= 14)
        }
        // At the default size the buttons keep their 7 pt gap.
        #expect(abs(ComposerTextView.controlBottomPadding(height: 36, size: .large) - 7) < 0.01)
    }
}

/// A transcript whose content shrank under it never stays scrolled past its end.
@MainActor
@Suite struct TranscriptEndTests {
    @Test func anOffsetPastTheEndGoesBackToTheEnd() {
        // 2000 pt of rows in an 800 pt view with a 100 pt composer inset: the end is at 1300.
        #expect(ScrollHandle.clampedOffset(offset: 1700, contentHeight: 2000, viewHeight: 800, topInset: 60, bottomInset: 100) == 1300)
        #expect(ScrollHandle.clampedOffset(offset: 1300, contentHeight: 2000, viewHeight: 800, topInset: 60, bottomInset: 100) == nil)
        #expect(ScrollHandle.clampedOffset(offset: 900, contentHeight: 2000, viewHeight: 800, topInset: 60, bottomInset: 100) == nil)
        // Rows shorter than the view: the end is the top.
        #expect(ScrollHandle.clampedOffset(offset: 400, contentHeight: 300, viewHeight: 800, topInset: 60, bottomInset: 100) == -60)
    }

    /// A long reply is held to its folded height before it is measured.
    @Test func aLongReplyFoldsFromItsFirstFrame() {
        let long = AgentBubble.foldHeight(for: .large) * 3
        #expect(AgentBubble.capped(measured: 0, expanded: false, size: .large))
        #expect(AgentBubble.capped(measured: long, expanded: false, size: .large))
        #expect(!AgentBubble.capped(measured: long, expanded: true, size: .large))
        #expect(!AgentBubble.capped(measured: 40, expanded: false, size: .large))
    }
}

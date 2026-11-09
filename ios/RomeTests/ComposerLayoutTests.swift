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

import SwiftUI
import Testing
import UIKit
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

/// A named placeholder shortens only its name, so the words around it stay.
@MainActor
@Suite struct NamedPlaceholderTests {
    private func width(_ text: String, _ attributes: [NSAttributedString.Key: Any]) -> CGFloat {
        (text as NSString).size(withAttributes: attributes).width
    }

    @Test func aNameThatFitsShowsWhole() {
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 16)]
        let named = NamedPlaceholder(name: "Kyoto trip") { "在「\($0)」中发消息" }
        let full = "在「Kyoto trip」中发消息"
        #expect(PastingTextView.fitted(named, width: width(full, attributes) + 40, attributes: attributes) == full)
    }

    @Test func aLongNameIsShortenedInsideTheSentence() {
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 16)]
        let named = NamedPlaceholder(name: "Planning the Kyoto trip") { "在「\($0)」中发消息" }
        let short = "在「Plann…」中发消息"
        #expect(PastingTextView.fitted(named, width: width(short, attributes), attributes: attributes) == short)
    }
}

/// A long reply folds from its first frame.
@MainActor
@Suite struct TranscriptEndTests {
    /// A long reply is held to its folded height before it is measured.
    @Test func aLongReplyFoldsFromItsFirstFrame() {
        let long = AgentBubble.foldHeight(for: .large) * 3
        #expect(AgentBubble.capped(measured: 0, expanded: false, size: .large))
        #expect(AgentBubble.capped(measured: long, expanded: false, size: .large))
        #expect(!AgentBubble.capped(measured: long, expanded: true, size: .large))
        #expect(!AgentBubble.capped(measured: 40, expanded: false, size: .large))
    }
}

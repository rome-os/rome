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

@Suite struct ComposerHeightTests {
    @Test func expandingGivesLongDraftsMoreRoomWithoutExceedingTheCap() {
        for size in DynamicTypeSize.allCases {
            let line = ComposerTextView.font(for: size).lineHeight
            let inset = ComposerTextView.verticalInset(lineHeight: line)
            let folded = ComposerTextView.heightLimit(lineHeight: line, inset: inset, expanded: false)
            let expanded = ComposerTextView.heightLimit(lineHeight: line, inset: inset, expanded: true)
            #expect(expanded >= folded)
            #expect(folded >= line + inset * 2)
            #expect(expanded <= max(280, line + inset * 2))
        }
        let line = ComposerTextView.font(for: .large).lineHeight
        let inset = ComposerTextView.verticalInset(lineHeight: line)
        #expect(ComposerTextView.heightLimit(lineHeight: line, inset: inset, expanded: true)
            > ComposerTextView.heightLimit(lineHeight: line, inset: inset, expanded: false))
    }
}

@MainActor
@Suite struct ComposerMorphTests {
    @Observable final class Draft {
        var text = "A draft with a selected word"
        var focused = false
    }

    private struct Host: View {
        @Bindable var draft: Draft
        let attachments: ComposerAttachments

        var body: some View {
            VStack {
                Spacer()
                Composer(text: $draft.text, placeholder: "Message", focused: $draft.focused,
                    attachments: attachments, onSend: {})
            }
            .padding(16)
        }
    }

    private func editors(in view: UIView) -> [PastingTextView] {
        (view as? PastingTextView).map { [$0] } ?? view.subviews.flatMap { editors(in: $0) }
    }

    @Test func morphKeepsTheEditorAndSelection() async throws {
        let draft = Draft()
        let host = UIHostingController(rootView: Host(draft: draft, attachments: ComposerAttachments()))
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
        try await Task.sleep(for: .milliseconds(500))
        let editor = try #require(editors(in: host.view).first)
        editor.selectedRange = NSRange(location: 15, length: 8)
        let selection = editor.selectedRange
        let compactWidth = editor.bounds.width

        draft.focused = true
        try await Task.sleep(for: .milliseconds(600))
        #expect(editors(in: host.view).count == 1)
        #expect(editors(in: host.view).first === editor)
        #expect(editor.selectedRange == selection)
        #expect(editor.bounds.width > compactWidth)

        draft.focused = false
        try await Task.sleep(for: .milliseconds(600))
        #expect(editors(in: host.view).first === editor)
        #expect(editor.selectedRange == selection)
        #expect(editor.text == draft.text)
        #expect(abs(editor.bounds.width - compactWidth) < 1)
    }
}

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
        var expanded = false
    }

    final class Heights { var values: [CGFloat] = [] }

    private struct Host: View {
        @Bindable var draft: Draft
        let attachments: ComposerAttachments
        var heights: Heights? = nil

        var body: some View {
            VStack {
                Spacer()
                Composer(text: $draft.text, placeholder: "Message", focused: $draft.focused,
                    attachments: attachments, onSend: {})
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights?.values.append($0) }
            }
            .padding(16)
        }
    }

    private func editors(in view: UIView) -> [PastingTextView] {
        (view as? PastingTextView).map { [$0] } ?? view.subviews.flatMap { editors(in: $0) }
    }

    private func waitUntil(_ message: String = "Composer layout did not settle", _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !condition() {
            try #require(ContinuousClock.now < deadline, Comment(rawValue: message))
            try await Task.sleep(for: .milliseconds(10))
        }
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
        try await waitUntil { editors(in: host.view).first.map { $0.bounds.width > 0 } ?? false }
        let editor = try #require(editors(in: host.view).first)
        editor.selectedRange = NSRange(location: 15, length: 8)
        let selection = editor.selectedRange
        let compactWidth = editor.bounds.width

        draft.focused = true
        try await waitUntil { editor.isFirstResponder && editor.bounds.width > compactWidth + 1 }
        #expect(editors(in: host.view).count == 1)
        #expect(editors(in: host.view).first === editor)
        #expect(editor.selectedRange == selection)
        #expect(editor.bounds.width > compactWidth)

        draft.focused = false
        try await waitUntil { !editor.isFirstResponder && abs(editor.bounds.width - compactWidth) < 1 }
        #expect(editors(in: host.view).first === editor)
        #expect(editor.selectedRange == selection)
        #expect(editor.text == draft.text)
        #expect(abs(editor.bounds.width - compactWidth) < 1)
    }

    @Test func restoredMultilineDraftStartsAtItsMeasuredHeight() async throws {
        let draft = Draft()
        draft.text = Array(repeating: "Restored draft", count: 8).joined(separator: "\n")
        let heights = Heights()
        let host = UIHostingController(rootView: Host(draft: draft, attachments: ComposerAttachments(), heights: heights))
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
        try await waitUntil { !heights.values.isEmpty }
        #expect(try #require(heights.values.first) > 100)
    }

    @Test func measurementReportsExpansionOnlyForOverflowingDrafts() async throws {
        let draft = Draft()
        let reports = Reports()
        let host = UIHostingController(rootView: MeasuredHost(draft: draft, reports: reports))
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
        try await waitUntil { reports.overflow != nil }
        #expect(reports.overflow == false)
        draft.text = Array(repeating: "A line of the long draft", count: 20).joined(separator: "\n")
        try await waitUntil { reports.overflow == true }
        draft.text = "Short again"
        try await waitUntil { reports.overflow == false }
    }

    @Test func collapsingLongDraftKeepsTheCaretVisible() async throws {
        let draft = Draft()
        draft.text = Array(repeating: "A line of the long draft", count: 30).joined(separator: "\n")
        draft.expanded = true
        draft.focused = true
        let host = UIHostingController(rootView: MeasuredHost(draft: draft, reports: Reports()))
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
        try await waitUntil("The expanded editor did not become ready") {
            editors(in: host.view).first.map { $0.isFirstResponder && $0.isScrollEnabled && $0.bounds.height > 200 } ?? false
        }
        let editor = try #require(editors(in: host.view).first)
        editor.selectedRange = NSRange(location: (draft.text as NSString).length, length: 0)
        editor.layoutIfNeeded()
        let caret = editor.caretRect(for: editor.endOfDocument)
        try #require(editor.contentSize.height >= caret.maxY)
        editor.setContentOffset(CGPoint(x: 0,
            y: max(0, caret.maxY + editor.textContainerInset.bottom - editor.bounds.height)), animated: false)
        try await waitUntil("The caret was not visible before collapsing") {
            editor.bounds.contains(editor.caretRect(for: editor.endOfDocument))
        }

        draft.expanded = false
        try await waitUntil("The editor did not collapse") { editor.bounds.height < 170 }
        try await waitUntil("Collapsing hid the caret") {
            let caret = editor.caretRect(for: editor.endOfDocument)
            return editor.bounds.contains(CGPoint(x: caret.midX, y: caret.midY))
        }
        #expect(editor.isScrollEnabled)
        #expect(editor.selectedRange.location == (draft.text as NSString).length)
    }

    final class Reports { var overflow: Bool? }

    private struct MeasuredHost: View {
        @Bindable var draft: Draft
        let reports: Reports

        var body: some View {
            ComposerTextView(text: $draft.text, focused: $draft.focused, placeholder: "Message",
                expanded: draft.expanded, compactWidth: 300, onMeasure: { _, _, overflow in reports.overflow = overflow })
                .frame(width: 300)
        }
    }

}

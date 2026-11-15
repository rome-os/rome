import SwiftUI
import Testing
import UIKit
@testable import Rome

@MainActor
@Suite struct BubbleFoldTests {
    /// The reply's laid-out height at a bubble's text width.
    private func height(_ text: String) -> CGFloat {
        let host = UIHostingController(rootView: MarkdownText(source: text).environment(\.dynamicTypeSize, .large))
        return host.sizeThatFits(in: CGSize(width: 260, height: CGFloat.greatestFiniteMagnitude)).height
    }

    private func folds(_ text: String) -> Bool {
        AgentBubble.folds(height: height(text), size: .large)
    }

    @Test func aShortReplyDoesNotFold() {
        #expect(!folds("Got it."))
        #expect(!folds(Array(repeating: "line", count: 12).joined(separator: "\n")))
    }

    @Test func aLongReplyFolds() {
        #expect(folds(Array(repeating: "line", count: 20).joined(separator: "\n")))
    }

    /// Ten lines of thirty Chinese characters wrap to about twice as many lines.
    @Test func aLongChineseReplyFoldsToo() {
        let line = String(repeating: "这是一段比较长的中文回复内容", count: 2)
        #expect(folds(Array(repeating: line, count: 10).joined(separator: "\n")))
    }

    @Test func theFoldGrowsWithTheTextSize() {
        #expect(AgentBubble.foldHeight(for: .xxLarge) > AgentBubble.foldHeight(for: .large))
    }
}

@MainActor
@Suite struct DrawerPageTests {
    private func rgb(_ color: Color, dark: Bool) -> [CGFloat] {
        let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var (r, g, b, a) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return [r, g, b].map { ($0 * 255).rounded() }
    }

    @Test func thePageMovesTowardItsDrawerColorWithTheDrawer() {
        for dark in [false, true] {
            #expect(rgb(Palette.blend(Palette.bg, Palette.drawerPage, 0), dark: dark) == rgb(Palette.bg, dark: dark))
            #expect(rgb(Palette.blend(Palette.bg, Palette.drawerPage, 1), dark: dark) == rgb(Palette.drawerPage, dark: dark))
        }
    }

    @Test func inDarkItIsNeitherThePageNorTheBubble() {
        let page = rgb(Palette.drawerPage, dark: true)
        #expect(page != rgb(Palette.bg, dark: true))
        #expect(page != rgb(Palette.bubble, dark: true))
        // Between the two.
        #expect(page[0] > rgb(Palette.bg, dark: true)[0] && page[0] < rgb(Palette.bubble, dark: true)[0])
    }
}

@Suite struct BackToBottomTests {
    let height: CGFloat = 600

    @Test func showsPastOneScreen() {
        #expect(!BackToBottom.shows(false, distance: 550, height: height))
        #expect(BackToBottom.shows(false, distance: 601, height: height))
    }

    @Test func hidesOnlyWellInsideTheLine() {
        // Between 0.6 and 1 screen it keeps what it was: no flicker.
        #expect(BackToBottom.shows(true, distance: 450, height: height))
        #expect(!BackToBottom.shows(false, distance: 450, height: height))
        #expect(!BackToBottom.shows(true, distance: 350, height: height))
    }

    @Test func nothingBeforeTheListIsMeasured() {
        #expect(!BackToBottom.shows(false, distance: 5000, height: 0))
    }

    /// Something new while reading just above the bottom: the button shows at once.
    @Test func showsWithUnseenAtAShortDistance() {
        let far = BackToBottom.shows(false, distance: 200, height: height)
        #expect(!BackToBottom.visible(far: far, unseen: 0, following: false))
        #expect(BackToBottom.visible(far: far, unseen: 1, following: false))
        // At the bottom, new rows just show; no button.
        #expect(!BackToBottom.visible(far: far, unseen: 1, following: true))
        #expect(BackToBottom.visible(far: true, unseen: 0, following: false))
    }

    /// Read from a phone: header and banner above, the keyboard below.
    @Test func theBottomIsZeroWithTheKeyboardUp() {
        // An 874 pt list with the keyboard and composer (392 pt) under it.
        #expect(BackToBottom.distance(contentHeight: 2878, offset: 2395.67, viewHeight: 874, bottomInset: 392) < 1)
        // The composer alone (98 pt) under it.
        #expect(BackToBottom.distance(contentHeight: 2878, offset: 2102, viewHeight: 874, bottomInset: 98) == 0)
        #expect(BackToBottom.distance(contentHeight: 2878, offset: 2062, viewHeight: 874, bottomInset: 98) == 40)
    }
}

import SwiftUI
import Testing
import UIKit
@testable import Rome

@Suite struct BubbleFoldTests {
    @Test func aShortReplyDoesNotFold() {
        #expect(!AgentBubble.folds("Got it."))
        #expect(!AgentBubble.folds(Array(repeating: "line", count: 15).joined(separator: "\n")))
    }

    @Test func aLongReplyFoldsInItsBubble() {
        #expect(AgentBubble.folds(Array(repeating: "line", count: 16).joined(separator: "\n")))
        // A few long paragraphs wrap past fifteen lines too.
        #expect(AgentBubble.folds(Array(repeating: String(repeating: "word ", count: 40), count: 3).joined(separator: "\n")))
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

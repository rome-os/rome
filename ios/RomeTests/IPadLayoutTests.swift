import SwiftUI
import Testing
@testable import Rome

/// An iPad's regular width puts the drawer beside the page; a phone, or a
/// narrow iPad window, keeps the drawer that slides out.
@MainActor
@Suite struct IPadLayoutTests {
    @Test func onlyARegularWidthUsesTheSidebar() {
        #expect(MainShell.usesSidebar(.regular))
        #expect(!MainShell.usesSidebar(.compact))
        #expect(!MainShell.usesSidebar(nil))
    }

    @Test func aConversationColumnStopsAtTheReadableWidth() {
        #expect(Metrics.column(393) == 393)
        #expect(Metrics.column(1032) == Metrics.readableWidth)
    }

    @Test func phonesKeepFourAppColumnsAndAnIPadAddsMore() {
        // iPhone 17e to iPhone 18 Pro Max: four, three at accessibility sizes.
        for width in [375.0, 393, 402, 440] as [CGFloat] {
            #expect(AppGrid.columns(width: width, accessibility: false) == 4, "\(width)")
            #expect(AppGrid.columns(width: width, accessibility: true) == 3, "\(width)")
        }
        // An iPad's page beside the sidebar has room for more.
        #expect(AppGrid.columns(width: 714, accessibility: false) == 6)
        #expect(AppGrid.columns(width: 1024, accessibility: false) == 9)
        #expect(AppGrid.columns(width: 1024, accessibility: true) == 7)
    }
}

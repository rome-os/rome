import CoreGraphics
import Testing
@testable import Rome

/// Where the list goes to keep a replied message in view after Reply.
@Suite struct TranscriptKeepTests {
    /// A screen 800 tall with a 100 header and a 350 keyboard and composer:
    /// rows show between 100 and 450 below the offset.
    private func keep(_ row: CGRect, from current: CGFloat) -> CGFloat {
        TranscriptKeep.offset(current: current, row: row, top: 100, bottom: 350, height: 800)
    }

    /// A row already in view does not move the list.
    @Test func aRowInViewStays() {
        #expect(keep(CGRect(x: 0, y: 1300, width: 300, height: 80), from: 1000) == 1000)
    }

    /// A row the keyboard would cover moves up just enough to sit over it.
    @Test func aCoveredRowComesUpJustAboveTheComposer() {
        let offset = keep(CGRect(x: 0, y: 1500, width: 300, height: 80), from: 1000)
        #expect(offset == 1500 + 80 + TranscriptKeep.margin + 350 - 800)
    }

    /// A row gone under the header comes down just below it.
    @Test func aRowUnderTheHeaderComesDown() {
        let offset = keep(CGRect(x: 0, y: 1020, width: 300, height: 80), from: 1000)
        #expect(offset == 1020 - TranscriptKeep.margin - 100)
    }

    /// A row taller than the space shows its top.
    @Test func aTallRowShowsItsTop() {
        let offset = keep(CGRect(x: 0, y: 1500, width: 300, height: 600), from: 1000)
        #expect(offset == 1500 - TranscriptKeep.margin - 100)
    }
}

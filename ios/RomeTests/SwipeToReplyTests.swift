import CoreGraphics
import Testing
@testable import Rome

/// How a swipe to Reply follows the finger, and where the list goes to keep
/// the replied message in view.
@Suite struct SwipeToReplyTests {
    /// The row follows the finger to the threshold, then moves less and less,
    /// never past the stretch.
    @Test func theRowFollowsThenStretches() {
        #expect(SwipeTravel.offset(-20) == 0)
        #expect(SwipeTravel.offset(30) == 30)
        #expect(SwipeTravel.offset(SwipeTravel.threshold) == SwipeTravel.threshold)
        let past = SwipeTravel.offset(SwipeTravel.threshold + 40)
        #expect(past > SwipeTravel.threshold && past < SwipeTravel.threshold + 40)
        #expect(SwipeTravel.offset(2000) < SwipeTravel.threshold + SwipeTravel.stretch)
        #expect(SwipeTravel.offset(200) > SwipeTravel.offset(150))
    }

    /// Letting go replies only from the threshold on.
    @Test func itArmsAtTheThreshold() {
        #expect(!SwipeTravel.armed(SwipeTravel.threshold - 1))
        #expect(SwipeTravel.armed(SwipeTravel.threshold))
    }

    /// Only a drag to the right, mostly sideways, is a swipe: a scroll or a
    /// drag to the left is not.
    @Test func onlyASidewaysDragToTheRightStarts() {
        #expect(SwipeTravel.starts(CGPoint(x: 12, y: 3)))
        #expect(!SwipeTravel.starts(CGPoint(x: -12, y: 0)))
        #expect(!SwipeTravel.starts(CGPoint(x: 8, y: 6)))
        #expect(!SwipeTravel.starts(CGPoint(x: 0, y: 12)))
    }

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

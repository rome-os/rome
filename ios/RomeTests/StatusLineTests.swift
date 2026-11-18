import Foundation
import Testing
@testable import Rome

@Suite struct StatusLineTests {
    @Test func aPassSweepsAcrossThenPausesOffTheEdge() {
        #expect(StatusLine.progress(at: 0) == 0)
        #expect(abs(StatusLine.progress(at: 0.8) - 0.5) < 0.0001)
        #expect(StatusLine.progress(at: 1.6) == 1, "the pass has ended")
        #expect(StatusLine.progress(at: 1.9) == 1, "paused off the right edge")
        #expect(StatusLine.progress(at: 2.0) == 0, "the next pass starts")
    }
}

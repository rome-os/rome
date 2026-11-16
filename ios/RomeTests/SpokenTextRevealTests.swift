import Foundation
import Testing
@testable import Rome

@Suite struct SpokenTextRevealTests {
    @Test func showsTwentyCharactersASecondWhateverPaceTheTextArrives() {
        var reveal = SpokenTextReveal()
        reveal.setTarget("hello world", now: 0)
        #expect(reveal.shownText == "")
        reveal.advance(to: 0.25)
        #expect(reveal.shownText == "hello")
        reveal.advance(to: 1)
        #expect(reveal.shownText == "hello world")
    }

    @Test func neverFallsMoreThanASecondBehind() {
        var reveal = SpokenTextReveal()
        let long = String(repeating: "a", count: 50)
        reveal.setTarget(long, now: 0)
        reveal.advance(to: 0.05)
        #expect(reveal.shown.count == 50 - SpokenTextReveal.maxLag)
        reveal.advance(to: 0.1)
        #expect(reveal.shown.count == 50 - SpokenTextReveal.maxLag + 1)
    }

    @Test func aCorrectionTakesBackOnlyWhatNoLongerMatches() {
        var reveal = SpokenTextReveal()
        reveal.setTarget("I scream", now: 0)
        reveal.advance(to: 1)
        let fadedIn = reveal.shown[0].at
        reveal.setTarget("Ice cream", now: 1)
        #expect(reveal.shownText == "I")
        #expect(reveal.shown[0].at == fadedIn)
        reveal.advance(to: 2)
        #expect(reveal.shownText == "Ice cream")
        #expect(reveal.shown[0].at == fadedIn)
    }

    @Test func eachCharacterFadesInOver280Milliseconds() {
        var reveal = SpokenTextReveal()
        reveal.setTarget("a", now: 0)
        reveal.advance(to: 0.05)
        let at = reveal.shown[0].at
        #expect(reveal.opacity(at: 0, now: at) == 0)
        let midway = reveal.opacity(at: 0, now: at + 0.14)
        #expect(midway > 0.5 && midway < 1)
        #expect(reveal.opacity(at: 0, now: at + 0.28) == 1)
        #expect(!reveal.settled(at: at + 0.1))
        #expect(reveal.settled(at: at + 0.28))
    }

    @Test func aPauseBanksNoCharactersForTheNextWords() {
        var reveal = SpokenTextReveal()
        reveal.setTarget("hi", now: 0)
        reveal.advance(to: 1)
        // The display link stops once settled: no frame runs during the pause.
        reveal.setTarget("hi there", now: 3)
        reveal.advance(to: 3.1)
        #expect(reveal.shownText == "hi t")
    }

    @Test func reduceMotionShowsTheTextAtOnceWithNoFade() {
        var reveal = SpokenTextReveal(instant: true)
        reveal.setTarget("hello world", now: 0)
        #expect(reveal.shownText == "hello world")
        #expect(reveal.opacity(at: 0, now: 0) == 1)
        #expect(reveal.settled(at: 0))
    }
}

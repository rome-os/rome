import Foundation
import Testing
@testable import Rome

@Suite struct OpeningScreenTests {
    @MainActor @Test func voiceOverReadsOpeningYourRome() {
        // Tests run in English.
        #expect(OpeningScreen.accessibilityText == "Opening your Rome")
    }

    @Test func dotsLightUpInTurn() {
        // At the start of a cycle the first dot is brightest.
        let first = (0..<3).map { LoadingDots.opacity(at: 0, index: $0) }
        #expect(first[0] > first[1] && first[0] > first[2])
        // A third of a cycle later the second one is.
        let later = (0..<3).map { LoadingDots.opacity(at: 0.4, index: $0) }
        #expect(later[1] > later[0] && later[1] > later[2])
    }

    @Test func theMascotRestsBetweenBlinks() {
        let resting = MascotPose(time: 1.0)
        #expect(resting.eyeScale == 1)
        let midBlink = MascotPose(time: 3.6 + 0.09)
        #expect(midBlink.eyeScale < 0.15)
        // Glances and nods stay within a few points.
        for step in 0..<100 {
            let pose = MascotPose(time: Double(step) * 0.13)
            #expect(abs(pose.glance) <= 2 && abs(pose.nod) <= 1 && abs(pose.tilt) <= 1.5)
        }
    }

    @Test func theSignInMascotOnlyBlinks() {
        // Mid-blink only the eyes move.
        let blink = MascotPose.blink
        #expect(blink.eyeScale < 0.15)
        #expect(blink.glance == 0 && blink.nod == 0 && blink.tilt == 0)
    }

    /// Taps on the header mascot cycle through its reactions; Reduce Motion only blinks.
    @Test func tapsCycleThroughReactions() {
        let taps = (1...6).map { MascotReaction.forTap($0, reduceMotion: false) }
        #expect(taps == [.blink, .wink, .glance, .nod, .blink, .wink])
        #expect((1...4).allSatisfy { MascotReaction.forTap($0, reduceMotion: true) == .blink })
        for reaction in MascotReaction.allCases {
            let total = reaction.steps.map(\.1).reduce(0, +)
            #expect(total > 0.15 && total <= 0.35)
            #expect(reaction.steps.last?.0 == .rest)
        }
        // A wink closes one eye only.
        #expect(MascotReaction.wink.steps.first?.0.rightEyeScale ?? 1 < 0.2)
        #expect(MascotReaction.wink.steps.first?.0.eyeScale == 1)
    }

    @Test func eachPathIsParsedOnce() {
        let first = SVGPath.cached(MascotPaths.body)
        #expect(first == SVGPath.parse(MascotPaths.body))
        #expect(SVGPath.cached(MascotPaths.body) == first)
    }

    @Test func theIconPathsParse() {
        for data in [MascotPaths.headFill, MascotPaths.headRing, MascotPaths.body, MascotPaths.screen, MascotPaths.leftEye, MascotPaths.rightEye] {
            let bounds = SVGPath.parse(data).boundingRect
            #expect(bounds.width > 1 && bounds.height > 1)
            #expect(bounds.maxX <= Mascot.viewBox.width + 0.5 && bounds.maxY <= Mascot.viewBox.height + 0.5)
        }
    }
}

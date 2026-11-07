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
        // Between blinks it is at rest; mid-blink only the eyes move.
        #expect(MascotPose.blinkOnly(time: 2) == .rest)
        let blink = MascotPose.blinkOnly(time: 4.5 + 0.09)
        #expect(blink.eyeScale < 0.15)
        #expect(blink.glance == 0 && blink.nod == 0 && blink.tilt == 0)
    }

    @Test func theIconPathsParse() {
        for data in [MascotPaths.headFill, MascotPaths.headRing, MascotPaths.body, MascotPaths.screen, MascotPaths.leftEye, MascotPaths.rightEye] {
            let bounds = SVGPath.parse(data).boundingRect
            #expect(bounds.width > 1 && bounds.height > 1)
            #expect(bounds.maxX <= Mascot.viewBox.width + 0.5 && bounds.maxY <= Mascot.viewBox.height + 0.5)
        }
    }
}

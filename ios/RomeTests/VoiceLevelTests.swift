import Foundation
import Testing
@testable import Rome

@Suite struct VoiceLevelTests {
    /// 16-bit samples of a sine at `amplitude` (0 to 1 of full scale).
    private func tone(_ amplitude: Double, samples: Int) -> Data {
        var values = (0..<samples).map { Int16(amplitude * 32767 * sin(Double($0) * 2 * .pi * 440 / 16000)) }
        return Data(bytes: &values, count: samples * 2)
    }

    private func loudness(_ data: Data) -> Float {
        data.withUnsafeBytes { VoiceLoudness.of($0.bindMemory(to: Int16.self)) }
    }

    @Test func silenceAndAQuietRoomReadAsZero() {
        #expect(loudness(tone(0, samples: 400)) == 0)
        // About -65 dBFS.
        #expect(loudness(tone(0.0008, samples: 400)) == 0)
    }

    @Test func speechReadsBetweenZeroAndOneLouderHigher() {
        let soft = loudness(tone(0.01, samples: 400))
        let loud = loudness(tone(0.2, samples: 400))
        #expect(soft > 0 && soft < 1)
        #expect(loud > soft && loud < 1)
        #expect(loudness(tone(1, samples: 400)) == 1)
    }

    @Test func eachFiftyMillisecondsOfAudioIsOneStepHoldingItsLoudest() {
        let meter = VoiceLevelMeter()
        // 100 ms: a loud first 25 ms, then quiet.
        meter.take(tone(0.2, samples: 400) + tone(0, samples: 1200))
        let first = meter.next()
        #expect(first != nil && first! > 0.5)
        #expect(meter.next() == 0)
        #expect(meter.next() == nil)
    }

    @Test func audioSplitMidStepStillMakesWholeSteps() {
        let meter = VoiceLevelMeter()
        meter.take(tone(0.2, samples: 500))
        #expect(meter.next() == nil)
        meter.take(tone(0.2, samples: 300))
        #expect(meter.next() != nil)
    }

    @Test func silenceAddsOnlyDots() {
        let meter = VoiceLevelMeter()
        let bars = VoiceInputWaveform.Bars()
        meter.take(tone(0, samples: 1600))
        bars.advance(to: Date(), meter: meter, steps: 1)
        bars.advance(to: Date().addingTimeInterval(0.05), meter: meter, steps: 1)
        #expect(bars.values == [0, 0])
        // A quiet room is silence too.
        meter.take(tone(0.0008, samples: 800))
        bars.advance(to: Date().addingTimeInterval(0.1), meter: meter, steps: 1)
        #expect(bars.values == [0, 0, 0])
        meter.take(tone(0.2, samples: 800))
        bars.advance(to: Date().addingTimeInterval(0.15), meter: meter, steps: 1)
        #expect(bars.values.count == 4 && bars.values[3] > 0.5)
        // No audio, no step: the waveform holds.
        bars.advance(to: Date().addingTimeInterval(0.2), meter: meter, steps: 1)
        #expect(bars.values.count == 4)
    }

    @Test func reduceMotionKeepsFiveSecondsToo() {
        let meter = VoiceLevelMeter()
        let bars = VoiceInputWaveform.Bars()
        var now = Date()
        meter.take(tone(0.2, samples: 3200))
        bars.advance(to: now, meter: meter, steps: 4)
        #expect(bars.values.first ?? 0 > 0.5)
        // Five seconds of silence, 200 ms a step.
        for _ in 0..<25 {
            now = now.addingTimeInterval(0.2)
            meter.take(tone(0, samples: 3200))
            bars.advance(to: now, meter: meter, steps: 4)
        }
        #expect(bars.values.count == 25)
        #expect(bars.values.allSatisfy { $0 == 0 })
    }

    @Test func thirtyFramesASecondStillTakesTwentyStepsASecond() {
        let meter = VoiceLevelMeter()
        let bars = VoiceInputWaveform.Bars()
        let start = Date()
        // One second at 30 frames a second, audio arriving 100 ms at a time.
        for frame in 0..<30 {
            let now = start.addingTimeInterval(Double(frame) / 30)
            if frame % 3 == 0 { meter.take(tone(0.2, samples: 1600)) }
            bars.advance(to: now, meter: meter, steps: 1)
        }
        #expect(bars.values.count == 20)
    }

    @Test func aSkippedFrameTakesEveryStepThatCameDue() {
        let meter = VoiceLevelMeter()
        let bars = VoiceInputWaveform.Bars()
        let start = Date()
        meter.take(tone(0.2, samples: 3200))
        bars.advance(to: start, meter: meter, steps: 1)
        bars.advance(to: start.addingTimeInterval(0.15), meter: meter, steps: 1)
        #expect(bars.values.count == 4)
    }
}

import Foundation

/// How loud the microphone is, on a 0 to 1 scale, for the waveform. Reads the
/// audio on its way to the instance, so the microphone and the audio sent are
/// unchanged.
enum VoiceLoudness {
    /// Quieter than this is a quiet room, read as 0.
    static let quietDB: Float = -55
    /// Louder than this is read as 1.
    static let loudDB: Float = -10

    /// The loudness of 16-bit samples: their RMS in dBFS, mapped from
    /// `quietDB`…`loudDB` to 0…1.
    static func of(_ samples: UnsafeBufferPointer<Int16>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples {
            let value = Float(sample) / 32768
            sum += value * value
        }
        let rms = (sum / Float(samples.count)).squareRoot()
        let db = 20 * log10(max(rms, 1e-8))
        return min(1, max(0, (db - quietDB) / (loudDB - quietDB)))
    }
}

/// The microphone's loudness in steps of 50 ms of audio, each holding the
/// loudest reading in it. The audio thread adds audio; the waveform takes
/// steps on the main thread. Audio arrives about 100 ms at a time, so steps
/// queue up and the waveform takes them one per 50 ms, which keeps it moving
/// evenly.
final class VoiceLevelMeter: @unchecked Sendable {
    /// Samples in one step: 50 ms at the wire's rate.
    static let stepSamples = VoiceInputWire.sampleRate / 20
    /// Samples in one reading: 25 ms, so each step holds two.
    static let readingSamples = stepSamples / 2

    private let lock = NSLock()
    private var leftover: [Int16] = []
    private var peak: Float = 0
    private var readingsInStep = 0
    private var steps: [Float] = []

    /// Takes 16-bit mono samples, as the audio source hands them on.
    func take(_ chunk: Data) {
        var samples = chunk.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        lock.lock()
        defer { lock.unlock() }
        if !leftover.isEmpty {
            samples = leftover + samples
            leftover = []
        }
        var start = 0
        while start + Self.readingSamples <= samples.count {
            let reading = samples[start..<(start + Self.readingSamples)].withUnsafeBufferPointer(VoiceLoudness.of)
            peak = max(peak, reading)
            readingsInStep += 1
            if readingsInStep * Self.readingSamples >= Self.stepSamples {
                steps.append(peak)
                peak = 0
                readingsInStep = 0
            }
            start += Self.readingSamples
        }
        leftover = Array(samples[start...])
        // A waveform that fell behind skips ahead rather than lagging the voice.
        if steps.count > 8 { steps.removeFirst(steps.count - 8) }
    }

    /// The oldest step not yet taken, nil when none has arrived.
    func next() -> Float? {
        lock.lock()
        defer { lock.unlock() }
        return steps.isEmpty ? nil : steps.removeFirst()
    }
}

/// Hands `source`'s audio to `meter` as well as to the dictation.
@MainActor
final class MeteredAudioSource: VoiceAudioSource {
    private let source: VoiceAudioSource
    private let meter: VoiceLevelMeter

    init(_ source: VoiceAudioSource, meter: VoiceLevelMeter) {
        self.source = source
        self.meter = meter
    }

    func requestAccess() async -> Bool { await source.requestAccess() }

    func start(onChunk: @escaping @Sendable (Data) -> Void) throws {
        let meter = meter
        try source.start { chunk in
            onChunk(chunk)
            meter.take(chunk)
        }
    }

    func finish() { source.finish() }
    func close() { source.close() }
}

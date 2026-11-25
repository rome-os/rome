import AVFoundation
import Foundation

/// A voice conversation's sound: the microphone going up, Rome's reply coming
/// down, or in a Debug build a recording that UI tests play in its place.
@MainActor
protocol VoiceConversationAudio: AnyObject {
    /// Asks for the microphone when the guardian has not answered yet.
    func requestAccess() async -> Bool
    /// Starts the microphone and the speaker. `onChunk` gets PCM s16le mono at
    /// `VoiceConversationWire.sampleRate`, about 100 ms at a time, on any
    /// thread. `onLost` runs once if the microphone stops by itself.
    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws
    /// Plays one chunk of the reply, PCM s16le mono at `sampleRate`, after those queued.
    func play(_ chunk: Data, sampleRate: Int)
    /// Drops the reply not played yet, at once.
    func clear()
    /// How loud the microphone is now, 0 to 1.
    var microphoneLevel: Float { get }
    /// How loud the reply playing now is, 0 to 1.
    var replyLevel: Float { get }
    /// Releases the microphone and the speaker. Safe to call more than once.
    func close()
}

enum VoiceConversationAudios {
    /// The microphone and speaker. A Debug build launched with a recording plays that instead.
    @MainActor
    static func make() -> VoiceConversationAudio {
        #if DEBUG
        if let recording = RecordingAudioSource.fromLaunchArguments() { return RecordedConversationAudio(recording) }
        #endif
        return SpeakerphoneAudio()
    }
}

/// The last loudness read, from the audio thread, for the capsule on main. A
/// reading older than `stale` is silence: a tap that stops calling leaves 0.
final class LevelReading: @unchecked Sendable {
    static let stale: TimeInterval = 0.25

    private let lock = NSLock()
    private var value: Float = 0
    private var at: TimeInterval = 0

    func set(_ value: Float) {
        let now = ProcessInfo.processInfo.systemUptime
        lock.withLock {
            self.value = value
            at = now
        }
    }

    func reset() { lock.withLock { value = 0 } }

    var current: Float {
        let now = ProcessInfo.processInfo.systemUptime
        return lock.withLock { now - at > Self.stale ? 0 : value }
    }
}

/// The microphone and the reply on one `AVAudioEngine`, with the system's
/// voice processing on, so iOS cancels Rome's own voice out of what the
/// microphone hears, as it does in a call. Audio is never written anywhere.
@MainActor
final class SpeakerphoneAudio: VoiceConversationAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// The format the player is connected in: the reply's rate.
    private var playerFormat: AVAudioFormat?
    private var capture: PCMChunker?
    private var running = false
    private let microphone = LevelReading()
    private let reply = LevelReading()
    private var routeChanges: NSObjectProtocol?
    private var configurationChanges: NSObjectProtocol?

    func requestAccess() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        // Plays and records at once, as a call does: the reply comes out of
        // the speaker, or the headset when one is on, and Bluetooth headsets
        // count as microphones.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try session.setActive(true)
        MicrophoneChoice().apply(to: session)
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            engine.attach(player)
            connectPlayer(sampleRate: Self.defaultReplyRate)
            try tapInput(onChunk: onChunk)
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
        running = true
        routeChanges = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            MainActor.assumeIsolated {
                MicrophoneChoice().routeChanged(reason, connected: (AVAudioSession.sharedInstance().availableInputs ?? []).map(\.uid))
            }
        }
        configurationChanges = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.restart(onChunk: onChunk, onLost: onLost) }
        }
    }

    /// The rate Rome speaks at until it names its own in `ready`.
    private static let defaultReplyRate = 24_000

    /// Connects the player to the mixer at `sampleRate`, the mixer converting
    /// to the speaker's own rate, and reads its loudness on the way out.
    private func connectPlayer(sampleRate: Int) {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1) else { return }
        if playerFormat != nil {
            player.removeTap(onBus: 0)
            engine.disconnectNodeOutput(player)
        }
        engine.connect(player, to: engine.mainMixerNode, format: format)
        playerFormat = format
        player.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.measure(into: reply))
    }

    /// Taps the input in the format it has now, voice processing applied.
    private func tapInput(onChunk: @escaping @Sendable (Data) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let microphone = microphone
        guard let chunker = PCMChunker(from: format, onChunk: { chunk in
            onChunk(chunk)
            microphone.set(SpeakerphoneAudio.loudness(of: chunk))
        }) else { throw VoiceAudioError.noInput }
        capture = chunker
        input.installTap(onBus: 0, bufferSize: 4096, format: format, block: Self.tap(chunker))
    }

    /// iOS stops the engine when a route changes the input's format, as when a
    /// Bluetooth headset is taken off. Both go on from the route that took over.
    private func restart(onChunk: @escaping @Sendable (Data) -> Void, onLost: @MainActor () -> Void) {
        guard running else { return }
        capture?.flush()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do {
            try tapInput(onChunk: onChunk)
            engine.prepare()
            try engine.start()
        } catch {
            close()
            onLost()
            return
        }
        // Stopping the engine stopped the player too: the reply that came
        // meanwhile, and any to come, play now.
        player.play()
    }

    func play(_ chunk: Data, sampleRate: Int) {
        guard running, !chunk.isEmpty else { return }
        if Int(playerFormat?.sampleRate ?? 0) != sampleRate {
            player.stop()
            connectPlayer(sampleRate: sampleRate)
        }
        guard let format = playerFormat, let buffer = Self.buffer(chunk, format: format) else { return }
        player.scheduleBuffer(buffer, completionHandler: nil)
        // A route change stops the engine before its notice reaches main, and
        // playing on a stopped engine traps. The buffer waits: `restart` plays it.
        if engine.isRunning, !player.isPlaying { player.play() }
    }

    func clear() {
        guard running else { return }
        // Stopping drops every buffer scheduled; the next chunk starts it again.
        player.stop()
        reply.reset()
    }

    var microphoneLevel: Float { microphone.current }
    var replyLevel: Float { player.isPlaying ? reply.current : 0 }

    func close() {
        guard running else { return }
        running = false
        if let routeChanges { NotificationCenter.default.removeObserver(routeChanges) }
        routeChanges = nil
        if let configurationChanges { NotificationCenter.default.removeObserver(configurationChanges) }
        configurationChanges = nil
        engine.inputNode.removeTap(onBus: 0)
        player.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        capture = nil
        // Lets the system's microphone indicator go off, and other apps' audio resume.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Built outside the main actor: the audio thread calls it.
    nonisolated private static func tap(_ chunker: PCMChunker) -> AVAudioNodeTapBlock {
        { buffer, _ in chunker.take(buffer) }
    }

    /// Built outside the main actor: the audio thread calls it.
    nonisolated private static func measure(into reading: LevelReading) -> AVAudioNodeTapBlock {
        { buffer, _ in reading.set(loudness(buffer)) }
    }

    /// 16-bit samples as a float buffer in `format`, for the player.
    nonisolated static func buffer(_ chunk: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let count = chunk.count / 2
        guard count > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.floatChannelData?[0]
        else { return nil }
        chunk.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<count { channel[index] = Float(Int16(littleEndian: samples[index])) / 32768 }
        }
        buffer.frameLength = AVAudioFrameCount(count)
        return buffer
    }

    /// The loudness of 16-bit samples on the waveform's scale.
    nonisolated static func loudness(of chunk: Data) -> Float {
        chunk.withUnsafeBytes { raw in VoiceLoudness.of(raw.bindMemory(to: Int16.self)) }
    }

    /// The loudness of a float buffer on the same scale.
    nonisolated static func loudness(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count { sum += channel[index] * channel[index] }
        let rms = (sum / Float(count)).squareRoot()
        let db = 20 * log10(max(rms, 1e-8))
        return min(1, max(0, (db - VoiceLoudness.quietDB) / (VoiceLoudness.loudDB - VoiceLoudness.quietDB)))
    }
}

#if DEBUG
/// A recording played as the microphone, for UI tests; the reply is not
/// played, only measured, so the capsule still moves while Rome speaks.
@MainActor
final class RecordedConversationAudio: VoiceConversationAudio {
    private let source: RecordingAudioSource
    private let microphone = LevelReading()
    private let reply = LevelReading()

    init(_ source: RecordingAudioSource) {
        self.source = source
    }

    func requestAccess() async -> Bool { await source.requestAccess() }

    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws {
        let microphone = microphone
        try source.start(onChunk: { chunk in
            onChunk(chunk)
            microphone.set(SpeakerphoneAudio.loudness(of: chunk))
        }, onLost: onLost)
    }

    func play(_ chunk: Data, sampleRate: Int) { reply.set(SpeakerphoneAudio.loudness(of: chunk)) }
    func clear() { reply.reset() }
    var microphoneLevel: Float { microphone.current }
    var replyLevel: Float { reply.current }
    func close() { source.close() }
}
#endif

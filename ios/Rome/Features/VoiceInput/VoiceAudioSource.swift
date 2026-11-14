import AVFoundation
import Foundation

/// Where a dictation's audio comes from: the microphone, or in a Debug build a
/// recording that UI tests play in its place.
@MainActor
protocol VoiceAudioSource: AnyObject {
    /// Asks for the microphone when the guardian has not answered yet. The
    /// system prompt shows the app's usage description.
    func requestAccess() async -> Bool
    /// Starts capture: `onChunk` gets PCM s16le mono at `VoiceInputWire.sampleRate`,
    /// about 100 ms at a time, on any thread. Throws when capture cannot start.
    func start(onChunk: @escaping @Sendable (Data) -> Void) throws
    /// Hands over the audio still buffered, then releases the microphone.
    func finish()
    /// Releases the microphone at once. Safe to call more than once.
    func close()
}

enum VoiceAudioSources {
    /// The microphone. A Debug build launched with a recording plays that instead.
    @MainActor
    static func make() -> VoiceAudioSource {
        #if DEBUG
        if let recording = RecordingAudioSource.fromLaunchArguments() { return recording }
        #endif
        return MicrophoneSource()
    }
}

/// The microphone through `AVAudioEngine`, brought down to 16 kHz mono.
/// Audio is never written anywhere: each chunk goes to `onChunk` and is dropped.
@MainActor
final class MicrophoneSource: VoiceAudioSource {
    private let engine = AVAudioEngine()
    private var capture: PCMChunker?
    private var running = false

    func requestAccess() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start(onChunk: @escaping @Sendable (Data) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceInputWire.sampleRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target)
        else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw VoiceAudioError.noInput
        }
        let chunker = PCMChunker(converter: converter, target: target, onChunk: onChunk)
        capture = chunker
        input.installTap(onBus: 0, bufferSize: 4096, format: format, block: Self.tap(chunker))
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
        running = true
    }

    /// Built outside the main actor: the audio thread calls it.
    nonisolated private static func tap(_ chunker: PCMChunker) -> AVAudioNodeTapBlock {
        { buffer, _ in chunker.take(buffer) }
    }

    func finish() {
        guard running else { return }
        capture?.flush()
        close()
    }

    func close() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        capture = nil
        // Lets the system's microphone indicator go off, and other apps' audio resume.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

enum VoiceAudioError: Error {
    case noInput
}

/// Converts the input's buffers to 16 kHz Int16 and hands them on in chunks of
/// about 100 ms. Runs on the audio thread; the lock covers `flush` from main.
final class PCMChunker: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let target: AVAudioFormat
    private let onChunk: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var pending = Data()
    /// 100 ms of 16-bit mono samples.
    private let chunkBytes = VoiceInputWire.sampleRate / 10 * 2

    init(converter: AVAudioConverter, target: AVAudioFormat, onChunk: @escaping @Sendable (Data) -> Void) {
        self.converter = converter
        self.target = target
        self.onChunk = onChunk
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        // The converter asks for input until told there is none for now.
        let given = Flag()
        nonisolated(unsafe) let input = buffer
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given.value {
                status.pointee = .noDataNow
                return nil
            }
            given.value = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
        let bytes = Data(bytes: samples[0], count: Int(out.frameLength) * 2)
        var ready: [Data] = []
        lock.lock()
        pending.append(bytes)
        while pending.count >= chunkBytes {
            ready.append(pending.prefix(chunkBytes))
            pending.removeFirst(chunkBytes)
        }
        lock.unlock()
        for chunk in ready { onChunk(Data(chunk)) }
    }

    func flush() {
        lock.lock()
        let rest = pending
        pending = Data()
        lock.unlock()
        if !rest.isEmpty { onChunk(rest) }
    }
}

private final class Flag: @unchecked Sendable {
    var value = false
}

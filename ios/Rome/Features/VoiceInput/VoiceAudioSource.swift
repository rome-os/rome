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
    /// Whether any microphone source is recording now, which leaves the
    /// audio session active.
    private(set) static var capturing = false
    private var routeChanges: NSObjectProtocol?
    private var configurationChanges: NSObjectProtocol?

    func requestAccess() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start(onChunk: @escaping @Sendable (Data) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try MicrophoneChoice.prepare(session)
        try session.setActive(true)
        MicrophoneChoice().apply(to: session)
        do {
            try tapInput(onChunk: onChunk)
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
        running = true
        Self.capturing = true
        routeChanges = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            MainActor.assumeIsolated {
                MicrophoneChoice().routeChanged(reason, connected: (AVAudioSession.sharedInstance().availableInputs ?? []).map(\.uid))
            }
        }
        configurationChanges = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.restart(onChunk: onChunk) }
        }
    }

    /// Taps the input in the format it has now.
    private func tapInput(onChunk: @escaping @Sendable (Data) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let chunker = PCMChunker(from: format, onChunk: onChunk) else { throw VoiceAudioError.noInput }
        capture = chunker
        input.installTap(onBus: 0, bufferSize: 4096, format: format, block: Self.tap(chunker))
    }

    /// iOS stops the engine when the input's format changes, as when a
    /// Bluetooth microphone is taken off and the built-in one, at another
    /// sample rate, takes over. Capture goes on from the input that took over.
    private func restart(onChunk: @escaping @Sendable (Data) -> Void) {
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
        }
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
        Self.capturing = false
        if let routeChanges { NotificationCenter.default.removeObserver(routeChanges) }
        routeChanges = nil
        if let configurationChanges { NotificationCenter.default.removeObserver(configurationChanges) }
        configurationChanges = nil
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
    /// The converter is not safe to use from two threads: the audio thread
    /// converts while `flush` drains from main.
    private let converting = NSLock()
    private var pending = Data()
    /// 100 ms of 16-bit mono samples.
    private let chunkBytes = VoiceInputWire.sampleRate / 10 * 2

    init(converter: AVAudioConverter, target: AVAudioFormat, onChunk: @escaping @Sendable (Data) -> Void) {
        self.converter = converter
        self.target = target
        self.onChunk = onChunk
    }

    /// A chunker for input in `format`, or nil when the format has no audio.
    convenience init?(from format: AVAudioFormat, onChunk: @escaping @Sendable (Data) -> Void) {
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceInputWire.sampleRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target)
        else { return nil }
        self.init(converter: converter, target: target, onChunk: onChunk)
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 16
        let given = Flag()
        nonisolated(unsafe) let input = buffer
        send(convert(capacity: capacity) { _, status in
            // The converter asks for input until told there is none for now.
            if given.value {
                status.pointee = .noDataNow
                return nil
            }
            given.value = true
            status.pointee = .haveData
            return input
        })
    }

    /// Hands over the audio still held, the converter's included. The
    /// converter holds back part of the input to resample it, and gives it
    /// out only when told the input has ended.
    func flush() {
        let tail = convert(capacity: AVAudioFrameCount(target.sampleRate / 10)) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        converting.withLock { converter.reset() }
        lock.lock()
        pending.append(tail)
        let rest = pending
        pending = Data()
        lock.unlock()
        if !rest.isEmpty { onChunk(rest) }
    }

    /// Everything the converter gives out for the input `next` supplies,
    /// taken as long as it fills each output buffer.
    private func convert(capacity: AVAudioFrameCount, _ next: @escaping AVAudioConverterInputBlock) -> Data {
        converting.withLock {
            var bytes = Data()
            while let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) {
                var error: NSError?
                let status = converter.convert(to: out, error: &error, withInputFrom: next)
                if error == nil, out.frameLength > 0, let samples = out.int16ChannelData {
                    bytes.append(Data(bytes: samples[0], count: Int(out.frameLength) * 2))
                }
                if status != .haveData { break }
            }
            return bytes
        }
    }

    private func send(_ bytes: Data) {
        guard !bytes.isEmpty else { return }
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
}

private final class Flag: @unchecked Sendable {
    var value = false
}

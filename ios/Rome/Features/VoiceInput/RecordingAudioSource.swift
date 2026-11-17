#if DEBUG
import Foundation

/// A recording played as the microphone, in real time, for UI tests. Debug
/// builds only: this whole file compiles to nothing in Release.
///
/// Launch with `-RomeVoiceInputRecording <path to a 16 kHz mono 16-bit WAV>`.
/// `-RomeVoiceInputMicrophone denied` plays the refused microphone instead, with or without a
/// recording, whatever the simulator's own permission says.
@MainActor
final class RecordingAudioSource: VoiceAudioSource {
    static let recordingArgument = "RomeVoiceInputRecording"
    static let microphoneArgument = "RomeVoiceInputMicrophone"

    private let samples: Data
    private let allowed: Bool
    private var playing: Task<Void, Never>?
    private var offset = 0
    private var onChunk: (@Sendable (Data) -> Void)?

    static func fromLaunchArguments() -> RecordingAudioSource? {
        let defaults = UserDefaults.standard
        let path = defaults.string(forKey: recordingArgument)
        let denied = defaults.string(forKey: microphoneArgument) == "denied"
        guard path != nil || denied else { return nil }
        let samples = path.flatMap { try? Data(contentsOf: URL(filePath: $0)) }.map(pcm) ?? Data()
        return RecordingAudioSource(samples: samples, allowed: !denied)
    }

    init(samples: Data, allowed: Bool = true) {
        self.samples = samples
        self.allowed = allowed
    }

    func requestAccess() async -> Bool { allowed }

    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws {
        self.onChunk = onChunk
        let chunk = VoiceInputWire.sampleRate / 10 * 2
        playing = Task { [weak self] in
            // Then silence, as a quiet room, until listening stops.
            while !Task.isCancelled {
                guard let self else { return }
                self.send(chunk)
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func send(_ size: Int) {
        guard let onChunk else { return }
        var chunk = Data(count: size)
        if offset < samples.count {
            let end = min(offset + size, samples.count)
            chunk.replaceSubrange(0..<(end - offset), with: samples[(samples.startIndex + offset)..<(samples.startIndex + end)])
            offset = end
        }
        onChunk(chunk)
    }

    func finish() { close() }

    func close() {
        playing?.cancel()
        playing = nil
        onChunk = nil
    }

    /// The samples of a WAV file's `data` chunk; the file itself when it has none.
    nonisolated static func pcm(_ file: Data) -> Data {
        let bytes = [UInt8](file)
        guard bytes.count > 12, String(decoding: bytes[0..<4], as: UTF8.self) == "RIFF" else { return file }
        var index = 12
        while index + 8 <= bytes.count {
            let id = String(decoding: bytes[index..<(index + 4)], as: UTF8.self)
            let size = Int(bytes[index + 4]) | Int(bytes[index + 5]) << 8 | Int(bytes[index + 6]) << 16 | Int(bytes[index + 7]) << 24
            let start = index + 8
            if id == "data" { return Data(bytes[start..<min(start + size, bytes.count)]) }
            index = start + size + (size % 2)
        }
        return Data()
    }
}
#endif

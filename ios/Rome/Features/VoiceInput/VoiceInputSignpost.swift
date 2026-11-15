import os

/// Which message field a voice input start came from.
enum VoiceInputField: String, Sendable {
    case chat
    case thread
    case taskChat = "task-chat"
    case topicChat = "topic-chat"
}

/// Signpost intervals for voice input, in every build, so a UI test can time
/// them with `XCTOSSignpostMetric` against these names. `StartListening` runs
/// from the tap to the field showing that it listens. `StopListening` runs
/// from a stop, whatever its cause, until the microphone is released.
enum VoiceInputSignpost {
    static let subsystem = "cc.romeos.voice-input"
    static let category = "VoiceInput"
    static let name: StaticString = "StartListening"
    static let stopName: StaticString = "StopListening"

    private static let signposter = OSSignposter(subsystem: subsystem, category: category)

    static func begin(_ field: VoiceInputField) -> OSSignpostIntervalState {
        signposter.beginInterval(name, id: signposter.makeSignpostID(), "field=\(field.rawValue, privacy: .public)")
    }

    static func end(_ interval: OSSignpostIntervalState) {
        signposter.endInterval(name, interval)
    }

    static func beginStop(_ cause: String) -> OSSignpostIntervalState {
        signposter.beginInterval(stopName, id: signposter.makeSignpostID(), "cause=\(cause, privacy: .public)")
    }

    static func endStop(_ interval: OSSignpostIntervalState) {
        signposter.endInterval(stopName, interval)
    }
}

/// Times one dictation's stop. A port, so a test can see when the interval
/// ends against what the microphone did.
@MainActor
protocol VoiceStopTiming: AnyObject {
    func begin(cause: String)
    func end()
}

/// The `StopListening` signpost interval.
@MainActor
final class SignpostStopTiming: VoiceStopTiming {
    private var interval: OSSignpostIntervalState?

    func begin(cause: String) {
        guard interval == nil else { return }
        interval = VoiceInputSignpost.beginStop(cause)
    }

    func end() {
        guard let interval else { return }
        self.interval = nil
        VoiceInputSignpost.endStop(interval)
    }
}

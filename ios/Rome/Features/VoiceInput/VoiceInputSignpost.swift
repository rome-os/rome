import os

/// Which message field a voice input start came from.
enum VoiceInputField: String, Sendable {
    case chat
    case thread
    case taskChat = "task-chat"
    case topicChat = "topic-chat"
}

/// One signpost interval per voice input start: from the tap to the field
/// showing that it listens. In every build, so a UI test can time it with
/// `XCTOSSignpostMetric` against these names.
enum VoiceInputSignpost {
    static let subsystem = "cc.romeos.voice-input"
    static let category = "VoiceInput"
    static let name: StaticString = "StartListening"

    private static let signposter = OSSignposter(subsystem: subsystem, category: category)

    static func begin(_ field: VoiceInputField) -> OSSignpostIntervalState {
        signposter.beginInterval(name, id: signposter.makeSignpostID(), "field=\(field.rawValue, privacy: .public)")
    }

    static func end(_ interval: OSSignpostIntervalState) {
        signposter.endInterval(name, interval)
    }
}

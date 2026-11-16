import Foundation

/// What `GET /api/voice-input` answers. Voice input exists only when the
/// instance is signed in to Rome Cloud and Rome Cloud allows the account.
struct VoiceInputInfo: Decodable, Equatable, Sendable {
    var available: Bool
    /// Where speech becomes text; nil while Rome cannot name it, or from an
    /// instance older than the field.
    var place: Place? = nil
    /// Why `place` is nil: `rome-cloud-unreachable`, `rome-cloud-not-configured`
    /// or `rome-cloud-signed-out`.
    var placeUnknown: String? = nil

    struct Place: Decodable, Equatable, Sendable {
        /// The provider's name, such as "Soniox".
        var provider: String
        /// The host Rome sends the audio to.
        var host: String
    }

    /// Why Rome Cloud cannot serve voice input right now, for Settings; nil
    /// while it can.
    var problemText: String? {
        if place != nil { return nil }
        switch placeUnknown {
        case "rome-cloud-not-configured": return String(localized: "Not set up in Rome Cloud")
        case "rome-cloud-signed-out": return String(localized: "Sign in to Rome Cloud again")
        default: return String(localized: "Rome Cloud can't be reached")
        }
    }
}

/// Why listening stopped without the guardian's stop action. The raw values
/// are the instance's reasons on `/ws/voice-input`, plus the phone's own.
enum VoiceInputStopReason: String, Sendable, Equatable {
    // The instance's.
    case providerUnavailable = "provider-unavailable"
    case providerRefused = "provider-refused"
    case serviceRefused = "service-refused"
    case serviceUnavailable = "service-unavailable"
    case serviceSignedOut = "service-signed-out"
    case badRequest = "bad-request"
    case timeLimit = "time-limit"
    case noSpeech = "no-speech"
    // The phone's.
    case microphoneBlocked = "microphone-blocked"
    case microphoneFailed = "microphone-failed"
    case connectionLost = "connection-lost"
    case leftChat = "left-chat"
    case backgrounded = "backgrounded"
    case interrupted = "interrupted"
    /// The app closed while listening; told on the next launch.
    case appClosed = "app-closed"

    /// The notice the field shows, in the dashboard's words.
    var notice: String {
        switch self {
        case .providerUnavailable: String(localized: "Transcription service unavailable. Listening stopped")
        case .providerRefused: String(localized: "Transcription service refused the request. Listening stopped")
        case .serviceRefused: String(localized: "Rome Cloud refused voice input. Listening stopped")
        case .serviceUnavailable: String(localized: "Rome Cloud could not be reached. Listening stopped")
        case .serviceSignedOut: String(localized: "Rome Cloud does not accept this Rome's sign-in. Sign in to Rome Cloud again. Listening stopped")
        case .badRequest: String(localized: "Listening stopped after an error")
        case .timeLimit: String(localized: "Listening stopped after 10 minutes")
        case .noSpeech: String(localized: "Listening stopped after 30 seconds without speech")
        case .microphoneBlocked: String(localized: "Microphone blocked. Allow it in Settings")
        case .microphoneFailed: String(localized: "Microphone could not start. Listening stopped")
        case .connectionLost: String(localized: "Connection to Rome lost. Listening stopped")
        case .leftChat: String(localized: "Listening stopped when you left this chat")
        case .backgrounded: String(localized: "Listening stopped when Rome went to the background")
        case .interrupted: String(localized: "Listening stopped when another app used the microphone")
        case .appClosed: String(localized: "Listening stopped when Rome closed")
        }
    }
}

/// Why listening stopped, with Rome Cloud's reason code for `serviceRefused`.
struct VoiceInputStop: Sendable, Equatable {
    var reason: VoiceInputStopReason
    var detail: String? = nil

    /// Rome Cloud's reasons the field names in words of its own.
    var notice: String {
        guard reason == .serviceRefused, let detail else { return reason.notice }
        switch detail {
        case "voice_input_rate_limited": return String(localized: "Too many voice inputs in the last minute. Try again shortly")
        case "voice_input_not_configured": return String(localized: "Rome Cloud has not set up voice input yet. Listening stopped")
        case "provider_unavailable": return String(localized: "Rome Cloud's transcription service is unavailable. Listening stopped")
        case "insufficient_credits": return String(localized: "Not enough Rome credits for voice input. Listening stopped")
        default: return reason.notice
        }
    }
}

/// A message from the instance on `/ws/voice-input`.
enum VoiceInputServerMessage: Equatable, Sendable {
    /// `settled` is appended to the text so far; `pending` replaces the last tail.
    case text(settled: String, pending: String)
    case alive
    case ended
    case error(VoiceInputStop)

    /// nil for anything this app does not know, which it ignores.
    init?(json data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "text":
            guard let settled = object["settled"] as? String, let pending = object["pending"] as? String else { return nil }
            self = .text(settled: settled, pending: pending)
        case "alive": self = .alive
        case "ended": self = .ended
        case "error":
            let raw = object["reason"] as? String ?? ""
            // A reason added after this build still stops listening.
            let reason = VoiceInputStopReason(rawValue: raw) ?? .providerUnavailable
            self = .error(VoiceInputStop(reason: reason, detail: object["detail"] as? String))
        default: return nil
        }
    }
}

enum VoiceInputWire {
    static let socketPath = "/ws/voice-input"
    static let sampleRate = 16_000
    /// The instance says it is there this often while the socket is open.
    static let aliveInterval: Duration = .seconds(1)
    /// Silence from the instance this long means the connection is gone.
    static let quietLimit: Duration = .seconds(3)
    /// After a stop, how long the instance may take to answer before the field keeps what it has.
    static let stopTimeout: Duration = .seconds(20)

    static func start(sampleRate: Int) -> String { #"{"type":"start","sampleRate":\#(sampleRate)}"# }
    static let stop = #"{"type":"stop"}"#
}

/// Spoken text as it lands at the cursor, the way a guardian typing it would:
/// a space before it after a word, and after it before a word. Chinese takes none.
enum SpokenText {
    static func insertion(before: String, heard: String, after: String = "") -> String {
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = text.first, let last = text.last else { return "" }
        let lead = needsSpace(before.last, first) ? " " : ""
        let trail = needsSpace(last, after.first) ? " " : ""
        return lead + text + trail
    }

    private static func needsSpace(_ left: Character?, _ right: Character?) -> Bool {
        guard let left, let right else { return false }
        if left.isWhitespace || isHan(left) || isHan(right) { return false }
        return right.isLetter || right.isNumber
    }

    private static func isHan(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            // CJK Unified Ideographs, Extension A, and Compatibility Ideographs.
            (0x4E00...0x9FFF).contains(scalar.value) || (0x3400...0x4DBF).contains(scalar.value)
                || (0xF900...0xFAFF).contains(scalar.value) || (0x20000...0x2EBEF).contains(scalar.value)
        }
    }
}

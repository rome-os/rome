import Foundation

/// What `GET /api/voice-conversation` answers: true only for the guardian of an
/// instance whose account Rome Cloud lets use voice input.
struct VoiceConversationInfo: Decodable, Equatable, Sendable {
    var available: Bool
}

/// What Rome is doing in a voice conversation: waiting for the guardian,
/// working on their turn, or playing the reply.
enum VoiceConversationState: String, Sendable, Equatable {
    case listening
    case thinking
    case speaking
}

/// Why a voice conversation ended without the guardian's End. The raw values
/// are the instance's reasons on `/ws/voice-conversation`, plus the phone's own.
enum VoiceConversationStopReason: String, Sendable, Equatable {
    // The instance's.
    case unavailable
    case listeningFailed = "listening-failed"
    case speakingFailed = "speaking-failed"
    case chatRefused = "chat-refused"
    case timeLimit = "time-limit"
    case badRequest = "bad-request"
    // The phone's.
    case microphoneBlocked = "microphone-blocked"
    case microphoneFailed = "microphone-failed"
    case connectionLost = "connection-lost"
    case interrupted

    /// The line the field shows, in the dashboard's words.
    var notice: String {
        switch self {
        case .unavailable: String(localized: "Voice conversation is not available right now")
        case .listeningFailed: String(localized: "Rome could not listen. The voice conversation ended")
        case .speakingFailed: String(localized: "Rome could not speak. The voice conversation ended")
        case .chatRefused: String(localized: "This chat can't take a voice conversation")
        case .timeLimit: String(localized: "The voice conversation reached its time limit")
        case .badRequest: String(localized: "The voice conversation ended after an error")
        case .microphoneBlocked: String(localized: "Microphone blocked. Allow it in Settings")
        case .microphoneFailed: String(localized: "The microphone could not start")
        case .connectionLost: String(localized: "Connection to Rome lost. The voice conversation ended")
        case .interrupted: String(localized: "The voice conversation ended when another app used the microphone")
        }
    }

    /// A call or another app kept the microphone: nothing went wrong, so the
    /// line goes by itself once seen.
    var endsWithoutFault: Bool { self == .interrupted }
}

/// A message from the instance on `/ws/voice-conversation`. The guardian's
/// words and the reply's text reach the chat as ordinary messages, so the
/// phone reads only what drives the audio and the capsule.
enum VoiceConversationServerMessage: Equatable, Sendable {
    /// Listening started; the reply's audio comes at this rate.
    case ready(sampleRate: Int)
    case state(VoiceConversationState)
    /// The guardian spoke over the reply: drop what has not played.
    case clear
    case alive
    case ended
    case error(VoiceConversationStopReason)

    /// nil for anything the phone does not act on (`heard`, `turn`,
    /// `caption`) or does not know, which it ignores.
    init?(json data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "ready":
            guard let rate = object["sampleRate"] as? Int, rate > 0 else { return nil }
            self = .ready(sampleRate: rate)
        case "state":
            guard let state = (object["state"] as? String).flatMap(VoiceConversationState.init(rawValue:)) else { return nil }
            self = .state(state)
        case "clear": self = .clear
        case "alive": self = .alive
        case "ended": self = .ended
        case "error":
            // A reason added after this build still ends the conversation.
            let reason = (object["reason"] as? String).flatMap(VoiceConversationStopReason.init(rawValue:)) ?? .badRequest
            self = .error(reason)
        default: return nil
        }
    }
}

enum VoiceConversationWire {
    static let socketPath = "/ws/voice-conversation"
    /// The microphone's audio goes up as dictation's does.
    static let sampleRate = VoiceInputWire.sampleRate
    /// Rome says it is there every second; silence this long means the connection is gone.
    static let quietLimit: Duration = .seconds(3)
    /// Opening the socket on a slow mobile network gets this long first.
    static let openLimit: Duration = .seconds(10)
    /// After the connection drops, the phone calls Rome again for this long.
    static let reconnectWindow: Duration = .seconds(30)
    /// How long it waits between two calls.
    static let reconnectEvery: Duration = .seconds(2)

    /// The first message: the chat to talk in, and the microphone's rate.
    static func start(chatId: String, sampleRate: Int) -> String {
        let object: [String: Any] = ["type": "start", "chatId": chatId, "sampleRate": sampleRate]
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    static let stop = #"{"type":"stop"}"#
}

import SwiftUI

/// Why a send did not go through, in the words the bubble shows.
enum SendFailure: Hashable, Sendable {
    case offline
    /// The instance did not answer, or a proxy in front of it did not: stopped, updating, or the network.
    case unreachable
    case sessionExpired
    case archived
    case notFound
    /// Chat is turned off on this instance.
    case chatOff
    case serverError
    /// The instance refused the message and said why (a 4xx with `error`).
    case rejected(String)
    case unknown

    init(_ error: Error) {
        guard let error = error as? APIError else {
            self = .unknown
            return
        }
        switch error {
        case .offline: self = .offline
        case .network: self = .unreachable
        case .unauthorized: self = .sessionExpired
        case .conciergeOff: self = .chatOff
        case .notFound: self = .notFound
        case .tooLarge: self = .rejected(String(localized: "Too large to send"))
        case .decoding: self = .unknown
        case .server(let status, let message):
            let text = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if status == 409, text.localizedCaseInsensitiveContains("archived") {
                self = .archived
            } else if [502, 503, 504].contains(status) {
                self = .unreachable
            } else if status >= 500 {
                self = .serverError
            } else if !text.isEmpty {
                self = .rejected(text)
            } else {
                self = .unknown
            }
        }
    }

    /// A short reason; nil says nothing more than "not sent".
    var reason: String? {
        switch self {
        case .offline: return String(localized: "No network")
        case .unreachable: return String(localized: "Can't reach your Rome")
        case .sessionExpired: return String(localized: "Session expired")
        case .archived: return String(localized: "Chat is archived")
        case .notFound: return String(localized: "Chat not found")
        case .chatOff: return String(localized: "Chat is off")
        case .serverError: return String(localized: "Server error")
        case .rejected(let text): return text
        case .unknown: return nil
        }
    }

    /// Whether sending the same message again can work. A refusal stays a refusal.
    var retryable: Bool {
        switch self {
        case .archived, .notFound, .chatOff, .rejected: return false
        default: return true
        }
    }

    /// The line under the bubble.
    var line: String {
        switch (reason, retryable) {
        case (nil, _): return String(localized: "Not sent · Tap to retry")
        case (let reason?, true): return String(localized: "Not sent · \(reason) · Tap to retry")
        case (let reason?, false): return String(localized: "Not sent · \(reason)")
        }
    }
}

/// A failed turn, or a model error a turn stored: what it says, and which
/// next step the guardian has.
struct TurnError: Hashable, Sendable, ExpressibleByStringLiteral {
    /// What the instance said, as it said it.
    var text: String
    var code: String?
    var provider: String?
    var reason: String?
    /// The error came from a failed turn's trace, which has the text only;
    /// its words are read for the kind.
    var fromTrace = false

    init(text: String, code: String? = nil, provider: String? = nil, reason: String? = nil, fromTrace: Bool = false) {
        self.text = text
        self.code = code
        self.provider = provider
        self.reason = reason
        self.fromTrace = fromTrace
    }

    init(stringLiteral value: String) { self.init(text: value) }

    enum Kind: Hashable, Sendable {
        case creditsUsedUp, authRevoked, notSignedIn, limit, allAtLimit, modelDenied, noProvider
        case other
    }

    var kind: Kind {
        if code == "credits_used_up" { return .creditsUsedUp }
        if code == "auth_revoked" { return .authRevoked }
        if reason == "not_logged_in" { return .notSignedIn }
        if reason == "quota_exhausted" { return provider == nil ? .allAtLimit : .limit }
        if reason == "model_access_denied" { return .modelDenied }
        if reason == "no_available_provider" || ["model_unavailable", "model_provider_unavailable", "no_model_provider_available"].contains(code) { return .noProvider }
        if fromTrace, Self.limitWords.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil { return .limit }
        return .other
    }

    /// The wording of a provider's own limit messages ("You've hit your limit",
    /// "out of usage credits", "credit balance is too low", a spend limit).
    private static let limitWords = try! NSRegularExpression(
        pattern: "hit your (?:session |weekly )?limit|usage limit|out of usage credits|credit balance|spend(?:ing)? limit|shared budget",
        options: .caseInsensitive
    )

    private var providerName: String {
        switch provider {
        case "openai": return "Codex"
        case "anthropic": return "Claude"
        default: return String(localized: "AI tool")
        }
    }

    /// The headline.
    var title: String {
        let name = providerName
        switch kind {
        case .creditsUsedUp: return String(localized: "Rome credits used up")
        case .authRevoked: return String(localized: "Reconnect \(name)")
        case .notSignedIn: return String(localized: "\(name) is not signed in")
        case .limit: return provider == nil ? String(localized: "Usage limit reached") : String(localized: "\(name) usage limit reached")
        case .allAtLimit: return String(localized: "All AI tools are at their limits")
        case .modelDenied: return String(localized: "This model is unavailable")
        case .noProvider: return String(localized: "No AI tool is available")
        case .other: return text.isEmpty ? String(localized: "This turn did not finish") : text
        }
    }

    /// The next step; nil when the headline stands alone.
    var hint: String? {
        switch kind {
        case .creditsUsedUp: return String(localized: "Connect Claude or ChatGPT, then send again")
        case .authRevoked: return String(localized: "Its login expired. Reconnect it, then send again")
        case .notSignedIn: return String(localized: "Sign in to it, then send again")
        case .limit: return String(localized: "Wait for the reset, or use another model")
        case .allAtLimit: return String(localized: "Wait for a reset, or sign in with another account")
        case .modelDenied: return String(localized: "Check model access, or pick another model")
        case .noProvider: return String(localized: "Connect Claude or ChatGPT")
        case .other: return nil
        }
    }

    /// Smaller words under the headline: what a failed turn said, when the
    /// headline is ours.
    var detail: String? {
        switch kind {
        case .other: return nil
        default: return fromTrace && !text.isEmpty ? text : nil
        }
    }

    /// The error is about the AI tools' accounts, which Settings shows.
    var offersUsage: Bool { kind != .other }
}

/// An error the guardian can act on: a line with the cause, the next step,
/// and where to look.
struct ErrorLine: View {
    let error: TurnError
    @Environment(\.openUsage) private var openUsage
    @Environment(\.isVisitor) private var isVisitor

    init(error: TurnError) { self.error = error }

    init(text: String) { self.init(error: TurnError(text: text)) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            AlertGlyph(size: 16).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 3) {
                Text(error.title)
                    .romeFont(15, error.kind == .other ? .regular : .medium)
                    .lineSpacing(5)
                if let hint = error.hint {
                    Text(hint).romeFont(14).foregroundStyle(Palette.sub)
                }
                if let detail = error.detail {
                    Text(detail).romeFont(13).foregroundStyle(Palette.sub).lineLimit(3)
                }
                if error.offersUsage, !isVisitor, let openUsage {
                    Button(action: openUsage) {
                        Text("See usage")
                            .romeFont(13, .semibold)
                            .padding(.horizontal, 12)
                            .frame(height: 30)
                            .background(Palette.fill, in: Capsule())
                    }
                    .buttonStyle(PressScaleStyle())
                    .padding(.top, 4)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(2)
        .accessibilityElement(children: .contain)
    }
}

extension EnvironmentValues {
    /// Opens Settings, where each AI tool's usage shows. Nil where there is no Settings.
    @Entry var openUsage: (@MainActor () -> Void)? = nil
}

/// What a transcript's store has to say above the chat: no network, a load
/// that failed, or a short notice about an action that failed.
struct TranscriptBanners: View {
    let store: TranscriptStore

    /// Whether any banner shows, for the room the screen leaves for it.
    static func shows(_ store: TranscriptStore) -> Bool {
        store.loadError == .offline || store.loadFailed || store.notice != nil
    }

    var body: some View {
        VStack(spacing: 8) {
            if store.loadError == .offline {
                TopBanner(kind: .warning, text: String(localized: "No network connection"))
            } else if store.loadFailed {
                TopBanner(kind: .error, text: String(localized: "Couldn't load this chat"), actionTitle: String(localized: "Retry")) { store.resync() }
            }
            if let notice = store.notice {
                TopBanner(kind: .error, text: notice)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: store.loadFailed)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: store.notice)
    }
}

/// A quiet centered line in the transcript, such as the chat moving to
/// another model.
struct NoticeLine: View {
    let text: String

    var body: some View {
        Text(text)
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
    }
}

/// Rome's mark on a guardian message: it is being worked on, or it failed.
enum StatusMark: String, Hashable, Sendable {
    case working, failed

    var emoji: String { self == .working ? "👀" : "⚠️" }

    var label: String {
        switch self {
        case .working: return String(localized: "Working on it")
        case .failed: return String(localized: "Didn't finish")
        }
    }
}

/// The mark's capsule, on the inner bottom corner of a bubble.
struct StatusMarkBadge: View {
    let mark: StatusMark

    var body: some View {
        Text(mark.emoji)
            .romeFont(12)
            .padding(.horizontal, 6)
            .frame(height: 22)
            .background(Palette.elevated, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.hair, lineWidth: 0.5))
            .accessibilityElement()
            .accessibilityLabel(mark.label)
    }
}

/// A message Rome could not hand to an agent, as the instance records it.
extension PendingSend.State {
    /// The delivery state a stored message's `inputState` says, if it is a bad one.
    static func stored(inputState: String?) -> PendingSend.State? {
        switch inputState {
        case "failed": return .notDelivered
        case "unknown": return .unconfirmed
        default: return nil
        }
    }
}

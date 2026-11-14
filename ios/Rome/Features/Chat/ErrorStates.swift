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

    /// Why it did not go, in plain words, at the top of the bubble's menu.
    var menuTitle: String {
        guard let reason else { return String(localized: "Not sent") }
        return String(localized: "Not sent · \(reason)")
    }
}

/// What is wrong with a guardian's message, as the menu on its icon says it:
/// the reason, then what can be done.
struct SendProblem {
    var title: String
    /// "Retry" or "Send again"; nil where trying again cannot work.
    var retryTitle: String?
    /// Rome is not sure it arrived, which is less than a failure: a calmer icon.
    var calm = false
    var onRetry: () -> Void = {}
    /// Removes a send nothing has kept; nil leaves it out.
    var onDelete: (() -> Void)?

    init?(_ state: PendingSend.State?, onRetry: @escaping () -> Void, onDelete: (() -> Void)?) {
        switch state {
        case .failed(let failure)?:
            title = failure.menuTitle
            retryTitle = failure.retryable ? String(localized: "Retry") : nil
        case .notDelivered?:
            title = String(localized: "Not delivered")
            retryTitle = String(localized: "Retry")
        case .unconfirmed?:
            title = String(localized: "Not sure Chat got this. You can send it again.")
            retryTitle = String(localized: "Send again")
            calm = true
        default:
            return nil
        }
        self.onRetry = onRetry
        self.onDelete = onDelete
    }
}

/// The menu of a message that did not go through: the reason on top, then
/// Retry where it can work, Copy and Delete.
struct SendProblemItems: View {
    let problem: SendProblem
    let text: String

    var body: some View {
        Section {
            if let retryTitle = problem.retryTitle {
                Button(action: problem.onRetry) { Label(retryTitle, systemImage: "arrow.clockwise") }
            }
            if !text.isEmpty { CopyButton(text: text) }
            if let onDelete = problem.onDelete {
                Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
            }
        } header: {
            Text(verbatim: problem.title)
        }
    }
}

/// The icon at a message's leading side: a tap opens the same menu as a long press.
struct SendProblemIcon: View {
    let problem: SendProblem
    let text: String

    var body: some View {
        Menu {
            SendProblemItems(problem: problem, text: text)
        } label: {
            Group {
                if problem.calm {
                    Image(systemName: "questionmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(Palette.sub)
                } else {
                    AlertGlyph(size: 18)
                }
            }
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(problem.title)
    }
}

/// A failed turn, or a model error a turn stored: what it says, and which
/// next step the guardian has.
struct TurnError: Hashable, Sendable {
    /// What the instance said, as it said it.
    var text: String
    var code: String?
    var provider: String?
    var reason: String?
    /// A turn that ended in error, as its trace says it: plain words, with the
    /// instance's text after them, and no guidance.
    var didntFinish = false

    init(text: String, code: String? = nil, provider: String? = nil, reason: String? = nil, didntFinish: Bool = false) {
        self.text = text
        self.code = code
        self.provider = provider
        self.reason = reason
        self.didntFinish = didntFinish
    }

    enum Kind: Hashable, Sendable {
        case notSignedIn, limit, allAtLimit, modelDenied, noProvider
        case other
    }

    var kind: Kind {
        if reason == "not_logged_in" { return .notSignedIn }
        if code == "usage_limit" { return .limit }
        if reason == "quota_exhausted" { return provider == nil ? .allAtLimit : .limit }
        if reason == "model_access_denied" { return .modelDenied }
        if reason == "no_available_provider" || ["model_unavailable", "model_provider_unavailable", "no_model_provider_available"].contains(code) { return .noProvider }
        return .other
    }

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
        case .notSignedIn: return String(localized: "\(name) is not signed in")
        case .limit: return provider == nil ? String(localized: "Usage limit reached") : String(localized: "\(name) usage limit reached")
        case .allAtLimit: return String(localized: "All AI tools are at their limits")
        case .modelDenied: return String(localized: "This model is unavailable")
        case .noProvider: return String(localized: "No AI tool is available")
        case .other:
            if didntFinish { return text.isEmpty ? String(localized: "Didn't finish") : String(localized: "Didn't finish: \(text)") }
            return text.isEmpty ? String(localized: "This turn did not finish") : text
        }
    }

    /// The next step; nil when the headline stands alone.
    var hint: String? {
        switch kind {
        case .notSignedIn: return String(localized: "Sign in to it, then send again")
        case .limit: return String(localized: "Wait for the reset, or use another model")
        case .allAtLimit: return String(localized: "Wait for a reset, or sign in with another account")
        case .modelDenied: return String(localized: "Check model access, or pick another model")
        case .noProvider: return String(localized: "Connect Claude or ChatGPT")
        case .other: return nil
        }
    }

    /// The error is about the AI tools' accounts, which Settings shows.
    var offersUsage: Bool { kind != .other }
}

/// An error the guardian can act on, as a compact card: a soft warning, the
/// cause, the next step, and where to look.
struct ErrorLine: View {
    let error: TurnError
    @Environment(\.openUsage) private var openUsage
    @Environment(\.isVisitor) private var isVisitor

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.circle.fill")
                .romeFont(14)
                .foregroundStyle(Palette.warning)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(error.title)
                    .romeFont(CardScale.body, .medium)
                    .fixedSize(horizontal: false, vertical: true)
                if let hint = error.hint {
                    Text(hint)
                        .romeFont(CardScale.caption)
                        .foregroundStyle(Palette.sub)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if error.offersUsage, !isVisitor, let openUsage {
                    Button { openUsage.run(()) } label: {
                        Text("See usage")
                            .romeFont(CardScale.caption, .semibold)
                            .foregroundStyle(Palette.primaryText)
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .softElevation(radius: Metrics.cardRadius)
        .bubbleWidth()
        .accessibilityElement(children: .contain)
    }
}

extension EnvironmentValues {
    /// Opens Settings, where each AI tool's usage shows. Nil where there is no Settings.
    @Entry var openUsage: ShellAction<Void, Void>? = nil
}

/// The load-error bar: "Couldn't load this chat" with Retry, or with a
/// spinner in Retry's place while an attempt runs.
enum LoadBar: Equatable { case failed, retrying }

/// What a transcript's store has to say above the chat: no network, a load
/// that failed, or a short notice about an action that failed.
struct TranscriptBanners: View {
    let store: TranscriptStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether any banner shows, for the room the screen leaves for it.
    static func shows(_ store: TranscriptStore) -> Bool {
        store.loadError == .offline || store.loadBar != nil || store.notice != nil
    }

    var body: some View {
        VStack(spacing: 8) {
            if store.loadError == .offline {
                TopBanner(kind: .warning, text: String(localized: "No network connection"))
            } else if let bar = store.loadBar {
                // One bar: a retry turns only its button into a spinner, and
                // a failed one shakes the bar, so the attempt is seen.
                TopBanner(kind: .error, text: String(localized: "Couldn't load this chat"), actionTitle: String(localized: "Retry"), busy: bar == .retrying) {
                    store.retryLoad()
                }
                .keyframeAnimator(initialValue: CGFloat.zero, trigger: store.retryFailures) { content, offset in
                    content.offset(x: offset)
                } keyframes: { _ in
                    // With Reduce Motion the bar stays still; the haptic still tells.
                    let amount: CGFloat = reduceMotion ? 0 : 1
                    KeyframeTrack {
                        LinearKeyframe(-7 * amount, duration: 0.06)
                        LinearKeyframe(6 * amount, duration: 0.08)
                        LinearKeyframe(-4 * amount, duration: 0.08)
                        LinearKeyframe(2 * amount, duration: 0.07)
                        LinearKeyframe(0, duration: 0.06)
                    }
                }
                .sensoryFeedback(.impact(weight: .light), trigger: store.retryFailures)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if let notice = store.notice {
                TopBanner(kind: .error, text: notice)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: store.loadBar)
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

/// The reaction's round badge, a nod to a tapback on a bubble's corner: the
/// emoji the Concierge reacted with, whatever string the server sends, on a quiet surface, and one small dot trailing off down and out, as a
/// thought bubble does. It is drawn about its own center, so the bubble's
/// overlay sets where that center sits.
struct StatusMarkBadge: View {
    static let size: CGFloat = 30
    let mark: String

    var body: some View {
        Text(mark)
            .romeFont(16)
            .frame(width: Self.size, height: Self.size)
            .background(Palette.markFill, in: Circle())
            .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
            .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
            .overlay {
                Circle()
                    .fill(Palette.markFill)
                    .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                    .frame(width: 6, height: 6)
                    .offset(x: -Self.size * 0.48, y: Self.size * 0.48)
            }
            .accessibilityElement()
            .accessibilityLabel(mark)
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

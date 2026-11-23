import Foundation

/// `provider_failure`: the provider a turn needed could not run, so the turn
/// did not run. The server decides the card and its buttons; the app draws
/// them (docs/domains/agents.md#provider-failure).
struct ProviderFailurePart: Hashable, Sendable {
    /// What the guardian has to do: wait, fix the account, or pick another model.
    enum Kind: String, Hashable, Sendable { case wait, account, model }

    /// How a card or notice was settled.
    struct Resolution: Hashable, Sendable {
        /// `switched`, `recovered`, or `moved` (a later turn carries the card
        /// now, or a silent retry got past it: nothing shows).
        let by: String
        let provider: DefaultModelProvider?
        let model: String?
        /// Whether the stopped turn ran again; a card written before the
        /// server sent it reads as true.
        let continued: Bool?

        init(by: String, provider: DefaultModelProvider? = nil, model: String? = nil, continued: Bool? = nil) {
            self.by = by
            self.provider = provider
            self.model = model
            self.continued = continued
        }

        init?(_ value: JSONValue?) {
            guard let value, let by = value["by"]?.string else { return nil }
            self.init(by: by, provider: value["provider"]?.string.map(DefaultModelProvider.init(wire:)), model: value["model"]?.string, continued: value["continued"]?.bool)
        }
    }

    /// Another model of the same provider, for a `model` card.
    struct Replacement: Hashable, Sendable {
        let selection: String
        let model: String
    }

    let provider: DefaultModelProvider
    /// `quota`, `login`, `removed`, `temporary`, `capacity`,
    /// `model_unavailable`, `spend_cap` or `credits_used_up`.
    let reason: String
    /// When the usage limit ends, for a quota.
    var until: String? = nil
    /// For a quota: Rome continues the stopped turn by itself once it ends.
    var continues = false
    var alternatives: [DefaultModelProvider] = []
    let chatId: String
    /// Absent on cards written before it: read from the reason.
    var card: Kind? = nil
    /// The model the turn needed, for `capacity` and `model_unavailable`.
    var model: String? = nil
    var replacement: Replacement? = nil
    /// "Use Rome credits": no AI account is logged in and a balance is left.
    var credits = false
    /// The provider's own error, behind Details.
    var detail: String? = nil
    /// Rome retries this quietly: nothing shows yet.
    var retrying = false
    var resolved: Resolution? = nil

    init(provider: DefaultModelProvider, reason: String, until: String? = nil, continues: Bool = false, alternatives: [DefaultModelProvider] = [], chatId: String, card: Kind? = nil, model: String? = nil, replacement: Replacement? = nil, credits: Bool = false, detail: String? = nil, retrying: Bool = false, resolved: Resolution? = nil) {
        self.provider = provider
        self.reason = reason
        self.until = until
        self.continues = continues
        self.alternatives = alternatives
        self.chatId = chatId
        self.card = card
        self.model = model
        self.replacement = replacement
        self.credits = credits
        self.detail = detail
        self.retrying = retrying
        self.resolved = resolved
    }

    init?(_ value: JSONValue) {
        guard let provider = value["provider"]?.string, let reason = value["reason"]?.string else { return nil }
        let replacement = value["replacement"].flatMap { item -> Replacement? in
            guard let selection = item["selection"]?.string, let model = item["model"]?.string else { return nil }
            return Replacement(selection: selection, model: model)
        }
        self.init(
            provider: DefaultModelProvider(wire: provider),
            reason: reason,
            until: value["until"]?.string,
            continues: value["continues"]?.bool ?? false,
            alternatives: (value["alternatives"]?.array ?? []).compactMap(\.string).map(DefaultModelProvider.init(wire:)),
            chatId: value["chatId"]?.string ?? "",
            card: value["card"]?.string.flatMap(Kind.init(rawValue:)),
            model: value["model"]?.string,
            replacement: replacement,
            credits: value["credits"]?.bool ?? false,
            detail: value["detail"]?.string,
            retrying: value["retrying"]?.bool ?? false,
            resolved: Resolution(value["resolved"])
        )
    }

    var kind: Kind { ProviderFailureCopy.kind(card: card, reason: reason) }

    /// A quiet retry, or a card a later turn carries now: nothing to show.
    var drawsNothing: Bool { retrying || resolved?.by == "moved" }
}

/// `provider_outage`: the notice in the main Chat for unattended chats one
/// provider failure stopped. It only informs: each chat's own card acts.
struct ProviderOutagePart: Hashable, Sendable {
    let outageId: String
    let provider: DefaultModelProvider
    let reason: String
    var until: String? = nil
    /// The stopped chats: the task links.
    var chatIds: [String] = []
    var card: ProviderFailurePart.Kind? = nil
    /// Set once every chat it lists has run again.
    var resolvedAt: String? = nil
    var resolved: ProviderFailurePart.Resolution? = nil

    init(outageId: String, provider: DefaultModelProvider, reason: String, until: String? = nil, chatIds: [String] = [], card: ProviderFailurePart.Kind? = nil, resolvedAt: String? = nil, resolved: ProviderFailurePart.Resolution? = nil) {
        self.outageId = outageId
        self.provider = provider
        self.reason = reason
        self.until = until
        self.chatIds = chatIds
        self.card = card
        self.resolvedAt = resolvedAt
        self.resolved = resolved
    }

    init?(_ value: JSONValue) {
        guard let id = value["outageId"]?.string, let provider = value["provider"]?.string, let reason = value["reason"]?.string else { return nil }
        self.init(
            outageId: id,
            provider: DefaultModelProvider(wire: provider),
            reason: reason,
            until: value["until"]?.string,
            chatIds: (value["chatIds"]?.array ?? []).compactMap(\.string),
            card: value["card"]?.string.flatMap(ProviderFailurePart.Kind.init(rawValue:)),
            resolvedAt: value["resolvedAt"]?.string,
            resolved: ProviderFailurePart.Resolution(value["resolved"])
        )
    }

    /// Settled: one quiet line. A notice the server settled with no
    /// resolution reads as recovered.
    var settled: ProviderFailurePart.Resolution? {
        resolved ?? resolvedAt.map { _ in ProviderFailurePart.Resolution(by: "recovered") }
    }
}

/// The buttons a failure card offers, in the web's order.
enum ProviderFailureAction: Hashable, Sendable {
    /// Runs the stopped turn again at once.
    case retry
    /// A quota's turn, once its reset passed.
    case continueTurn
    /// Opens the login of the card's account.
    case logIn
    /// Moves this chat to another logged-in account.
    case switchTo(DefaultModelProvider)
    /// The confirm's other way: moves this chat and makes that account the
    /// default, moving the other chats that follow it too.
    case switchAndMakeDefault(DefaultModelProvider)
    /// Every chat runs on Rome credits.
    case useCredits
    /// Another model of the same provider.
    case switchModel(ProviderFailurePart.Replacement)

    /// What the server switches to for this button; nil for the rest.
    var switchBody: JSONValue? {
        switch self {
        case .switchTo(let provider):
            // This chat only: it becomes pinned there.
            return .object(["kind": .string("provider"), "provider": .string(provider.wire), "makeDefault": .bool(false)])
        case .switchAndMakeDefault(let provider):
            return .object(["kind": .string("provider"), "provider": .string(provider.wire), "makeDefault": .bool(true), "moveExisting": .bool(true)])
        case .useCredits:
            return .object(["kind": .string("provider"), "provider": .string(DefaultModelProvider.romeCredits.wire), "makeDefault": .bool(true)])
        case .switchModel(let replacement):
            return .object(["kind": .string("model"), "selection": .string(replacement.selection)])
        case .retry, .continueTurn, .logIn:
            return nil
        }
    }

    /// Asks first, as the web does for a move to another provider.
    var confirms: Bool {
        switch self {
        case .switchTo, .useCredits: return true
        default: return false
        }
    }

    var title: String {
        switch self {
        case .retry: return String(localized: "Retry")
        case .continueTurn: return String(localized: "Continue")
        case .logIn: return String(localized: "Log in")
        case .switchTo(let provider): return String(localized: "Switch to \(provider.name)")
        case .switchAndMakeDefault: return String(localized: "Switch all chats and make default")
        case .useCredits: return String(localized: "Use Rome credits")
        case .switchModel(let replacement): return String(localized: "Switch to \(ModelNames.display(replacement.model))")
        }
    }

    /// Every card runs its turn again on a click: a quota reads Continue once
    /// its reset has passed (or with no reset known), anything else Retry. It
    /// leads only on a wait it may get past; elsewhere it comes last.
    static func of(_ part: ProviderFailurePart, now: Date = .now) -> [ProviderFailureAction] {
        let kind = part.kind
        let quota = part.reason == "quota"
        let resetPassed = part.until == nil || RomeDate.parse(part.until).map { $0 <= now } == true
        let again: ProviderFailureAction = quota && resetPassed ? .continueTurn : .retry
        let againLeads = kind == .wait && (again == .continueTurn || !quota)
        var actions: [ProviderFailureAction] = againLeads ? [again] : []
        if kind == .account { actions.append(.logIn) }
        if kind != .model {
            actions += part.alternatives.filter { $0 != .romeCredits }.map(ProviderFailureAction.switchTo)
            if kind == .account, part.credits { actions.append(.useCredits) }
        }
        if kind == .model, let replacement = part.replacement { actions.append(.switchModel(replacement)) }
        if !againLeads { actions.append(again) }
        return actions
    }
}

/// The words of failure cards and outage notices, as the web writes them.
enum ProviderFailureCopy {
    static func kind(card: ProviderFailurePart.Kind?, reason: String) -> ProviderFailurePart.Kind {
        if let card { return card }
        switch reason {
        case "quota", "temporary", "capacity": return .wait
        case "model_unavailable": return .model
        default: return .account
        }
    }

    /// When a limit ends: today, tomorrow or a date, and the time.
    enum Day: Equatable { case today, tomorrow, date }

    static func when(_ date: Date, now: Date, calendar: Calendar = .current) -> (day: Day, date: String, time: String) {
        let time = date.formatted(date: .omitted, time: .shortened)
        let day = date.formatted(.dateTime.month(.abbreviated).day())
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        return (days <= 0 ? .today : days == 1 ? .tomorrow : .date, day, time)
    }

    /// The open card's status line: whether the turn waits, needs the
    /// guardian, or needs another model. A wait carries its reset time.
    static func status(_ part: ProviderFailurePart, now: Date = .now) -> String {
        switch part.kind {
        case .account: return String(localized: "Needs you")
        case .model: return String(localized: "Model unavailable")
        case .wait:
            guard let until = RomeDate.parse(part.until), until > now else { return String(localized: "Paused") }
            let at = when(until, now: now)
            switch (part.continues, at.day) {
            case (true, .today): return String(localized: "Paused · continues after \(at.time)")
            case (true, .tomorrow): return String(localized: "Paused · continues tomorrow after \(at.time)")
            case (true, .date): return String(localized: "Paused · continues after \(at.date), \(at.time)")
            case (false, .today): return String(localized: "Paused until \(at.time)")
            case (false, .tomorrow): return String(localized: "Paused until tomorrow \(at.time)")
            case (false, .date): return String(localized: "Paused until \(at.date), \(at.time)")
            }
        }
    }

    /// The open card's reason, under its status line.
    static func reason(_ part: ProviderFailurePart, now: Date = .now) -> String {
        let provider = part.provider.name
        switch part.reason {
        case "quota": return String(localized: "\(provider) quota used up")
        case "temporary": return String(localized: "\(provider) is unavailable for now")
        case "capacity": return String(localized: "\(part.model.map(ModelNames.display) ?? provider) is unavailable for now")
        default:
            if part.kind == .wait { return String(localized: "\(provider) is unavailable for now") }
            return text(provider: part.provider, reason: part.reason, until: part.until, continues: part.continues, card: part.card, model: part.model, now: now)
        }
    }

    /// The one line on what stopped, for a notice and an account or model card.
    static func text(provider: DefaultModelProvider, reason: String, until: String?, continues: Bool, card: ProviderFailurePart.Kind?, model: String?, now: Date = .now) -> String {
        let name = provider.name
        let modelName = model.map(ModelNames.display) ?? name
        switch reason {
        case "quota":
            guard let date = RomeDate.parse(until) else { return String(localized: "\(name) hit its usage limit. You can continue once it resets.") }
            let at = when(date, now: now)
            switch (continues, at.day) {
            case (true, .today): return String(localized: "\(name) hit its usage limit. Rome continues after \(at.time).")
            case (true, .tomorrow): return String(localized: "\(name) hit its usage limit. Rome continues tomorrow after \(at.time).")
            case (true, .date): return String(localized: "\(name) hit its usage limit. Rome continues after \(at.date), \(at.time).")
            case (false, .today): return String(localized: "\(name) hit its usage limit. You can continue after \(at.time).")
            case (false, .tomorrow): return String(localized: "\(name) hit its usage limit. You can continue tomorrow after \(at.time).")
            case (false, .date): return String(localized: "\(name) hit its usage limit. You can continue after \(at.date), \(at.time).")
            }
        case "temporary": return String(localized: "\(name) is unavailable for now.")
        case "capacity": return String(localized: "\(modelName) is unavailable for now.")
        case "login": return String(localized: "\(name) needs you to log in again")
        case "removed": return String(localized: "\(name) is not logged in")
        case "credits_used_up": return String(localized: "Rome credits are used up")
        case "spend_cap": return String(localized: "\(name) reached its spending limit")
        case "model_unavailable": return String(localized: "\(modelName) is unavailable")
        default:
            switch kind(card: card, reason: reason) {
            case .wait: return String(localized: "\(name) is unavailable for now.")
            case .model: return String(localized: "\(modelName) is unavailable")
            case .account: return String(localized: "\(name) cannot run on this account")
            }
        }
    }

    /// The one line a settled card or notice reads as.
    static func resolved(_ resolution: ProviderFailurePart.Resolution) -> String {
        let target = resolution.model.map(ModelNames.display) ?? resolution.provider?.name
        let ran = resolution.continued != false
        if resolution.by == "switched", let target {
            return ran ? String(localized: "Switched to \(target), continued") : String(localized: "Switched to \(target)")
        }
        return ran ? String(localized: "Recovered, continued") : String(localized: "Recovered")
    }

    static func outage(_ part: ProviderOutagePart, now: Date = .now) -> String {
        text(provider: part.provider, reason: part.reason, until: part.until, continues: false, card: part.card, model: nil, now: now)
    }

    static func waiting(_ count: Int) -> String {
        String(localized: "\(count) tasks waiting")
    }
}

extension MessagePart {
    var isProviderFailure: Bool {
        if case .providerFailure = self { return true }
        return false
    }
}

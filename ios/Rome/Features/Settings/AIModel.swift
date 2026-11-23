import SwiftUI

/// How a line about the AI model reads: plain, a warning (it waits on a
/// quota) or a danger (it needs the guardian).
enum AILineTone: Equatable {
    case plain, warning, danger

    var color: Color {
        switch self {
        case .plain: return Palette.sub
        case .warning: return Palette.warningText
        case .danger: return Palette.destructive
        }
    }
}

/// Text about an account's usage and quota, shared by Settings' row and the
/// AI Tools page.
enum AIUsageText {
    /// The tightest usage window, "12% of 5h used"; nil with no window known.
    static func used(_ usage: AIToolsStatus.Usage?) -> String? {
        let windows: [(Double, Bool)] = [
            usage?.fiveHour?.usedPercent.map { ($0, true) },
            usage?.sevenDay?.usedPercent.map { ($0, false) },
        ].compactMap { $0 }
        guard let tightest = windows.max(by: { $0.0 < $1.0 }) else { return nil }
        let percent = Int(min(100, max(0, tightest.0)).rounded())
        return tightest.1 ? String(localized: "\(percent)% of 5h used") : String(localized: "\(percent)% of 7d used")
    }

    /// "Quota used up until 14:20", with the date when it is not today.
    static func quota(until: String?, now: Date = .now, calendar: Calendar = .current) -> String {
        guard let date = RomeDate.parse(until), date > now else { return String(localized: "Quota used up") }
        return String(localized: "Quota used up until \(time(date, now: now, calendar: calendar))")
    }

    /// A time later today as "14:20", a later one with its date.
    static func time(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// "$2.00".
    static func dollars(_ amount: Double) -> String {
        amount.formatted(.currency(code: "USD").presentation(.narrow))
    }
}

/// What Settings' AI Tools row says: the default model, and whether chats
/// can run on it (docs/domains/agents.md#default-provider).
enum AIModelSummary: Equatable {
    /// Not read yet.
    case loading
    /// The default runs. `usage`: its tightest window, when shown.
    case ready(DefaultModelProvider, usage: String?)
    /// The default waits on its quota, until a time when one is known.
    case paused(DefaultModelProvider, until: String?)
    /// The default needs the guardian to log in: `expired` once it was.
    case needsLogin(DefaultModelProvider, expired: Bool)
    /// No account logged in and Rome credits not chosen: chats cannot reply.
    case notSetUp
    /// Rome credits are the default, with what is left when it is known.
    case credits(dollars: Double?)

    /// Reads the row from the status. A server that has set no default yet
    /// (the accounts not read) runs a logged-in account, Claude first.
    static func of(_ status: AIToolsStatus?, showsUsage: Bool, credits: Double?) -> AIModelSummary {
        guard let status else { return .loading }
        let loggedIn: [DefaultModelProvider] = [.anthropic, .openai].filter { status.provider($0)?.loggedIn == true }
        guard let provider = status.defaultProvider?.provider ?? loggedIn.first else { return .notSetUp }
        if provider == .romeCredits { return .credits(dollars: credits) }
        // The last account logged out and no credits took over: nothing runs.
        let expired = [DefaultModelProvider.anthropic, .openai].contains { status.provider($0)?.needsReauth == true }
        if loggedIn.isEmpty, !expired { return .notSetUp }
        guard let account = status.provider(provider) else { return .ready(provider, usage: nil) }
        if account.needsReauth == true { return .needsLogin(provider, expired: true) }
        if account.loggedIn == false { return .needsLogin(provider, expired: false) }
        if account.quotaExhausted == true { return .paused(provider, until: account.quotaExhaustedUntil) }
        let usage = showsUsage && !account.usesAPIKey ? AIUsageText.used(account.usage) : nil
        return .ready(provider, usage: usage)
    }

    var text: String {
        switch self {
        case .loading: return ""
        case .ready(let provider, let usage?): return "\(provider.name) · \(usage)"
        case .ready(let provider, nil): return provider.name
        case .paused(let provider, let until): return "\(provider.name) · \(AIUsageText.quota(until: until))"
        case .needsLogin(let provider, true): return "\(provider.name) · \(String(localized: "Log in again"))"
        case .needsLogin(let provider, false): return "\(provider.name) · \(String(localized: "Not logged in"))"
        case .notSetUp: return String(localized: "Not set up")
        case .credits(let dollars?): return "\(DefaultModelProvider.romeCredits.name) · \(String(localized: "\(AIUsageText.dollars(dollars)) left"))"
        case .credits(nil): return DefaultModelProvider.romeCredits.name
        }
    }

    var tone: AILineTone {
        switch self {
        case .paused: return .warning
        case .needsLogin, .notSetUp: return .danger
        default: return .plain
        }
    }

    /// The row offers [Connect]: nothing runs Chat yet.
    var offersConnect: Bool { self == .notSetUp }
}

/// What an account's row on the AI Tools page says, and the button it offers.
struct AIAccountLine: Equatable {
    /// `logInOrOut`: an expired login, which the server still counts as
    /// signed in, so it can be logged in again or logged out.
    enum Action: Equatable { case logIn, logOut, logInOrOut, none }

    let text: String
    let tone: AILineTone
    let action: Action

    static func of(_ provider: AIToolsStatus.Provider?, showsUsage: Bool) -> AIAccountLine {
        guard let provider else { return AIAccountLine(text: String(localized: "Loading…"), tone: .plain, action: .none) }
        // An API key is managed on the web: it has no login or usage here.
        if provider.usesAPIKey {
            return provider.needsReauth == true
                ? AIAccountLine(text: String(localized: "API key needs update"), tone: .danger, action: .none)
                : AIAccountLine(text: String(localized: "API key"), tone: .plain, action: .none)
        }
        if provider.needsReauth == true {
            return AIAccountLine(text: String(localized: "Login expired"), tone: .danger, action: .logInOrOut)
        }
        guard provider.loggedIn == true else {
            return AIAccountLine(text: String(localized: "Not logged in"), tone: .plain, action: .logIn)
        }
        let loggedIn = String(localized: "Logged in")
        if provider.quotaExhausted == true {
            return AIAccountLine(text: "\(loggedIn) · \(AIUsageText.quota(until: provider.quotaExhaustedUntil))", tone: .warning, action: .logOut)
        }
        if showsUsage, let used = AIUsageText.used(provider.usage) {
            return AIAccountLine(text: "\(loggedIn) · \(used)", tone: .plain, action: .logOut)
        }
        return AIAccountLine(text: loggedIn, tone: .plain, action: .logOut)
    }
}

/// What the AI Tools page asks before the default changes: making an account
/// the default, or a logout that moves it. While chats follow the default,
/// it asks whether they move too, as two actions; with none, one action
/// (docs/domains/agents.md#default-provider).
struct AIDefaultDialog: Equatable, Identifiable {
    enum Subject: Equatable {
        case setDefault(DefaultModelProvider)
        case logOut(AIAccount)
    }

    enum Choice: Hashable {
        /// The chats that follow the default move with it.
        case moveAll
        /// They stay where they run, pinned there.
        case keepChats
        /// No choice to ask: nothing else moves. `destructive` when chats stop.
        case only(destructive: Bool)

        /// Whether the chats that follow the default move, as the route takes it.
        var moveExisting: Bool { self != .keepChats }
    }

    let subject: Subject
    let title: String
    let choices: [Choice]
    /// What the change does; with a choice to move chats, it adds that a
    /// checked move never takes a model its owner picked.
    let message: String

    init(subject: Subject, title: String, message: String, choices: [Choice]) {
        self.subject = subject
        self.title = title
        self.choices = choices
        self.message = choices.contains(.moveAll) ? message + "\n\n" + Self.ownerPicksKeep : message
    }

    /// Under a choice to move chats: owner picks stay (docs/domains/agents.md#pinned-chat).
    static var ownerPicksKeep: String { String(localized: "Chats where you picked a model keep it.") }

    var id: String {
        switch subject {
        case .setDefault(let provider): return "default-\(provider.wire)"
        case .logOut(let account): return "logout-\(account.rawValue)"
        }
    }

    func label(_ choice: Choice) -> String {
        switch (subject, choice) {
        case (.setDefault, .moveAll): return String(localized: "Switch all chats")
        case (.setDefault, .keepChats): return String(localized: "Only new chats")
        case (.setDefault, .only): return String(localized: "Make default")
        case (.logOut, .moveAll): return String(localized: "Log out and switch all chats")
        case (.logOut, .keepChats): return String(localized: "Log out, keep chats here")
        case (.logOut, .only): return String(localized: "Log out")
        }
    }

    /// Making `provider` the default.
    static func setDefault(_ provider: DefaultModelProvider, state: AIToolsStatus.DefaultState?) -> AIDefaultDialog {
        let asks = (state?.followingChats ?? 0) > 0
        return AIDefaultDialog(
            subject: .setDefault(provider),
            title: String(localized: "Make \(provider.name) the default?"),
            message: String(localized: "New chats use \(provider.name)."),
            choices: asks ? [.moveAll, .keepChats] : [.only(destructive: false)]
        )
    }

    /// Logging out of `account`, as the web words it: the other account takes
    /// the default, an expired one too; with none, Rome credits when they can
    /// run; otherwise the chats pause.
    static func logOut(_ account: AIAccount, state: AIToolsStatus.DefaultState?, otherExpired: Bool) -> AIDefaultDialog {
        let leaving = account.provider
        let other: AIAccount = account == .chatgpt ? .claude : .chatgpt
        let title = String(localized: "Log out of \(account.name)?")
        guard let state else {
            return AIDefaultDialog(subject: .logOut(account), title: title, message: String(localized: "Logs out on this server only."), choices: [.only(destructive: true)])
        }
        let otherIn = other.provider == .anthropic ? state.signedIn?.anthropic == true : state.signedIn?.openai == true
        let moves = state.provider == leaving
        let asks: [Choice] = (state.followingChats ?? 0) > 0 ? [.moveAll, .keepChats] : [.only(destructive: false)]
        if otherIn, !moves {
            return AIDefaultDialog(subject: .logOut(account), title: title, message: String(localized: "Chats on \(account.name) will ask you to log in again."), choices: [.only(destructive: false)])
        }
        if moves, otherIn {
            var message = String(localized: "\(other.name) becomes the default.")
            if otherExpired { message += " " + String(localized: "Its login has expired: log in to \(other.name) again after you log out.") }
            return AIDefaultDialog(subject: .logOut(account), title: title, message: message, choices: asks)
        }
        if moves, state.romeCreditsUsable == true {
            return AIDefaultDialog(subject: .logOut(account), title: title, message: String(localized: "Rome credits become the default."), choices: asks)
        }
        return AIDefaultDialog(subject: .logOut(account), title: title, message: String(localized: "Chats pause until you log in again."), choices: [.only(destructive: true)])
    }
}

/// The guardian's AI accounts and default model, read for Settings, the AI
/// model page and Chat's connect card. One per workspace.
@MainActor
@Observable
final class AIModelStore {
    private let backend: RomeBackend
    private(set) var status: AIToolsStatus?
    private(set) var showsUsage = true
    private(set) var credits: RomeCreditsResponse.Credits?
    /// The account a logout is on its way for.
    private(set) var loggingOut: AIAccount?
    /// The account whose logout failed, until the next try.
    var logoutFailed: AIAccount?

    init(backend: RomeBackend) {
        self.backend = backend
    }

    var summary: AIModelSummary {
        .of(status, showsUsage: showsUsage, credits: credits?.availableDollars)
    }

    func line(_ account: AIAccount) -> AIAccountLine {
        .of(status?.provider(account.provider), showsUsage: showsUsage)
    }

    /// Some account is logged in, so a chat can run.
    var hasLoggedInAccount: Bool {
        AIAccount.allCases.contains { status?.provider($0.provider)?.loggedIn == true }
    }

    /// Reads it all again. A failed read keeps what is shown.
    func refresh() async {
        async let usage = backend.showsAIToolUsage()
        if let read = try? await backend.aiTools() { status = read }
        showsUsage = await usage
        if showsCredits {
            credits = try? await backend.romeCredits()
        }
    }

    /// Rome credits have a row: while they are the default, or while the
    /// server says they could be (usable, and no account signed in, an
    /// expired one included).
    var showsCredits: Bool {
        let state = status?.defaultProvider
        if state?.provider == .romeCredits { return true }
        return Self.creditsEligible(state)
    }

    /// Whether Rome credits can become the default, as the server decides:
    /// usable, and signed in as a provider, which they are only while no
    /// account is (an expired login still counts as one).
    nonisolated static func creditsEligible(_ state: AIToolsStatus.DefaultState?) -> Bool {
        guard let state, state.romeCreditsUsable == true else { return false }
        if let credits = state.signedIn?.romeCredits { return credits }
        // A server that does not say: no account signed in, expired or not.
        return state.signedIn?.anthropic != true && state.signedIn?.openai != true
    }

    /// Something runs Chat: an account is logged in, or Rome credits are the default.
    var runsChats: Bool { hasLoggedInAccount || defaultProvider == .romeCredits }

    /// The default as the server reads it; nil before it has one.
    var defaultProvider: DefaultModelProvider? { status?.defaultProvider?.provider }

    /// A logged-in account that is not the default can be made it.
    func offersDefault(_ account: AIAccount) -> Bool {
        status?.provider(account.provider)?.loggedIn == true && defaultProvider != nil && defaultProvider != account.provider
    }

    /// The dialog a tap on Set as default, or on Log out, opens.
    func setDefaultDialog(_ provider: DefaultModelProvider) -> AIDefaultDialog {
        .setDefault(provider, state: status?.defaultProvider)
    }

    func logOutDialog(_ account: AIAccount) -> AIDefaultDialog {
        let other: AIAccount = account == .chatgpt ? .claude : .chatgpt
        return .logOut(account, state: status?.defaultProvider, otherExpired: status?.provider(other.provider)?.needsReauth == true)
    }

    /// The provider a change of the default is on its way for.
    private(set) var settingDefault: DefaultModelProvider?
    /// Set when the last change of the default failed, until the next try.
    var setDefaultFailed = false

    /// Makes `provider` the default, then reads the status again.
    func setDefault(_ provider: DefaultModelProvider, moveExisting: Bool) async {
        settingDefault = provider
        setDefaultFailed = false
        do {
            try await backend.setDefaultProvider(provider, moveExisting: moveExisting)
        } catch {
            setDefaultFailed = true
        }
        await refresh()
        settingDefault = nil
    }

    /// A login's own read: what it saw becomes what Settings shows.
    func update(_ read: AIToolsStatus) {
        guard var status else {
            status = read
            return
        }
        status.claude = read.claude ?? status.claude
        status.codex = read.codex ?? status.codex
        if let state = read.defaultProvider { status.defaultProvider = state }
        self.status = status
    }

    /// Logs out of `account`, then reads the status again: the default may move.
    func logOut(_ account: AIAccount, moveExisting: Bool = true) async {
        loggingOut = account
        logoutFailed = nil
        do {
            try await backend.logOut(account, moveExisting: moveExisting)
        } catch {
            logoutFailed = account
        }
        await refresh()
        loggingOut = nil
    }
}

/// Settings' one AI Tools row: the default model and its state; it opens
/// the AI Tools page. With nothing set up, it offers [Connect] too.
struct AIModelRow: View {
    let summary: AIModelSummary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .romeFont(15)
                    .foregroundStyle(Palette.fg)
                    .frame(width: 30, height: 30)
                    .background(Palette.secondaryFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("AI Tools").romeFont(17).foregroundStyle(Palette.fg)
                    if summary != .loading {
                        Text(verbatim: summary.text)
                            .romeFont(13)
                            .foregroundStyle(summary.tone.color)
                            // One line: a long state loses its tail, never wraps.
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: 8)
                if summary.offersConnect {
                    // The same page as the row: the guardian connects there.
                    Text("Connect")
                        .romeFont(CardScale.actionFont, .semibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(height: CardScale.actionHeight)
                        .background(Palette.primary, in: Capsule())
                } else {
                    Image(systemName: "chevron.right")
                        .romeFont(13, .semibold)
                        .foregroundStyle(Palette.sub)
                }
            }
            .frame(minHeight: 60)
            .padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("AI Tools")
        .accessibilityValue(Text(verbatim: summary.text))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("ai-model-row")
    }
}

/// Settings → AI Tools: one list of what chats can run on, each account with
/// its login and the default tagged, and Set as default on the others. Rome
/// credits show while they are the default, or while no account is logged in
/// and they could run chats.
struct AIModelScreen: View {
    let store: AIModelStore
    let backend: RomeBackend
    @State private var login: AIAccount?
    @State private var dialog: AIDefaultDialog?
    #if DEBUG
    /// Snapshot runs only: the dialog the page opens as it shows.
    static var debugDialog: ((AIModelStore) -> AIDefaultDialog)?
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                // No default: why the guardian is here.
                if store.summary == .notSetUp {
                    Text("Log in to an account so Chat can reply.")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                }
                SettingsGroup {
                    if store.showsCredits {
                        let onCredits = store.defaultProvider == .romeCredits
                        AIAccountRow(
                            id: "rome-credits",
                            mark: Image(systemName: "dollarsign.circle"),
                            name: DefaultModelProvider.romeCredits.name,
                            line: AIAccountLine(text: store.creditsLine, tone: .plain, action: .none),
                            isDefault: onCredits,
                            busy: store.settingDefault == .romeCredits,
                            last: false,
                            defaultLabel: onCredits ? nil : "Use Rome credits",
                            onLogIn: {},
                            onLogOut: {},
                            onSetDefault: { dialog = store.setDefaultDialog(.romeCredits) }
                        )
                    }
                    ForEach(Array(AIAccount.allCases.enumerated()), id: \.element) { index, account in
                        AIAccountRow(
                            id: account.rawValue,
                            mark: Image(account == .chatgpt ? "ChatGPTMark" : "ClaudeMark"),
                            name: account.name,
                            line: store.line(account),
                            isDefault: store.summaryProvider == account.provider,
                            busy: store.loggingOut == account || store.settingDefault == account.provider,
                            last: index == AIAccount.allCases.count - 1,
                            defaultLabel: store.offersDefault(account) ? "Set as default" : nil,
                            onLogIn: { login = account },
                            onLogOut: { dialog = store.logOutDialog(account) },
                            onSetDefault: { dialog = store.setDefaultDialog(account.provider) }
                        )
                    }
                }
                if store.summaryProvider != nil {
                    Text("The default runs new chats and the chats that follow it.")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                }
                if store.setDefaultFailed {
                    Text("Could not change the default")
                        .romeFont(13)
                        .foregroundStyle(Palette.destructive)
                        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                }
                if let failed = store.logoutFailed {
                    Text(verbatim: String(localized: "Could not log out of \(failed.name)"))
                        .romeFont(13)
                        .foregroundStyle(Palette.destructive)
                        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "AI Tools", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.refresh() }
        #if DEBUG
        // Snapshot runs only: Mac Catalyst cannot capture an alert, so the
        // dialog shows in a stand-in with the same title, message and actions.
        .overlay {
            if let make = Self.debugDialog, store.status != nil {
                DialogStandIn(dialog: make(store))
            }
        }
        #endif
        .sheet(item: $login) { account in
            AILoginSheet(account: account, backend: backend) { read in
                store.update(read)
                Task { await store.refresh() }
            }
        }
        // An alert, as Sign out has: an action sheet opens as a popover on a
        // wide screen and drops Cancel. Its actions stack, the first the default.
        .alert(
            Text(verbatim: dialog?.title ?? ""),
            isPresented: Binding(get: { dialog != nil }, set: { if !$0 { dialog = nil } }),
            presenting: dialog
        ) { dialog in
            ForEach(dialog.choices, id: \.self) { choice in
                Button(role: choice == .only(destructive: true) ? .destructive : nil) {
                    run(dialog, choice)
                } label: {
                    Text(verbatim: dialog.label(choice))
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { dialog in
            Text(verbatim: dialog.message)
        }
    }

    private func run(_ dialog: AIDefaultDialog, _ choice: AIDefaultDialog.Choice) {
        Task {
            switch dialog.subject {
            case .setDefault(let provider): await store.setDefault(provider, moveExisting: choice.moveExisting)
            case .logOut(let account): await store.logOut(account, moveExisting: choice.moveExisting)
            }
        }
    }
}

extension AIModelStore {
    /// The provider the summary names, for a server that has set no default yet.
    var summaryProvider: DefaultModelProvider? {
        switch summary {
        case .ready(let provider, _), .paused(let provider, _), .needsLogin(let provider, _): return provider
        case .credits: return .romeCredits
        case .loading, .notSetUp: return nil
        }
    }

    /// The Rome credits row's line: what is left, when it is known.
    var creditsLine: String {
        credits?.availableDollars.map { String(localized: "\(AIUsageText.dollars($0)) left") } ?? String(localized: "In use")
    }
}

#if DEBUG
/// A system alert drawn for snapshot runs: title, message, stacked actions.
private struct DialogStandIn: View {
    let dialog: AIDefaultDialog

    var body: some View {
        ZStack {
            Color.black.opacity(0.3).ignoresSafeArea()
            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    Text(verbatim: dialog.title).romeFont(17, .semibold)
                    Text(verbatim: dialog.message).romeFont(13)
                }
                .multilineTextAlignment(.center)
                .foregroundStyle(Palette.fg)
                .padding(16)
                ForEach(dialog.choices, id: \.self) { choice in
                    Divider()
                    Text(verbatim: dialog.label(choice))
                        .romeFont(17)
                        .foregroundStyle(choice == .only(destructive: true) ? Palette.destructive : Palette.primary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                Divider()
                Text("Cancel").romeFont(17, .semibold).foregroundStyle(Palette.primary).frame(maxWidth: .infinity, minHeight: 44)
            }
            .frame(width: 270)
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}
#endif

/// One row of the AI Tools page: an account with its state and Log in or
/// Log out, or Rome credits while they are the default.
struct AIAccountRow: View {
    let id: String
    let mark: Image
    let name: String
    let line: AIAccountLine
    let isDefault: Bool
    let busy: Bool
    let last: Bool
    /// "Set as default" or "Use Rome credits", when the row can become the default.
    var defaultLabel: LocalizedStringKey? = nil
    let onLogIn: () -> Void
    let onLogOut: () -> Void
    var onSetDefault: () -> Void = {}

    var body: some View {
        HStack(spacing: 12) {
            // The brand marks the web shows, as template images.
            mark
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 17, height: 17)
                .foregroundStyle(Palette.fg)
                .frame(width: 30, height: 30)
                .accessibilityHidden(true)
                .background(Palette.secondaryFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: name).romeFont(17).foregroundStyle(Palette.fg)
                        if isDefault {
                            Text("Default")
                                .romeFont(11, .semibold)
                                .foregroundStyle(Palette.sub)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Palette.secondaryFill, in: Capsule())
                        }
                    }
                    Text(verbatim: line.text)
                        .romeFont(13)
                        .foregroundStyle(line.tone.color)
                        .fixedSize(horizontal: false, vertical: true)
                    // Beside Log out the row has no room for a second capsule.
                    if let defaultLabel, line.action != .none {
                        Button(action: onSetDefault) {
                            Text(defaultLabel)
                                .romeFont(13, .medium)
                                .foregroundStyle(Palette.primary)
                                .frame(minHeight: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .accessibilityIdentifier("ai-set-default-\(id)")
                    }
                }
                Spacer(minLength: 8)
                if let defaultLabel, line.action == .none {
                    Button(action: onSetDefault) {
                        Group {
                            if busy { Spinner(size: 14, color: .white) } else { Text(defaultLabel) }
                        }
                        .romeFont(CardScale.actionFont, .semibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(height: CardScale.actionHeight)
                        .background(Palette.primary, in: Capsule())
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(busy)
                    .accessibilityIdentifier("ai-set-default-\(id)")
                }
                switch line.action {
                case .logIn:
                    logInButton
                case .logOut:
                    logOutButton
                case .logInOrOut:
                    // Log out the same way as a signed-in account; Log in leads.
                    HStack(spacing: 8) {
                        logOutButton
                        logInButton
                    }
                case .none:
                    EmptyView()
                }
            }
            .padding(.vertical, 12)
            .frame(minHeight: 60)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
        }
        .padding(.horizontal, 14)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ai-account-\(id)")
    }

    private var logInButton: some View {
        Button(action: onLogIn) {
            Text("Log in")
                .romeFont(CardScale.actionFont, .semibold)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(height: CardScale.actionHeight)
                .background(Palette.primary, in: Capsule())
        }
        .buttonStyle(PressScaleStyle())
    }

    private var logOutButton: some View {
        Button(action: onLogOut) {
            Group {
                if busy { Spinner(size: 14, color: Palette.sub) } else { Text("Log out") }
            }
            .romeFont(CardScale.actionFont, .medium)
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 14)
            .frame(height: CardScale.actionHeight)
            .background(Palette.secondaryFill, in: Capsule())
        }
        .buttonStyle(PressScaleStyle())
        .disabled(busy)
    }
}

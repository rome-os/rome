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
/// AI model page.
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

/// What Settings' AI model row says: the default model, and whether chats
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

/// What an account's row on the AI model page says, and the button it offers.
struct AIAccountLine: Equatable {
    enum Action: Equatable { case logIn, logOut, none }

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
            return AIAccountLine(text: String(localized: "Login expired"), tone: .danger, action: .logIn)
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
        if status?.defaultProvider?.provider == .romeCredits {
            credits = try? await backend.romeCredits()
        }
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
    func logOut(_ account: AIAccount) async {
        loggingOut = account
        logoutFailed = nil
        do {
            try await backend.logOut(account)
        } catch {
            logoutFailed = account
        }
        await refresh()
        loggingOut = nil
    }
}

/// Settings' one AI model row: the default model and its state; it opens
/// the AI model page. With nothing set up, it offers [Connect] too.
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
                    Text("AI model").romeFont(17).foregroundStyle(Palette.fg)
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
        .accessibilityLabel("AI model")
        .accessibilityValue(Text(verbatim: summary.text))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("ai-model-row")
    }
}

/// Settings → AI model: one list of what chats can run on, each account with
/// its login and the default tagged. Rome credits show only while they are
/// the default; choosing them, or another default, comes later.
struct AIModelScreen: View {
    let store: AIModelStore
    let backend: RomeBackend
    /// A login sheet to open as the page shows, for a card's Log in.
    var opening: AIAccount? = nil
    @State private var login: AIAccount?
    @State private var confirmLogout: AIAccount?

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
                    let onCredits = store.summaryProvider == .romeCredits
                    if onCredits {
                        AIAccountRow(
                            id: "rome-credits",
                            mark: Image(systemName: "dollarsign.circle"),
                            name: DefaultModelProvider.romeCredits.name,
                            line: AIAccountLine(text: store.creditsLine, tone: .plain, action: .none),
                            isDefault: true,
                            busy: false,
                            last: false,
                            onLogIn: {},
                            onLogOut: {}
                        )
                    }
                    ForEach(Array(AIAccount.allCases.enumerated()), id: \.element) { index, account in
                        AIAccountRow(
                            id: account.rawValue,
                            mark: Image(account == .chatgpt ? "ChatGPTMark" : "ClaudeMark"),
                            name: account.name,
                            line: store.line(account),
                            isDefault: store.summaryProvider == account.provider,
                            busy: store.loggingOut == account,
                            last: index == AIAccount.allCases.count - 1,
                            onLogIn: { login = account },
                            onLogOut: { confirmLogout = account }
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
        .floatingTopBar { PageHeader(title: "AI model", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.refresh() }
        .onAppear { if let opening, login == nil { login = opening } }
        .sheet(item: $login) { account in
            AILoginSheet(account: account, backend: backend) { read in
                store.update(read)
                Task { await store.refresh() }
            }
        }
        // An alert, as Sign out has: an action sheet opens as a popover and drops Cancel.
        .alert(
            Text(verbatim: confirmLogout.map { String(localized: "Log out of \($0.name)?") } ?? ""),
            isPresented: Binding(get: { confirmLogout != nil }, set: { if !$0 { confirmLogout = nil } }),
            presenting: confirmLogout
        ) { account in
            Button("Log out", role: .destructive) { Task { await store.logOut(account) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Logs out on this server only.")
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

/// One row of the AI model page: an account with its state and Log in or
/// Log out, or Rome credits while they are the default.
struct AIAccountRow: View {
    let id: String
    let mark: Image
    let name: String
    let line: AIAccountLine
    let isDefault: Bool
    let busy: Bool
    let last: Bool
    let onLogIn: () -> Void
    let onLogOut: () -> Void

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
                }
                Spacer(minLength: 8)
                switch line.action {
                case .logIn:
                    Button(action: onLogIn) {
                        Text("Log in")
                            .romeFont(CardScale.actionFont, .semibold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .frame(height: CardScale.actionHeight)
                            .background(Palette.primary, in: Capsule())
                    }
                    .buttonStyle(PressScaleStyle())
                case .logOut:
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
}

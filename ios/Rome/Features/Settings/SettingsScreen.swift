import SwiftUI

/// A page's header, as the chats have it: one row with a plain title in
/// the middle, a glass button at the left (Back on a pushed page, the drawer
/// on a drawer page) and the close button at the right on a sheet's first
/// page. It floats over the scroll (`floatingTopBar`), which fades under it.
struct PageHeader: View {
    let title: LocalizedStringKey
    var onClose: (() -> Void)? = nil
    /// A drawer page shows the drawer button where a pushed page has Back.
    var onMenu: (() -> Void)? = nil
    /// Pages in a sheet keep their buttons clear of its round top corners.
    var inSheet = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack {
            if let onMenu {
                GlassCircleButton(accessibilityLabel: "Open navigation", action: onMenu) {
                    MenuGlyph()
                }
            } else if onClose == nil {
                GlassCircleButton(accessibilityLabel: "Back", action: { dismiss() }) {
                    Image(systemName: "chevron.left").romeFont(17, .semibold)
                }
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
            PlainHeaderTitle(title: Text(title))
            if let onClose {
                GlassCircleButton(accessibilityLabel: "Close", action: onClose) {
                    Image(systemName: "xmark").romeFont(16, .semibold)
                }
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, inSheet ? 16 : 12)
        .padding(.top, inSheet ? 12 : 4)
        .padding(.bottom, 4)
        .headerFade()
    }
}

/// The app's languages, each named in its own language, as iOS's picker shows them.
enum AppLanguage {
    /// `preferredLocalizations.first`: the language iOS resolved for the app.
    static func name(_ localization: String?) -> String {
        switch localization {
        case let code? where code.hasPrefix("zh"): return "简体中文"
        default: return "English"
        }
    }
}

/// An inset group: a white rounded card with hairline rows.
struct SettingsGroup<Content: View>: View {
    var header: LocalizedStringKey? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header {
                // At the card's edge, like every section title.
                Text(header)
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.sub)
            }
            VStack(spacing: 0, content: content)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
        }
    }
}

/// A row with a 30 pt icon tile, a label, and a trailing accessory.
struct SettingsRow<Trailing: View>: View {
    let systemImage: String
    let title: LocalizedStringKey
    var last = false
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .romeFont(15)
                .foregroundStyle(Palette.fg)
                .frame(width: 30, height: 30)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack {
                Text(title).romeFont(17).foregroundStyle(Palette.fg)
                Spacer(minLength: 8)
                trailing()
            }
            .frame(minHeight: 52)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 14)
        .contentShape(Rectangle())
    }
}

/// Board 3: account, AI tool usage, links, sign out.
struct SettingsScreen: View {
    let workspace: Workspace
    let onInstances: () -> Void
    let onClose: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var usage: AIToolsStatus?
    @State private var confirmSignOut = false
    @State private var showFeedback = false
    @State private var notificationsOn = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                accountCard
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                // The guardian's own subscriptions: not a visitor's to see.
                if !workspace.isVisitor {
                    SettingsGroup(header: "AI tool usage") {
                        UsageRow(name: "Claude", provider: usage?.claude, last: false)
                        UsageRow(name: "Codex", provider: usage?.codex, last: true)
                    }
                    .padding(.horizontal, 16)
                }
                SettingsGroup(header: "Other") {
                    SettingsRow(systemImage: "circle.lefthalf.filled", title: "Appearance") {
                        Menu {
                            Picker("Appearance", selection: Binding(get: { model.appearance.current }, set: { model.appearance.set($0) })) {
                                ForEach(Appearance.allCases) { option in
                                    Text(option.title).tag(option)
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(model.appearance.current.title)
                                    .romeFont(17)
                                    .foregroundStyle(Palette.sub)
                                Image(systemName: "chevron.up.chevron.down")
                                    .romeFont(12, .semibold)
                                    .foregroundStyle(Palette.sub)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Appearance")
                        .accessibilityValue(Text(model.appearance.current.title))
                    }
                    // iOS keeps the app's language: its own picker, in the app's
                    // page in Settings, relaunches the app when it changes.
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    } label: {
                        SettingsRow(systemImage: "globe", title: "Language") {
                            HStack(spacing: 6) {
                                Text(verbatim: AppLanguage.name(Bundle.main.preferredLocalizations.first))
                                    .romeFont(17)
                                    .foregroundStyle(Palette.sub)
                                Image(systemName: "arrow.up.right")
                                    .romeFont(13, .semibold)
                                    .foregroundStyle(Palette.sub)
                            }
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Language")
                    .accessibilityValue(Text(verbatim: AppLanguage.name(Bundle.main.preferredLocalizations.first)))
                    .accessibilityHint("Opens Settings")
                    .accessibilityAddTraits(.isButton)
                    // Pushes reach the guardian only.
                    if !workspace.isVisitor {
                        SettingsRow(systemImage: "bell", title: "Notifications") {
                            Toggle("Notifications", isOn: Binding(get: { notificationsOn }, set: setNotifications))
                                .labelsHidden()
                                .tint(Palette.primary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if !workspace.isVisitor, model.push.needsSystemSettings {
                        SystemSettingsNote {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                        .transition(.opacity)
                    }
                    Button {
                        if let url = model.webURL { openURL(url) }
                    } label: {
                        SettingsRow(systemImage: "safari", title: "Manage on the web") {
                            Image(systemName: "arrow.up.right")
                                .romeFont(13, .semibold)
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    // Feedback goes out as the guardian's.
                    if !workspace.isVisitor {
                        Button { showFeedback = true } label: {
                            SettingsRow(systemImage: "bubble.left.and.text.bubble.right", title: "Send feedback") {
                                Image(systemName: "chevron.right")
                                    .romeFont(13, .semibold)
                                    .foregroundStyle(Palette.sub)
                            }
                        }
                        .buttonStyle(RowPressStyle())
                    }
                    SettingsRow(systemImage: "info.circle", title: "Version", last: true) {
                        Text(appVersion)
                            .romeFont(17, monospacedDigits: true)
                            .foregroundStyle(Palette.sub)
                    }
                }
                .padding(.horizontal, 16)
                if model.update.cannotCheck {
                    // Quiet: the app works as usual when the check cannot decide.
                    Text("Can't check for updates")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .padding(.horizontal, 32)
                        .padding(.top, -18)
                }
                SettingsGroup {
                    Button { confirmSignOut = true } label: {
                        Text("Sign out")
                            .romeFont(17, .medium)
                            .foregroundStyle(Palette.destructive)
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
            }
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Settings", onClose: onClose, inSheet: true) }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { if !workspace.isVisitor { usage = try? await workspace.backend.aiTools() } }
        .task {
            await model.push.refresh()
            notificationsOn = model.push.isOn
        }
        // The guardian may change it in the Settings app and come back.
        .onChange(of: model.push.isOn) { _, on in notificationsOn = on }
        .animation(.easeOut(duration: 0.2), value: model.push.needsSystemSettings)
        .confirmationDialog("After signing out, sign in with Rome Cloud to open Rome again.", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        }
        .sheet(isPresented: $showFeedback) {
            FeedbackSheet(backend: workspace.backend)
                .presentationDetents([.medium])
                .presentationBackground(Palette.sheet)
                .presentationCornerRadius(22)
        }
    }

    private var accountCard: some View {
        Button(action: onInstances) {
            HStack(spacing: 14) {
                InitialAvatar(text: workspace.accountLabel, imageURL: workspace.avatarURL, size: 48)
                VStack(alignment: .leading, spacing: 1) {
                    Text(workspace.accountLabel)
                        .romeFont(17, .semibold)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Circle().fill(Palette.success).frame(width: 7, height: 7)
                        Text(verbatim: "\(workspace.instanceName) · \(workspace.host)").lineLimit(1)
                    }
                    .romeFont(14)
                    .foregroundStyle(Palette.sub)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .softElevation(radius: Metrics.cardRadius)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityHint("Switches instances.")
    }

    /// The switch moves at once and settles on what the system and the
    /// preference allow, so it springs back when the system says no.
    private func setNotifications(_ on: Bool) {
        notificationsOn = on
        Task {
            await model.push.setEnabled(on)
            withAnimation { notificationsOn = model.push.isOn }
        }
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }
}

/// Under the Notifications row when the system has notifications off for
/// the app: only the Settings app can turn them back on.
private struct SystemSettingsNote: View {
    let open: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text("Turn on notifications in Settings")
                .romeFont(14)
                .foregroundStyle(Palette.sub)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Open Settings", action: open)
                .romeFont(14, .semibold)
                .foregroundStyle(Palette.primaryText)
                .buttonStyle(PressScaleStyle())
        }
        .padding(.leading, 56)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
    }
}

/// One AI subscription: how much of its tightest window is used, and when it resets.
struct UsageRow: View {
    let name: String
    let provider: AIToolsStatus.Provider?
    let last: Bool

    private var window: AIToolsStatus.Window? {
        let windows = [provider?.usage?.fiveHour, provider?.usage?.sevenDay].compactMap { $0 }
        return windows.max { ($0.usedPercent ?? 0) < ($1.usedPercent ?? 0) }
    }

    private var percent: Double { min(100, max(0, window?.usedPercent ?? 0)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).romeFont(17, .medium)
                Spacer()
                if provider?.loggedIn == true, window != nil {
                    Text(verbatim: "\(Int(percent.rounded()))%")
                        .romeFont(15, .semibold, monospacedDigits: true)
                        .contentTransition(.numericText())
                }
            }
            if provider?.loggedIn == true {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.fill)
                        Capsule()
                            .fill(percent >= 100 || provider?.quotaExhausted == true ? Palette.destructive : Palette.fg)
                            .frame(width: geometry.size.width * percent / 100)
                    }
                }
                .frame(height: 6)
                .accessibilityElement()
                .accessibilityLabel("\(name) usage")
                .accessibilityValue(Text(verbatim: "\(Int(percent))%"))
                Text(resetText)
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
            } else {
                Text(provider == nil ? "Loading…" : "Not signed in")
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.85), value: percent)
    }

    private var resetText: String {
        guard let date = RomeDate.parse(window?.resetsAt) else {
            return window == nil ? String(localized: "No usage data yet") : String(localized: "Usage resets automatically")
        }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return String(localized: "Resets soon") }
        if seconds < 3600 { return String(localized: "Resets in \(max(1, Int(seconds / 60))) minutes") }
        if seconds < 86_400 { return String(localized: "Resets in \(Int(seconds / 3600)) hours") }
        return String(localized: "Resets in \(Int(seconds / 86_400)) days")
    }
}

struct FeedbackSheet: View {
    let backend: RomeBackend
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Send feedback").romeFont(24, .bold).tracking(-0.6)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            if sent {
                VStack(spacing: 10) {
                    StatusGlyph(tone: .done, size: 36)
                    Text("Sent. Thank you.").romeFont(17, .semibold)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity.combined(with: .scale(scale: 0.95)))
            } else {
                TextField("What works, and what does not?", text: $text, axis: .vertical)
                    .romeFont(16)
                    .lineLimit(5...10)
                    .focused($focused)
                    .padding(14)
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .hairline(radius: 16)
                if failed {
                    Text("Could not send. Please try again.")
                        .romeFont(13, .medium)
                        .foregroundStyle(Palette.destructive)
                }
                Spacer()
                PrimaryButton(title: "Send", loading: sending, disabled: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    send()
                }
            }
        }
        .padding(20)
        .onAppear { focused = true }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: sent)
    }

    private func send() {
        sending = true
        failed = false
        Task {
            do {
                try await backend.sendFeedback(text.trimmingCharacters(in: .whitespacesAndNewlines))
                sent = true
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            } catch {
                failed = true
            }
            sending = false
        }
    }
}

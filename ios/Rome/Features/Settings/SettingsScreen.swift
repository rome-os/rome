import SwiftUI

/// A page's top and a large title: a glass back button on a pushed page, or a
/// close button at the right on the first page of a sheet.
struct PageHeader: View {
    let title: LocalizedStringKey
    var onClose: (() -> Void)? = nil
    /// Pages in a sheet keep their buttons clear of its round top corners.
    var inSheet = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let onClose {
                    Spacer()
                    GlassCircleButton(accessibilityLabel: "Close", action: onClose) {
                        Image(systemName: "xmark").romeFont(16, .semibold)
                    }
                } else {
                    GlassCircleButton(accessibilityLabel: "Back", action: { dismiss() }) {
                        Image(systemName: "chevron.left").romeFont(17, .semibold)
                    }
                }
            }
            .padding(.horizontal, inSheet ? 16 : 12)
            .padding(.top, inSheet ? 16 : 4)
            Text(title)
                .romeFont(34, .bold)
                .tracking(-0.8)
                .padding(.horizontal, 20)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An inset group: a white rounded card with hairline rows.
struct SettingsGroup<Content: View>: View {
    var header: LocalizedStringKey? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header {
                Text(header)
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 20)
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                PageHeader(title: "Settings", onClose: onClose, inSheet: true)
                accountCard
                    .padding(.horizontal, 16)
                    .padding(.top, -8)
                SettingsGroup(header: "AI tool usage") {
                    UsageRow(name: "Claude", provider: usage?.claude, last: false)
                    UsageRow(name: "Codex", provider: usage?.codex, last: true)
                }
                .padding(.horizontal, 16)
                SettingsGroup(header: "Other") {
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
                    Button { showFeedback = true } label: {
                        SettingsRow(systemImage: "bubble.left.and.text.bubble.right", title: "Send feedback") {
                            Image(systemName: "chevron.right")
                                .romeFont(13, .semibold)
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    SettingsRow(systemImage: "info.circle", title: "Version", last: true) {
                        Text(appVersion)
                            .romeFont(17, monospacedDigits: true)
                            .foregroundStyle(Palette.sub)
                    }
                }
                .padding(.horizontal, 16)
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
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { usage = try? await workspace.backend.aiTools() }
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
                InitialAvatar(text: workspace.accountLabel, size: 48)
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

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
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

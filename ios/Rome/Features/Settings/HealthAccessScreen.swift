import SwiftUI

/// What the Apple Health row in Settings shows on its right.
struct HealthRowState: Equatable {
    let status: HealthSyncStatus

    var value: String {
        switch status {
        case .off: return String(localized: "Off")
        case .paused: return String(localized: "Paused")
        case .needsSignIn: return String(localized: "Needs sign-in")
        default: return String(localized: "On")
        }
    }
}

/// The line under Sync with Rome, and the button it offers.
struct HealthStatusLine: Equatable {
    enum Action: Equatable { case signIn, retry }

    let text: String?
    let action: Action?
    let failed: Bool

    init(_ status: HealthSyncStatus, device: DeviceKind = .iPhone, now: Date = Date(), locale: Locale = .current) {
        switch status {
        case .off:
            text = nil; action = nil; failed = false
        case .paused:
            text = String(localized: "Paused"); action = nil; failed = false
        case .waiting:
            text = String(localized: "Not synced yet"); action = nil; failed = false
        case .syncing:
            text = String(localized: "Syncing…"); action = nil; failed = false
        case .syncingHistory(let month):
            let name = month.formatted(Date.FormatStyle(locale: locale).month(.abbreviated).year())
            text = String(localized: "Syncing history · \(name)"); action = nil; failed = false
        case .synced(let date):
            text = String(localized: "Synced \(Self.ago(date, now: now, locale: locale))"); action = nil; failed = false
        case .locked:
            text = String(localized: "Can't sync while \(device.name) is locked"); action = nil; failed = false
        case .needsSignIn:
            text = String(localized: "Sign in again to keep Health syncing"); action = .signIn; failed = true
        case .needsUpdate:
            text = String(localized: "Your Rome needs an update to sync Health"); action = nil; failed = true
        case .failed:
            text = String(localized: "Last sync failed"); action = .retry; failed = true
        }
    }

    /// "12 min ago", "just now".
    static func ago(_ date: Date, now: Date, locale: Locale) -> String {
        if now.timeIntervalSince(date) < 60 { return String(localized: "just now") }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// Settings → Apple Health: Sync with Rome, which keeps the Health data the
/// guardian allows up to date on their Rome, and what that means. Health data
/// goes to the Rome and the AI model behind it, so the page says what is
/// read, for what, and where it goes.
struct HealthAccessScreen: View {
    static let privacyURL = URL(string: "https://romeos.cc/privacy")!

    let onHistory: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        let health = model.health
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    header
                    toggleCard(health)
                    capabilities
                    dataFlow
                    Button { openURL(Self.privacyURL) } label: {
                        Text("Privacy Policy")
                            .romeFont(16, .medium)
                            .foregroundStyle(Palette.primaryText)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .softTopScrollEdge()
            #if DEBUG
            // The snapshot runner reads a long page in parts.
            .onChange(of: model.debugHealthScroll) { _, id in
                if let id { proxy.scrollTo(id, anchor: id == "end" ? .bottom : .top) }
            }
            #endif
        }
        .floatingTopBar { PageHeader(title: "", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
    }

    // MARK: Pieces

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "heart.fill")
                .font(.system(size: 56))
                .foregroundStyle(Palette.healthPink)
                .accessibilityHidden(true)
            Text("Apple Health")
                .romeFont(28, .bold)
                .tracking(-0.6)
                .foregroundStyle(Palette.fg)
            Text("Your Rome can use your health data to plan and explain things for you.")
                .romeFont(16)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private func toggleCard(_ health: HealthSettings) -> some View {
        let line = HealthStatusLine(health.status, device: model.node.device)
        return VStack(alignment: .leading, spacing: 8) {
            SettingsGroup {
                HStack(spacing: 12) {
                    Text("Sync with Rome").romeFont(17).foregroundStyle(Palette.fg)
                    Spacer(minLength: 8)
                    Toggle("Sync with Rome", isOn: Binding(get: { health.isEnabled }, set: { on in health.setEnabled(on) }))
                        .labelsHidden()
                        .tint(Palette.primary)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                .accessibilityElement(children: .combine)
                Button(action: onHistory) {
                    HStack(spacing: 12) {
                        Text("Sync history").romeFont(17).foregroundStyle(Palette.fg)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .romeFont(13, .semibold)
                            .foregroundStyle(Palette.sub)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
            }
            if health.showsMigrationNote {
                NoteLine(text: String(localized: "Health now syncs to your Rome. Turn on Sync to keep using it."))
            } else if let text = line.text {
                HealthStatusRow(line: line, text: text)
            }
            if health.isEnabled, health.backgroundRefreshOff {
                NoteLine(text: String(localized: "Turn on Background App Refresh so Health stays up to date"))
            }
        }
    }

    private var capabilities: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsGroup(header: "What your Rome can do") {
                CapabilityRow(
                    symbol: "figure.run", title: "Plan fat-loss workouts",
                    request: String(localized: "Plan my workouts so I lose 3 kg by March."),
                    reply: String(localized: "I looked at your steps, workouts, resting heart rate and weight. Here's a 12-week plan.")
                )
                CapabilityRow(
                    symbol: "bed.double", title: "Understand your sleep",
                    request: String(localized: "Why have I felt so tired lately?"),
                    reply: String(localized: "Your deep sleep dropped over the last two weeks, and your HRV fell with it.")
                )
                CapabilityRow(
                    symbol: "waveform.path.ecg", title: "Notice heart trends",
                    request: String(localized: "Has my resting heart rate changed this month?"),
                    reply: String(localized: "It's 4 bpm higher than last month, mostly on days you slept under 6 hours."), last: true
                )
            }
            Text("For everyday wellness, not medical advice.")
                .romeFont(13)
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 16)
        }
    }

    private var dataFlow: some View {
        SettingsGroup(header: "Where your data goes") {
            HStack(alignment: .top, spacing: 4) {
                FlowNode(symbol: model.node.device.symbol, label: model.node.device.thisDevice)
                FlowArrow()
                FlowNode(symbol: "server.rack", label: "Your Rome")
                FlowArrow()
                FlowNode(symbol: "sparkle", label: "Your AI model provider")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(model.node.device.dataFlowLabel)
            Promise(text: "Kept up to date on your Rome. Read only, never changed.")
            Promise(text: "Rome never sells it, uses it for ads, or uses it to train AI models. Your AI provider's terms apply to what it receives.")
            Promise(text: "You can delete what was sent.")
            Promise(text: "Results can stay in your Rome's chats and memory.", last: true)
        }
        .id("where")
    }
}

/// The sync's status under the switch, with Sign in or Retry when it needs one.
struct HealthStatusRow: View {
    let line: HealthStatusLine
    let text: String
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            Text(verbatim: text)
                .romeFont(13)
                .foregroundStyle(line.failed ? Palette.destructive : Palette.sub)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            switch line.action {
            case .signIn?:
                Button("Sign in") { Task { await model.reauthenticate() } }
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.primaryText)
                    .buttonStyle(PressScaleStyle())
            case .retry?:
                Button("Retry") { model.health.syncNow() }
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.primaryText)
                    .buttonStyle(PressScaleStyle())
            case nil:
                EmptyView()
            }
        }
        .padding(.horizontal, 16)
    }
}

/// One quiet line under a card.
struct NoteLine: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16)
    }
}

/// One thing the Rome can do with Health, as a short chat: the request in the
/// guardian's bubble and the Rome's answer in its own, both the real chat's.
private struct CapabilityRow: View {
    let symbol: String
    let title: LocalizedStringKey
    let request: String
    let reply: String
    var last = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .romeFont(20)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 30, alignment: .center)
                    .accessibilityHidden(true)
                Text(title).romeFont(16, .semibold).foregroundStyle(Palette.fg)
                Spacer(minLength: 0)
            }
            VStack(spacing: 8) {
                UserBubble(text: request, pending: nil)
                AgentBubble(text: reply, forwardedFrom: nil, position: .single)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A stop on the way the data takes: a symbol over a label that wraps rather than cuts.
private struct FlowNode: View {
    let symbol: String
    let label: LocalizedStringKey

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .romeFont(26)
                .foregroundStyle(Palette.fg)
                .frame(height: 32)
            Text(label)
                .romeFont(12)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

private struct FlowArrow: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .romeFont(12, .semibold)
            .foregroundStyle(Palette.sub.opacity(0.45))
            .frame(height: 32)
            .accessibilityHidden(true)
    }
}

/// One commitment, with a check.
private struct Promise: View {
    let text: LocalizedStringKey
    var last = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "checkmark")
                .romeFont(14, .bold)
                .foregroundStyle(Palette.primary)
                .frame(width: 22)
                .accessibilityHidden(true)
            Text(text)
                .romeFont(15)
                .foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
        .accessibilityElement(children: .combine)
    }
}

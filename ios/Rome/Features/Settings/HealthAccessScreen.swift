import SwiftUI

/// What the Apple Health row in Settings shows on its right.
struct HealthRowState: Equatable {
    let status: HealthSyncStatus

    var value: String {
        switch status {
        case .off: return String(localized: "Off")
        case .needsSignIn: return String(localized: "Needs sign-in")
        default: return String(localized: "On")
        }
    }
}

/// The line under Sync with Rome, and the text button at its end: Sync
/// now while all is well, Retry or Sign in when a sync failed.
struct HealthStatusLine: Equatable {
    enum Action: Equatable { case syncNow, signIn, retry }

    let text: String?
    let action: Action?
    let failed: Bool

    /// `rome`: the open Rome's name, which the line says it syncs to.
    init(_ status: HealthSyncStatus, rome: String? = nil, device: DeviceKind = .iPhone, now: Date = Date(), locale: Locale = .current) {
        func to(_ text: String) -> String { rome.map { String(localized: "\(text) · to \($0)") } ?? text }
        switch status {
        case .off:
            text = nil; action = nil; failed = false
        case .waiting:
            text = to(String(localized: "Not synced yet")); action = .syncNow; failed = false
        case .syncing:
            text = String(localized: "Syncing…"); action = nil; failed = false
        case .syncingHistory(let month):
            let name = month.formatted(Date.FormatStyle(locale: locale).month(.abbreviated))
            text = String(localized: "Syncing history · \(name)"); action = nil; failed = false
        case .synced(let date):
            text = to(String(localized: "Synced \(Self.ago(date, now: now, locale: locale))")); action = .syncNow; failed = false
        case .locked:
            text = String(localized: "Can't sync while \(device.name) is locked"); action = nil; failed = false
        case .needsSignIn:
            text = String(localized: "Sign in again to keep Health syncing"); action = .signIn; failed = true
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

/// Settings → Apple Health: Sync with Rome, how it stands, what Rome
/// promises about the data, its history, and what Rome can do with it.
struct HealthAccessScreen: View {
    let onHistory: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let health = model.health
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    header
                    toggleCard(health)
                    capabilities
                        .id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .softTopScrollEdge()
            #if DEBUG
            // The snapshot runner reads the page's end too.
            .onChange(of: model.debugHealthScroll) { _, id in
                if let id { proxy.scrollTo(id, anchor: .bottom) }
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
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    /// The switch, the status line under it, and Sync history. A visitor's
    /// Rome has none: Health syncs only to a Rome the guardian owns.
    @ViewBuilder
    private func toggleCard(_ health: HealthSettings) -> some View {
        if health.instance?.isVisitor != true {
            let rome = health.instance?.name
            let line = HealthStatusLine(health.status, rome: rome, device: model.node.device)
            VStack(alignment: .leading, spacing: 8) {
                SettingsGroup {
                    PlainRow(title: "Sync with Rome") {
                        Toggle("Sync with Rome", isOn: Binding(get: { health.isEnabled }, set: { on in health.setEnabled(on) }))
                            .labelsHidden()
                            .tint(Palette.primary)
                            .disabled(!health.canSync)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let text = line.text {
                    HealthStatusRow(line: line, text: text, running: health.activity.running)
                }
                // What Rome promises about Health, in one line, with the policy behind it.
                Text("Read only · Never sold or used for ads or training · Delete anytime · [Privacy Policy](https://romeos.cc/privacy)")
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
                    .tint(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                SettingsGroup {
                    Button(action: onHistory) {
                        PlainRow(title: "Sync history") {
                            Image(systemName: "chevron.right")
                                .romeFont(13, .semibold)
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                }
                .padding(.top, 10)
            }
        }
    }

    private var capabilities: some View {
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
    }

}

/// The sync's status under the switch, with Sign in or Retry when it needs one.
struct HealthStatusRow: View {
    let line: HealthStatusLine
    let text: String
    var running = false
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: text)
                .romeFont(13)
                .foregroundStyle(line.failed ? Palette.destructive : Palette.sub)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            switch line.action {
            case .syncNow?:
                action("Sync now") { model.health.syncNow() }
                    .disabled(running)
            case .signIn?:
                action("Sign in") { Task { await model.reauthenticate() } }
            case .retry?:
                action("Retry") { model.health.syncNow() }
            case nil:
                EmptyView()
            }
        }
        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
    }

    private func action(_ title: LocalizedStringKey, perform: @escaping () -> Void) -> some View {
        Button(title, action: perform)
            .romeFont(13, .semibold)
            .foregroundStyle(Palette.primaryText)
            .buttonStyle(PressScaleStyle())
    }
}

/// A card's only row: a title and its control, no icon.
private struct PlainRow<Trailing: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Text(title).romeFont(17).foregroundStyle(Palette.fg)
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
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


import SwiftUI

/// A personal-data source's Sync with Rome, as its connection page and Sync
/// history read it: Apple Health's, or Calendar's.
@MainActor
protocol SourceSyncing: AnyObject {
    var instance: HealthInstance? { get }
    var isEnabled: Bool { get }
    var canSync: Bool { get }
    var status: HealthSyncStatus { get }
    var activity: SyncActivity { get }
    var history: [SyncLogEntry] { get }
    @discardableResult func setEnabled(_ on: Bool) -> Task<Void, Never>
    @discardableResult func syncNow() -> Task<Void, Never>
    func deleteUploaded() async -> Bool
    func reloadHistory() async
}

extension HealthSettings: SourceSyncing {}
extension CalendarSync: SourceSyncing {}

/// The line under Sync with Rome, and the text button at its end: Sync
/// now while all is well, Retry or Sign in when a sync failed.
struct HealthStatusLine: Equatable {
    enum Action: Equatable { case syncNow, signIn, retry }

    let text: String?
    let action: Action?
    let failed: Bool

    /// `rome`: the open Rome's name, which the line says it syncs to.
    init(_ status: HealthSyncStatus, rome: String? = nil, device: DeviceKind = .iPhone, isHealth: Bool = true, now: Date = Date(), locale: Locale = .current) {
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
            text = isHealth ? String(localized: "Sign in again to keep Health syncing") : String(localized: "Sign in again to keep syncing")
            action = .signIn; failed = true
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

/// A source's Sync, on its connection page: the open Rome's switch and its
/// history in one group, then one line on how it stands, and for Health a
/// second only when the data has gone stale. A visitor's Rome has none: data
/// syncs only to a Rome the guardian owns.
struct SourceSyncSection: View {
    let sync: any SourceSyncing
    let source: String
    let onHistory: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        if sync.instance?.isVisitor != true {
            let line = HealthStatusLine(sync.status, device: model.node.device, isHealth: source == HealthSettings.sourceId)
            VStack(alignment: .leading, spacing: 8) {
                SettingsGroup {
                    PlainRow(title: "Sync with Rome", last: false) {
                        Toggle("Sync with Rome", isOn: Binding(get: { sync.isEnabled }, set: { on in sync.setEnabled(on) }))
                            .labelsHidden()
                            .tint(Palette.primary)
                            .disabled(!sync.canSync)
                    }
                    .accessibilityElement(children: .combine)
                    Button(action: onHistory) {
                        PlainRow(title: "Sync history") {
                            Image(systemName: "chevron.right")
                                .romeFont(13, .semibold)
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                }
                if let text = line.text {
                    HealthStatusRow(sync: sync, line: line, text: text, running: sync.activity.running)
                }
                if let health = sync as? HealthSettings, health.isEnabled, health.freshness().stale {
                    Text("No new Health data for 3 days. Health access may be off: Health app → your picture → Apps → Rome.")
                        .romeFont(13)
                        .foregroundStyle(Palette.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                }
            }
        }
    }
}

/// The sync's status under the switch, with Sign in or Retry when it needs one.
struct HealthStatusRow: View {
    let sync: any SourceSyncing
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
                action("Sync now") { sync.syncNow() }
                    .disabled(running)
            case .signIn?:
                action("Sign in") { Task { await model.reauthenticate() } }
            case .retry?:
                action("Retry") { sync.syncNow() }
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


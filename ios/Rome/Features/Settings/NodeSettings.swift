import SwiftUI

/// Settings' Apple Health and iPhone use rows, one group: each shows On or
/// Off and pushes its page inside the sheet.
struct NodeSettingsGroup: View {
    let onHealth: () -> Void
    let onDevice: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        SettingsGroup {
            // Its own page says what the switch does. Dimmed while the phone is off limits, but still opens.
            let health = HealthRowState(healthOn: node.isHealthEnabled, deviceOn: node.isEnabled)
            Button(action: onHealth) {
                SettingsValueRow(systemImage: "heart", title: "Apple Health", value: health.value)
                    .opacity(health.opacity)
            }
            .buttonStyle(RowPressStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Apple Health")
            .accessibilityValue(Text(verbatim: health.value))
            .accessibilityAddTraits(.isButton)
            let device = node.isEnabled ? String(localized: "On") : String(localized: "Off")
            Button(action: onDevice) {
                SettingsValueRow(systemImage: node.device.symbol, title: node.device.groupTitle, value: device, last: true)
            }
            .buttonStyle(RowPressStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(node.device.groupTitle))
            .accessibilityValue(Text(verbatim: device))
            .accessibilityAddTraits(.isButton)
        }
    }
}

/// A row that opens a page: its state as plain text, then a chevron.
private struct SettingsValueRow: View {
    let systemImage: String
    let title: LocalizedStringKey
    let value: String
    var last = false

    var body: some View {
        SettingsRow(systemImage: systemImage, title: title, last: last) {
            HStack(spacing: 6) {
                Text(verbatim: value).romeFont(17).foregroundStyle(Palette.sub)
                Image(systemName: "chevron.right")
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
            }
        }
    }
}

/// Settings → iPhone use: the switch that lets Rome use this phone as a
/// device, what the connection is doing, and the activity it has answered.
struct NodeSettingsScreen: View {
    let onRequests: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        ScrollView {
            SettingsGroup {
                SettingsRow(systemImage: node.device.symbol, title: node.device.useSwitchTitle) {
                    Toggle(node.device.useSwitchTitle, isOn: Binding(get: { node.isEnabled }, set: { on in node.setEnabled(on) }))
                        .labelsHidden()
                        .tint(Palette.primary)
                }
                .accessibilityElement(children: .combine)
                SettingsRow(systemImage: "dot.radiowaves.left.and.right", title: "Status") {
                    HStack(spacing: 6) {
                        Circle().fill(node.status.color).frame(width: 7, height: 7)
                        Text(node.status.label).romeFont(17).foregroundStyle(Palette.sub)
                    }
                }
                .accessibilityElement(children: .combine)
                Button(action: onRequests) {
                    SettingsRow(systemImage: "list.bullet.rectangle", title: "Recent activity", last: true) {
                        Image(systemName: "chevron.right")
                            .romeFont(13, .semibold)
                            .foregroundStyle(Palette.sub)
                    }
                }
                .buttonStyle(RowPressStyle())
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: node.device.groupTitle, inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
    }
}

extension NodeHost.Status {
    var label: LocalizedStringKey {
        switch self {
        case .off: return "Off"
        case .connecting: return "Connecting…"
        case .online: return "Online"
        case .stopped(.superseded): return "Replaced"
        case .stopped(.revoked): return "Revoked"
        }
    }

    var color: Color {
        switch self {
        case .online: return Palette.success
        case .connecting: return Palette.sub
        case .off: return Palette.sub.opacity(0.5)
        case .stopped: return Palette.destructive
        }
    }
}

/// The last 50 requests from the audit log, by day. It records what was
/// asked and how it went, never a health value.
struct NodeRequestsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        let days = NodeActivityFormatter().days(node.recent)
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if days.isEmpty {
                    Text("No activity yet")
                        .romeFont(15)
                        .foregroundStyle(Palette.sub)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }
                ForEach(days) { day in
                    SettingsGroup(header: LocalizedStringKey(day.title)) {
                        ForEach(Array(day.rows.enumerated()), id: \.element.id) { index, row in
                            NodeActivityRowView(row: row, last: index == day.rows.count - 1)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Recent activity", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task(id: node.requestSerial) { await node.reloadRecent() }
    }
}

private struct NodeActivityRowView: View {
    let row: NodeActivityRow
    let last: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: row.title).romeFont(16, .medium).lineLimit(2)
                Text(verbatim: row.detail)
                    .romeFont(13)
                    .foregroundStyle(row.failed ? Palette.destructive : Palette.sub)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 8)
            Text(verbatim: row.time)
                .romeFont(13, monospacedDigits: true)
                .foregroundStyle(Palette.sub)
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

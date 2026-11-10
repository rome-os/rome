import SwiftUI

/// Settings → iPhone use: the switches that let Rome use this phone as a
/// device and read Apple Health, what the connection is doing, and the
/// activity it has answered.
struct NodeSettingsGroup: View {
    let onHealth: () -> Void
    let onRequests: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        SettingsGroup(header: node.device.groupTitle) {
            SettingsRow(systemImage: node.device.symbol, title: node.device.useSwitchTitle) {
                Toggle(node.device.useSwitchTitle, isOn: Binding(get: { node.isEnabled }, set: { on in node.setEnabled(on) }))
                    .labelsHidden()
                    .tint(Palette.primary)
            }
            .accessibilityElement(children: .combine)
            // Its own page says what the switch does. Dimmed while the phone is off limits, but still opens.
            let health = HealthRowState(healthOn: node.isHealthEnabled, deviceOn: node.isEnabled)
            Button(action: onHealth) {
                SettingsRow(systemImage: "heart", title: "Apple Health") {
                    HStack(spacing: 6) {
                        Text(verbatim: health.value).romeFont(17).foregroundStyle(Palette.sub)
                        Image(systemName: "chevron.right")
                            .romeFont(13, .semibold)
                            .foregroundStyle(Palette.sub)
                    }
                }
                .opacity(health.opacity)
            }
            .buttonStyle(RowPressStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Apple Health")
            .accessibilityValue(Text(verbatim: health.value))
            .accessibilityAddTraits(.isButton)
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
        .background(Palette.bg.ignoresSafeArea())
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

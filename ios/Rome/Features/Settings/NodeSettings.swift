import SwiftUI

/// Settings' Apple Health and iPhone use rows, one group: each shows its
/// state and pushes its page inside the sheet.
struct NodeSettingsGroup: View {
    let onHealth: () -> Void
    let onDevice: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        SettingsGroup {
            let health = HealthRowState(status: model.health.status).value
            Button(action: onHealth) {
                SettingsValueRow(systemImage: "heart", title: "Apple Health", value: health)
            }
            .buttonStyle(RowPressStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Apple Health")
            .accessibilityValue(Text(verbatim: health))
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
struct SettingsValueRow: View {
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
/// device, what Rome can do with it, and the activity it has answered.
struct NodeSettingsScreen: View {
    let onRequests: () -> Void
    let onCapability: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var states: [String: NodeCapabilityState] = [:]

    var body: some View {
        let node = model.node
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsGroup {
                        SettingsRow(systemImage: node.device.symbol, title: node.device.useSwitchTitle, last: true) {
                            Toggle(node.device.useSwitchTitle, isOn: Binding(get: { node.isEnabled }, set: { on in node.setEnabled(on) }))
                                .labelsHidden()
                                .tint(Palette.primary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    HStack(spacing: 6) {
                        Circle().fill(node.status.color).frame(width: 7, height: 7)
                        Text(verbatim: NodeStatusLine.text(device: UIDevice.current.name, status: node.status, enabled: node.isEnabled))
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                    }
                    .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
                    .accessibilityElement(children: .combine)
                }
                SettingsGroup(header: "What Rome can do") {
                    let capabilities = node.registry.capabilities
                    ForEach(Array(capabilities.enumerated()), id: \.element.prefix) { index, capability in
                        let value = NodeCapabilityRowState(states[capability.prefix]).value
                        Button { onCapability(capability.prefix) } label: {
                            SettingsValueRow(systemImage: capability.symbol, title: LocalizedStringKey(capability.title.key), value: value, last: index == capabilities.count - 1)
                                // Dimmed while the phone is off limits, but each still opens.
                                .opacity(node.isEnabled ? 1 : 0.45)
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(capability.title))
                        .accessibilityValue(Text(verbatim: value))
                        .accessibilityAddTraits(.isButton)
                    }
                }
                SettingsGroup {
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
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: node.device.groupTitle, inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task(id: CapabilityStatesKey(serial: node.capabilitySerial, health: model.health.isEnabled)) {
            states = await NodeCapabilityRowState.load(node.registry)
        }
    }
}

/// What makes the capability states worth reading again.
struct CapabilityStatesKey: Hashable {
    let serial: Int
    let health: Bool
}

/// A capability's row: its state in words.
struct NodeCapabilityRowState: Equatable {
    let state: NodeCapabilityState?

    init(_ state: NodeCapabilityState?) { self.state = state }

    var value: String {
        switch state {
        case .on?: return String(localized: "On")
        case .needsPermission?: return String(localized: "Needs access")
        case .off?, nil: return String(localized: "Off")
        }
    }

    static func load(_ registry: NodeCapabilityRegistry) async -> [String: NodeCapabilityState] {
        var states: [String: NodeCapabilityState] = [:]
        for row in await registry.rows() { states[row.capability.prefix] = row.state }
        return states
    }
}

/// The line under the master switch: the device's name and whether Rome can
/// reach it now.
enum NodeStatusLine {
    static func text(device: String, status: NodeHost.Status, enabled: Bool) -> String {
        "\(device) · \(words(status, enabled: enabled))"
    }

    static func words(_ status: NodeHost.Status, enabled: Bool) -> String {
        switch status {
        case .online: return String(localized: "Online")
        case .connecting: return String(localized: "Connecting…")
        case .stopped(.superseded): return String(localized: "Replaced")
        case .stopped(.revoked): return String(localized: "Revoked")
        case .off: return enabled ? String(localized: "Offline · available while Rome is open") : String(localized: "Off")
        }
    }
}

/// One capability's page: its switch (or the page whose switch it follows),
/// what it reads, what it sends, and where iOS's access is set.
struct NodeCapabilityScreen: View {
    let prefix: String
    let onFollow: (SettingsRoute) -> Void
    @Environment(AppModel.self) private var model
    @State private var state: NodeCapabilityState?

    var body: some View {
        let node = model.node
        ScrollView {
            if let capability = node.registry.capability(prefix: prefix) {
                VStack(alignment: .leading, spacing: 26) {
                    header(capability)
                    switchCard(capability, node: node)
                    SettingsGroup {
                        DetailRow(title: "Reads", value: capability.detail.reads)
                        DetailRow(title: "Sends", value: capability.detail.leaves, last: capability.detail.systemAccess == nil)
                        if let access = capability.detail.systemAccess {
                            DetailRow(title: "iOS access", value: access, last: true)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task(id: CapabilityStatesKey(serial: node.capabilitySerial, health: model.health.isEnabled)) {
            state = await node.registry.capability(prefix: prefix)?.state()
        }
    }

    private func header(_ capability: any NodeCapability) -> some View {
        VStack(spacing: 10) {
            Image(systemName: capability.symbol)
                .romeFont(40)
                .foregroundStyle(Palette.fg)
                .frame(width: 72, height: 72)
                .background(Palette.secondaryFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .accessibilityHidden(true)
            Text(capability.title)
                .romeFont(24, .bold)
                .tracking(-0.4)
                .foregroundStyle(Palette.fg)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func switchCard(_ capability: any NodeCapability, node: NodeHost) -> some View {
        switch capability.switchKind {
        case .own:
            let title = LocalizedStringKey(capability.title.key)
            SettingsGroup {
                SettingsRow(systemImage: capability.symbol, title: title, last: true) {
                    Toggle(isOn: Binding(get: { node.capabilitySwitches[capability.prefix] ?? false }, set: { on in node.setCapability(capability.prefix, on: on) })) {
                        Text(capability.title)
                    }
                    .labelsHidden()
                    .tint(Palette.primary)
                }
                .accessibilityElement(children: .combine)
            }
        case .follows(let route):
            let value = NodeCapabilityRowState(state).value
            SettingsGroup {
                Button { onFollow(route) } label: {
                    SettingsValueRow(systemImage: "arrow.turn.down.right", title: "Uses Apple Health's setting", value: value, last: true)
                }
                .buttonStyle(RowPressStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Uses Apple Health's setting")
                .accessibilityValue(Text(verbatim: value))
                .accessibilityAddTraits(.isButton)
            }
        }
    }
}

/// A label and its short value, as Settings' rows have them.
private struct DetailRow: View {
    let title: LocalizedStringKey
    let value: LocalizedStringResource
    var last = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).romeFont(17).foregroundStyle(Palette.fg)
            Spacer(minLength: 8)
            Text(value)
                .romeFont(15)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
        .accessibilityElement(children: .combine)
    }
}

extension NodeHost.Status {
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
        let days = NodeActivityFormatter(registry: node.registry).days(node.recent)
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

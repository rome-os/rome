import SwiftUI

/// Settings' Connections row: the page with this phone's connections.
struct ConnectionsRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SettingsRow(systemImage: "point.3.connected.trianglepath.dotted", title: "Connections", last: true) {
                Image(systemName: "chevron.right")
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
            }
        }
        .buttonStyle(RowPressStyle())
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

/// What a connection's row says on its right.
enum ConnectionRowValue {
    static func text(connected: Bool, live: Bool, sync: HealthSyncStatus?) -> String {
        guard connected else { return String(localized: "Not connected") }
        if sync == .needsSignIn { return String(localized: "Needs sign-in") }
        let syncing = sync.map { $0 != .off } ?? false
        return live || syncing ? String(localized: "On") : String(localized: "Off")
    }
}

/// Settings → Connections: this phone's connections, one per capability,
/// how rome-node stands, and the web page for accounts and services.
struct ConnectionsScreen: View {
    let isVisitor: Bool
    let onConnection: (String) -> Void
    let onWeb: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsGroup(header: node.device.thisDevice) {
                        let capabilities = node.registry.capabilities
                        ForEach(Array(capabilities.enumerated()), id: \.element.id) { index, capability in
                            let value = value(capability)
                            Button { onConnection(capability.id) } label: {
                                SettingsValueRow(systemImage: capability.symbol, title: LocalizedStringKey(capability.title.key), value: value, last: index == capabilities.count - 1)
                            }
                            .buttonStyle(RowPressStyle())
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(Text(capability.title))
                            .accessibilityValue(Text(verbatim: value))
                            .accessibilityAddTraits(.isButton)
                        }
                    }
                    if node.anyLive {
                        NodeStatusRow(status: node.status)
                    }
                }
                // Accounts and services connect on the dashboard, which is the guardian's.
                if !isVisitor {
                    SettingsGroup {
                        Button(action: onWeb) {
                            SettingsRow(systemImage: "macwindow", title: "Accounts and services", last: true) {
                                Image(systemName: "arrow.up.right")
                                    .romeFont(13, .semibold)
                                    .foregroundStyle(Palette.sub)
                            }
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityHint("Opens Connections on the web")
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Connections", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
    }

    private func value(_ capability: any NodeCapability) -> String {
        let sync = capability.syncSource == HealthSettings.sourceId && model.health.canSync ? model.health.status : nil
        return ConnectionRowValue.text(
            connected: model.connections.isConnected(capability),
            live: model.node.liveSwitches[capability.id] ?? false,
            sync: sync
        )
    }
}

/// rome-node's state, under a card: whether the Rome can reach the phone now.
struct NodeStatusRow: View {
    let status: NodeHost.Status

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(status.color).frame(width: 7, height: 7)
            Text(verbatim: NodeStatusLine.words(status))
                .romeFont(13)
                .foregroundStyle(Palette.sub)
        }
        .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
        .accessibilityElement(children: .combine)
    }
}

/// Whether the Rome can reach this phone now.
enum NodeStatusLine {
    static func words(_ status: NodeHost.Status) -> String {
        switch status {
        case .online: return String(localized: "Online")
        case .connecting: return String(localized: "Connecting…")
        case .stopped(.superseded): return String(localized: "Replaced")
        case .stopped(.revoked): return String(localized: "Revoked")
        case .off: return String(localized: "Offline")
        }
    }
}

/// One connection's page, the same for every capability: its header; then
/// one Connect button, or its Live access (and Sync, for one that syncs);
/// where its data goes; and, for Health, what the Rome can do with it.
struct ConnectionScreen: View {
    let id: String
    let onActivity: () -> Void
    let onHistory: () -> Void
    @Environment(AppModel.self) private var model
    @State private var connecting = false

    var body: some View {
        let node = model.node
        ScrollViewReader { proxy in
            ScrollView {
                if let capability = node.registry.capability(id: id) {
                    VStack(alignment: .leading, spacing: 26) {
                        ConnectionHeader(capability: capability)
                        if model.connections.isConnected(capability) {
                            LiveAccessSection(capability: capability, onActivity: onActivity)
                            if capability.syncSource == HealthSettings.sourceId {
                                HealthSyncSection(onHistory: onHistory)
                            }
                        } else {
                            PrimaryButton(title: "Connect", loading: connecting) { connect() }
                        }
                        DataFlowSection(capability: capability)
                        if capability.syncSource == HealthSettings.sourceId {
                            HealthChats()
                                .id("end")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 32)
                }
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
        .task(id: node.requestSerial) { await node.reloadRecent() }
    }

    private func connect() {
        connecting = true
        Task {
            await model.connect(id)
            connecting = false
        }
    }
}

/// Live access: its switch and the reads it answered, then whether the Rome
/// can reach the phone now.
private struct LiveAccessSection: View {
    let capability: any NodeCapability
    let onActivity: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        let on = node.liveSwitches[capability.id] ?? false
        let reads = node.recent.filter { capability.handles($0.action) }.count
        VStack(alignment: .leading, spacing: 8) {
            SettingsGroup {
                PlainRow(title: "Live access", last: false) {
                    Toggle("Live access", isOn: Binding(get: { on }, set: { value in node.setLive(capability.id, on: value) }))
                        .labelsHidden()
                        .tint(Palette.primary)
                }
                .accessibilityElement(children: .combine)
                Button(action: onActivity) {
                    PlainRow(title: "Recent reads") {
                        HStack(spacing: 6) {
                            Text(verbatim: "\(reads)").romeFont(17, monospacedDigits: true).foregroundStyle(Palette.sub)
                            Image(systemName: "chevron.right")
                                .romeFont(13, .semibold)
                                .foregroundStyle(Palette.sub)
                        }
                    }
                }
                .buttonStyle(RowPressStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Recent reads")
                .accessibilityValue(Text(verbatim: "\(reads)"))
                .accessibilityAddTraits(.isButton)
            }
            if on { NodeStatusRow(status: node.status) }
        }
    }
}

/// A connection page's top: its mark, its name and what it is for.
private struct ConnectionHeader: View {
    let capability: any NodeCapability

    var body: some View {
        VStack(spacing: 10) {
            if capability.id == HealthCapability.id {
                Image(systemName: "heart.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(Palette.healthPink)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: capability.symbol)
                    .romeFont(36)
                    .foregroundStyle(Palette.fg)
                    .frame(width: 72, height: 72)
                    .background(Palette.secondaryFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityHidden(true)
            }
            Text(capability.title)
                .romeFont(28, .bold)
                .tracking(-0.6)
                .foregroundStyle(Palette.fg)
            Text(capability.summary)
                .romeFont(15)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}

/// Where a connection's data goes: this phone, the Rome, the AI model, and
/// one line on what the Rome does with it.
struct DataFlowSection: View {
    let capability: any NodeCapability
    @Environment(AppModel.self) private var model

    var body: some View {
        let device = model.node.device
        VStack(alignment: .leading, spacing: 8) {
            SettingsGroup(header: "Where your data goes") {
                HStack(alignment: .top, spacing: 4) {
                    FlowNode(symbol: device.symbol, label: device.thisDevice)
                    FlowArrow()
                    FlowNode(symbol: "server.rack", label: "Your Rome")
                    FlowArrow()
                    FlowNode(symbol: "sparkle", label: "Your AI model")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 16)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(device.dataFlowLabel)
            }
            Group {
                if capability.syncSource == HealthSettings.sourceId {
                    Text("Sent to your Rome and your AI model, whose terms apply · Never sold or used for ads · Delete anytime · [Privacy Policy](https://romeos.cc/privacy)")
                } else {
                    Text("Read only when you ask · [Privacy Policy](https://romeos.cc/privacy)")
                }
            }
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .tint(Palette.primaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, SettingsGroup<EmptyView>.textInset)
        }
    }
}

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

/// A card's row with no icon: a title and its control, with a hairline
/// under it unless it is the card's last.
struct PlainRow<Trailing: View>: View {
    let title: LocalizedStringKey
    var last = true
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Text(title).romeFont(17).foregroundStyle(Palette.fg)
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
        }
        .contentShape(Rectangle())
    }
}

/// A card asked to connect: the connection's header and where its data
/// goes, then the same authorization as Settings, or Not now.
struct ConnectDeviceSheet: View {
    let request: DeviceConnectRequest
    @Environment(AppModel.self) private var model
    @State private var connecting = false

    var body: some View {
        VStack(spacing: 20) {
            if let capability = model.node.registry.capability(id: request.capability) {
                ScrollView {
                    VStack(spacing: 20) {
                        ConnectionHeader(capability: capability)
                            .padding(.top, 12)
                        DataFlowSection(capability: capability)
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                VStack(spacing: 10) {
                    PrimaryButton(title: "Connect", loading: connecting) {
                        connecting = true
                        Task {
                            await model.connect(request.capability)
                            connecting = false
                            request.finish(true)
                        }
                    }
                    Button("Not now") { request.finish(false) }
                        .romeFont(17, .medium)
                        .foregroundStyle(Palette.primaryText)
                        .frame(minHeight: 44)
                        .buttonStyle(PressScaleStyle())
                        .disabled(connecting)
                }
            }
        }
        .padding(20)
        // Mid-connect it stays until the card can check.
        .interactiveDismissDisabled(connecting)
        .onDisappear { request.finish(false) }
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

/// One capability's live reads from the audit log, by day: the last 50
/// requests. It records what was asked and how it went, never a value.
struct NodeRequestsScreen: View {
    let capability: String
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.node
        let mine = node.registry.capability(id: capability)
        let entries = node.recent.filter { entry in mine?.handles(entry.action) ?? false }
        let days = NodeActivityFormatter(registry: node.registry).days(entries)
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if days.isEmpty {
                    Text("No live reads yet")
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
        .floatingTopBar { PageHeader(title: "Live reads", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task(id: node.requestSerial) { await node.reloadRecent() }
    }
}

/// One request: what was read, how it went, and when.
struct NodeActivityRowView: View {
    let row: NodeActivityRow
    /// "Today" or a date, where rows of several days share a card.
    var day: String? = nil
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
            Text(verbatim: day.map { "\($0), \(row.time)" } ?? row.time)
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

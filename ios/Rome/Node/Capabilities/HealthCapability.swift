import Foundation

/// Apple Health, read live while the app is open: `health.stats` and
/// `health.samples` (HealthActions.swift). It has no switch of its own: it
/// follows Apple Health's Sync with Rome, so one choice covers both the
/// synced data and the live reads.
struct HealthCapability: NodeCapability {
    let health: HealthActions

    /// `enabled`: Sync with Rome, which `HealthSettings` keeps.
    init(health: HealthActions, enabled: NodeFlag) {
        var health = health
        health.enabled = enabled
        self.health = health
    }

    let prefix = "health"
    let name = "Apple Health"
    var title: LocalizedStringResource { "Apple Health" }
    let symbol = "heart"
    let personal = true
    var switchKind: NodeCapabilitySwitch { .follows(.health) }

    var actions: [NodeActionSpec] {
        let usage = HealthActions.usage(health.device)
        return ["health.stats", "health.samples"].map { NodeActionSpec(name: $0, usage: usage[$0] ?? "") }
    }

    var detail: NodeCapabilityDetail {
        NodeCapabilityDetail(
            reads: "The Health data you allow",
            leaves: "Only what Rome asks for",
            systemAccess: "Health app → your picture → Apps → Rome"
        )
    }

    func state() async -> NodeCapabilityState {
        guard health.enabled.isOn else { return .off }
        return await health.reader.shouldRequestAccess() ? .needsPermission : .on
    }

    func run(_ action: String, args: JSONValue?) async -> NodeActionResult {
        await health.run(action, args: args)
    }

    func refusal(_ state: NodeCapabilityState, device: DeviceKind) -> NodeActionResult {
        switch state {
        case .off: return HealthActions.off(device)
        case .needsPermission:
            return .failed(
                code: "health_no_permission",
                message: "iOS has not been asked for Health access on this \(device.name). The user must open Settings → Apple Health in the Rome app on the \(device.name) and allow it."
            )
        case .on: return .failed(code: "unsupported_action", message: "This \(device.name) does not support this action.")
        }
    }

    // MARK: Activity

    private static let maxTypes = 3

    func activityTitle(_ entry: NodeAuditEntry) -> String? {
        guard handles(entry.action) else { return nil }
        let args = entry.argsValue
        var names: [String] = []
        if let list = args?["types"]?.array { names = list.compactMap(\.string) }
        if let single = args?["type"]?.string { names.append(single) }
        guard !names.isEmpty else { return String(localized: "Health request") }
        let words = names.map(NodeActivityFormatter.typeName)
        if entry.action == "health.samples" { return String(localized: "\(words[0]) records") }
        let shown = words.prefix(Self.maxTypes).reduce(nil as String?) { joined, word in
            joined.map { String(localized: "\($0), \(word)") } ?? word
        } ?? ""
        let more = words.count - Self.maxTypes
        return more > 0 ? String(localized: "\(shown) +\(more)") : shown
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? {
        let args = entry.argsValue
        var parts = [formatter.window(entry, args)]
        if entry.action == "health.stats", let interval = args?["interval"]?.string, let mode = Self.modeText(interval) { parts.append(mode) }
        // A stats count is only the number of types asked for: not shown.
        if entry.action == "health.samples", let count = entry.count { parts.append(String(localized: "\(count) records")) }
        if args?["cursor"]?.string != nil { parts.append(String(localized: "next page")) }
        return parts.joined(separator: " · ")
    }

    private static func modeText(_ interval: String) -> String? {
        switch interval {
        case "hour": return String(localized: "by hour")
        case "day": return String(localized: "by day")
        case "week": return String(localized: "by week")
        case "month": return String(localized: "by month")
        default: return nil
        }
    }
}

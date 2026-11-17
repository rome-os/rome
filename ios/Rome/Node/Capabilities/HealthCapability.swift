import Foundation

/// Apple Health: read live while the app is open (`health.stats`,
/// `health.samples` in HealthActions.swift), and synced into the Rome's
/// personal data, which `HealthSettings` does per Rome. Its Live access is
/// its own switch, apart from Sync: one per phone.
struct HealthCapability: NodeCapability {
    static let id = "apple_health"

    let health: HealthActions

    init(health: HealthActions, live: NodeFlag) {
        var health = health
        health.enabled = live
        self.health = health
    }

    var id: String { Self.id }
    let prefix = "health"
    let name = "Apple Health"
    var title: LocalizedStringResource { "Apple Health" }
    let symbol = "heart"
    var summary: LocalizedStringResource { "Your Rome reads the Health data you allow." }
    var examples: [CapabilityExample] {
        [
            CapabilityExample(
                symbol: "heart.text.square", title: "Daily health summary",
                request: "Summarize my health for me every day.",
                reply: "Every morning at 9, I'll send your sleep, steps and resting heart rate, and flag anything unusual."
            ),
            CapabilityExample(
                symbol: "bed.double", title: "Understand your sleep",
                request: "Why have I felt so tired lately?",
                reply: "Your deep sleep dropped over the last two weeks, and your HRV fell with it."
            ),
            CapabilityExample(
                symbol: "waveform.path.ecg", title: "Notice heart trends",
                request: "Has my resting heart rate changed this month?",
                reply: "It's 4 bpm higher than last month, mostly on days you slept under 6 hours."
            ),
        ]
    }
    let personal = true
    let needsPermission = true
    var syncSource: String? { HealthSettings.sourceId }
    var live: NodeFlag { health.enabled }

    var actions: [NodeActionSpec] {
        let usage = HealthActions.usage(health.device)
        return ["health.stats", "health.samples"].map {
            NodeActionSpec(name: $0, usage: usage[$0] ?? "", examples: HealthActions.examples[$0] ?? [])
        }
    }

    /// HealthKit hides whether read access was granted: a refusal looks the
    /// same as a type with no data. So the Rome is always told `unknown`.
    func permission() async -> NodePermission { .unknown }

    /// Waiting only while iOS was never asked.
    func state() async -> NodeCapabilityState {
        guard live.isOn else { return .off }
        return await health.reader.shouldRequestAccess() ? .needsPermission : .on
    }

    func requestPermission() async {
        if await health.reader.shouldRequestAccess() { try? await health.reader.requestAccess() }
    }

    func run(_ action: String, args: JSONValue?) async -> NodeActionResult {
        await health.run(action, args: args)
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

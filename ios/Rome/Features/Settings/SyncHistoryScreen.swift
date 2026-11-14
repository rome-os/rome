import SwiftUI

// Apple Health → Sync history: the last sync, how far each type has synced,
// every sync of the last 30 days by day, and Sync now, Pause and Delete
// uploaded data. Counts and times only, never a value.

struct SyncHistoryRow: Identifiable, Equatable {
    let id: Int
    let title: String
    let detail: String
    let failed: Bool
    let time: String
}

struct SyncHistoryDay: Identifiable, Equatable {
    let id: Date
    let title: String
    let rows: [SyncHistoryRow]
}

struct SyncTypeRow: Identifiable, Equatable {
    var id: String { type }
    let type: String
    let text: String
}

struct SyncHistoryFormatter {
    var now: Date = Date()
    var calendar: Calendar = .current
    var locale: Locale = .current
    var device: DeviceKind = .iPhone

    private var days: NodeActivityFormatter {
        NodeActivityFormatter(registry: NodeCapabilityRegistry(capabilities: []), now: now, calendar: calendar, locale: locale)
    }

    private static let maxTypes = 2

    // MARK: Syncs

    /// Newest first, by day. A sync that found nothing new and went well
    /// adds no row of its own past the newest one, so the list shows what moved.
    func days(_ entries: [SyncLogEntry]) -> [SyncHistoryDay] {
        var result: [SyncHistoryDay] = []
        for (index, entry) in entries.enumerated() {
            if index > 0, entry.outcome == .ok, entry.itemCount == 0 { continue }
            let day = calendar.startOfDay(for: entry.time)
            let row = row(entry)
            if let last = result.last, last.id == day {
                result[result.count - 1] = SyncHistoryDay(id: day, title: last.title, rows: last.rows + [row])
            } else {
                result.append(SyncHistoryDay(id: day, title: days.dayText(day), rows: [row]))
            }
        }
        return result
    }

    func row(_ entry: SyncLogEntry) -> SyncHistoryRow {
        let failed = entry.outcome == .error
        return SyncHistoryRow(
            id: entry.seq, title: triggerText(entry), detail: detail(entry), failed: failed,
            time: entry.time.formatted(base().hour().minute())
        )
    }

    /// How the sync came about, in words.
    func triggerText(_ entry: SyncLogEntry) -> String {
        if entry.outcome == .deleted { return String(localized: "Uploaded data deleted") }
        if entry.history { return String(localized: "History") }
        switch entry.trigger {
        case .observer: return String(localized: "In the background")
        case .foreground: return String(localized: "When you opened Rome")
        case .manual: return String(localized: "Sync now")
        case .backfill: return String(localized: "History")
        case .retry: return String(localized: "Retry")
        }
    }

    func detail(_ entry: SyncLogEntry) -> String {
        switch entry.outcome {
        case .deleted: return String(localized: "Sync turned off")
        case .skipped: return skipText(entry.errorCode)
        case .error: return failureText(entry.errorCode)
        case .ok, .partial, .interrupted:
            var parts: [String] = []
            if entry.itemCount == 0 {
                parts.append(String(localized: "Up to date"))
            } else {
                parts.append(typesText(entry.types))
                parts.append(String(localized: "\(entry.itemCount) readings"))
                if let range = rangeText(entry.types) { parts.append(range) }
            }
            if entry.outcome == .partial { parts.append(String(localized: "some not sent")) }
            if entry.outcome == .interrupted { parts.append(String(localized: "continues next time")) }
            return parts.joined(separator: " · ")
        }
    }

    func resultText(_ entry: SyncLogEntry) -> String {
        switch entry.outcome {
        case .ok: return String(localized: "Done")
        case .partial: return String(localized: "Some readings not sent")
        case .interrupted: return String(localized: "Continues next time")
        case .deleted: return String(localized: "Uploaded data deleted")
        case .skipped: return skipText(entry.errorCode)
        case .error: return failureText(entry.errorCode)
        }
    }

    private func typesText(_ types: [String: SyncTypeCount]) -> String {
        let names = types.filter { $0.value.items > 0 }.sorted { $0.value.items > $1.value.items }.map { NodeActivityFormatter.typeName($0.key) }
        // "Steps and Heart rate", or "Steps, Heart rate +3" when there are more.
        let shown = names.count > Self.maxTypes
            ? names.prefix(Self.maxTypes).joined(separator: String(localized: ", "))
            : Array(names).formatted(.list(type: .and).locale(locale))
        let more = names.count - Self.maxTypes
        return more > 0 ? String(localized: "\(shown) +\(more)") : shown
    }

    /// "7:00–9:00" within a day, else "Aug 1 – Aug 31".
    private func rangeText(_ types: [String: SyncTypeCount]) -> String? {
        guard let start = types.values.compactMap(\.start).min(), let end = types.values.compactMap(\.end).max() else { return nil }
        if calendar.isDate(start, inSameDayAs: end.addingTimeInterval(-1)) {
            let time = base().hour().minute()
            return "\(start.formatted(time))–\(end.formatted(time))"
        }
        return "\(start.formatted(dateStyle(start))) – \(end.addingTimeInterval(-1).formatted(dateStyle(end)))"
    }

    func skipText(_ code: String?) -> String {
        switch code {
        case "locked": return String(localized: "Skipped · \(device.name) locked")
        case "paused": return String(localized: "Skipped · paused")
        case "no_access": return String(localized: "Skipped · no access to Health")
        default: return String(localized: "Skipped")
        }
    }

    func failureText(_ code: String?) -> String {
        switch code {
        case "signed_out": return String(localized: "Signed out of your Rome")
        case "needs_update": return String(localized: "Your Rome needs an update")
        case "network": return String(localized: "Couldn't reach your Rome")
        case "rate_limited": return String(localized: "Too many syncs, trying later")
        case "health_failed": return String(localized: "Couldn't read Health")
        default: return String(localized: "Your Rome couldn't take it")
        }
    }

    // MARK: Types

    /// One row per type with data: how far it has synced, and since when
    /// the Rome has it.
    func types(log: [SyncLogEntry], stored: PersonalDataCatalogSource?) -> [SyncTypeRow] {
        var latest: [String: Date] = [:]
        var earliest: [String: Date] = [:]
        // A bucket's end can be ahead of the sync, as today's day ends at
        // midnight: a type has synced up to when it was read, no further.
        for entry in log {
            // Only what is on the Rome now: nothing from before a delete.
            if entry.outcome == .deleted { break }
            for (type, count) in entry.types where count.items > 0 {
                if let end = count.end.map({ min($0, entry.time) }) { latest[type] = max(latest[type] ?? end, end) }
            }
        }
        for type in stored?.types ?? [] where (type.pointCount ?? 0) > 0 {
            if var end = RomeDate.parse(type.latest) ?? Self.dayDate(type.latest, calendar: calendar) {
                if let through = RomeDate.parse(type.syncedThrough) { end = min(end, through) }
                end = min(end, now)
                latest[type.type] = max(latest[type.type] ?? end, end)
            }
            if let start = RomeDate.parse(type.earliest) ?? Self.dayDate(type.earliest, calendar: calendar) { earliest[type.type] = start }
        }
        let order = HealthSyncPlan.all.map(\.name)
        return latest.keys.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }.map { type in
            var parts = [NodeActivityFormatter.typeName(type), upTo(type, latest[type]!)]
            if let since = earliest[type] { parts.append(String(localized: "since \(since.formatted(base().month(.abbreviated).year()))")) }
            return SyncTypeRow(type: type, text: parts.joined(separator: " · "))
        }
    }

    /// "up to 9:00", "up to last night", "up to 3 Nov".
    func upTo(_ type: String, _ date: Date) -> String {
        let last = date.addingTimeInterval(-1)
        if type == "sleep", calendar.isDate(last, inSameDayAs: now) { return String(localized: "up to last night") }
        if calendar.isDate(last, inSameDayAs: now) { return String(localized: "up to \(date.formatted(base().hour().minute()))") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(last, inSameDayAs: yesterday) {
            return String(localized: "up to yesterday")
        }
        return String(localized: "up to \(last.formatted(dateStyle(last)))")
    }

    /// "since May 2026 · 66K readings" for what the Rome holds.
    func storedText(_ stored: PersonalDataCatalogSource?) -> String? {
        guard let stored, let types = stored.types, !types.isEmpty else { return nil }
        let count = types.reduce(0) { $0 + ($1.pointCount ?? 0) }
        guard count > 0 else { return nil }
        let readings = String(localized: "\(count.formatted(.number.notation(.compactName).locale(locale))) readings")
        let start = types.compactMap { RomeDate.parse($0.earliest) ?? Self.dayDate($0.earliest, calendar: calendar) }.min()
        guard let start else { return readings }
        return String(localized: "since \(start.formatted(base().month(.wide).year())) · \(readings)")
    }

    static func dayDate(_ text: String?, calendar: Calendar) -> Date? {
        text.flatMap { AppleHealthSource.date(day: $0, calendar: calendar) }
    }

    // MARK: Formats

    private func base() -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }

    private func dateStyle(_ date: Date) -> Date.FormatStyle {
        let style = base().month(.abbreviated).day()
        return calendar.isDate(date, equalTo: now, toGranularity: .year) ? style : style.year()
    }
}

struct SyncHistoryScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteFailed = false

    var body: some View {
        let health = model.health
        let formatter = SyncHistoryFormatter(device: model.node.device)
        let last = health.history.first
        let line = HealthStatusLine(health.status, device: model.node.device)
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if line.action == .signIn, let text = line.text {
                    SettingsGroup {
                        HealthStatusRow(line: line, text: text)
                            .padding(.vertical, 14)
                    }
                }
                if let last {
                    SettingsGroup(header: "Last sync") {
                        HistoryValueRow(title: "When", value: last.time.formatted(date: .abbreviated, time: .shortened))
                        HistoryValueRow(title: "How", value: formatter.triggerText(last))
                        HistoryValueRow(title: "Result", value: formatter.resultText(last), failed: last.outcome == .error, last: true)
                    }
                }
                let types = formatter.types(log: health.history, stored: health.stored)
                if !types.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SettingsGroup(header: "By type") {
                            ForEach(Array(types.enumerated()), id: \.element.id) { index, row in
                                HistoryTextRow(text: row.text, last: index == types.count - 1)
                            }
                        }
                        if let stored = formatter.storedText(health.stored) {
                            NoteLine(text: String(localized: "On your Rome \(stored)"))
                        }
                    }
                }
                actions(health)
                let days = formatter.days(health.history)
                if days.isEmpty {
                    Text("No syncs yet")
                        .romeFont(15)
                        .foregroundStyle(Palette.sub)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)
                }
                ForEach(days) { day in
                    SettingsGroup(header: LocalizedStringKey(day.title)) {
                        ForEach(Array(day.rows.enumerated()), id: \.element.id) { index, row in
                            SyncRowView(row: row, last: index == day.rows.count - 1)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Sync history", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task {
            await health.reloadHistory()
            await health.reloadStored()
        }
        .alert("Delete all Apple Health data this \(model.node.device.name) sent to your Rome?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { delete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your Agents can no longer read it. Things they already wrote in chats or memory stay. Sync turns off.")
        }
        .alert("Couldn't delete. Check your connection and try again.", isPresented: $deleteFailed) {
            Button("OK", role: .cancel) {}
        }
    }

    private func actions(_ health: HealthSettings) -> some View {
        SettingsGroup {
            if health.isEnabled {
                // Paused reads nothing: Resume is the way back.
                if !health.isPaused {
                    Button { health.syncNow() } label: {
                        ActionRow(title: "Sync now", busy: health.activity.running)
                    }
                    .buttonStyle(RowPressStyle())
                    .disabled(health.activity.running)
                }
                Button { health.setPaused(!health.isPaused) } label: {
                    ActionRow(title: health.isPaused ? "Resume" : "Pause")
                }
                .buttonStyle(RowPressStyle())
            }
            Button { confirmDelete = true } label: {
                ActionRow(title: "Delete uploaded data…", destructive: true, busy: deleting, last: true)
            }
            .buttonStyle(RowPressStyle())
            .disabled(deleting)
        }
    }

    private func delete() {
        deleting = true
        Task {
            let done = await model.health.deleteUploaded()
            deleting = false
            if !done { deleteFailed = true }
        }
    }
}

private struct ActionRow: View {
    let title: LocalizedStringKey
    var destructive = false
    var busy = false
    var last = false

    var body: some View {
        HStack {
            Text(title)
                .romeFont(17)
                .foregroundStyle(destructive ? Palette.destructive : Palette.fg)
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
    }
}

private struct HistoryValueRow: View {
    let title: LocalizedStringKey
    let value: String
    var failed = false
    var last = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).romeFont(16).foregroundStyle(Palette.fg)
            Spacer(minLength: 8)
            Text(verbatim: value)
                .romeFont(15)
                .foregroundStyle(failed ? Palette.destructive : Palette.sub)
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

private struct HistoryTextRow: View {
    let text: String
    var last = false

    var body: some View {
        Text(verbatim: text)
            .romeFont(15)
            .foregroundStyle(Palette.fg)
            .lineLimit(2)
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
    }
}

private struct SyncRowView: View {
    let row: SyncHistoryRow
    let last: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: row.title).romeFont(16, .medium).lineLimit(1)
                Text(verbatim: row.detail)
                    .romeFont(13)
                    .foregroundStyle(row.failed ? Palette.destructive : Palette.sub)
                    .lineLimit(2)
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

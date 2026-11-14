import SwiftUI

// Apple Health → Sync history: every sync of the last 30 days, by day, each
// a row with how it came about, when, and how many readings went. Counts
// only, never a value. Delete uploaded data sits at the bottom. How the sync
// stands now, and Sync now, are on the Apple Health page.

/// One sync as a row.
struct SyncHistoryRow: Identifiable, Equatable {
    let id: Int
    let symbol: String
    let title: String
    /// The time, and for a failure why it failed.
    let detail: String
    /// "7 readings"; nil for a failure, a skip or a delete.
    let count: String?
    let failed: Bool
}

struct SyncHistoryDay: Identifiable, Equatable {
    let id: Date
    let title: String
    let rows: [SyncHistoryRow]
}

struct SyncHistoryFormatter {
    var now: Date = Date()
    var calendar: Calendar = .current
    var locale: Locale = .current
    var device: DeviceKind = .iPhone

    /// Newest first, by day. A sync that found nothing new and went well
    /// adds no row past the newest one, so the list shows what moved.
    func days(_ entries: [SyncLogEntry]) -> [SyncHistoryDay] {
        var days: [SyncHistoryDay] = []
        for (index, entry) in entries.enumerated() {
            if index > 0, entry.outcome == .ok, entry.itemCount == 0 { continue }
            let day = calendar.startOfDay(for: entry.time)
            let row = row(entry)
            if let last = days.last, last.id == day {
                days[days.count - 1] = SyncHistoryDay(id: day, title: last.title, rows: last.rows + [row])
            } else {
                days.append(SyncHistoryDay(id: day, title: dayText(day), rows: [row]))
            }
        }
        return days
    }

    func row(_ entry: SyncLogEntry) -> SyncHistoryRow {
        let time = entry.time.formatted(base().hour().minute())
        switch entry.outcome {
        case .error:
            return SyncHistoryRow(id: entry.seq, symbol: "exclamationmark.circle", title: triggerText(entry), detail: "\(time) · \(failureText(entry.errorCode))", count: nil, failed: true)
        case .skipped:
            return SyncHistoryRow(id: entry.seq, symbol: symbol(entry), title: triggerText(entry), detail: "\(time) · \(skipText(entry.errorCode))", count: nil, failed: false)
        case .deleted:
            return SyncHistoryRow(id: entry.seq, symbol: "trash", title: triggerText(entry), detail: time, count: nil, failed: false)
        case .ok, .partial, .interrupted:
            let detail = entry.history ? String(localized: "\(time) · last 6 months") : time
            let count = entry.itemCount == 0 ? String(localized: "Up to date") : String(localized: "\(entry.itemCount) readings")
            return SyncHistoryRow(id: entry.seq, symbol: symbol(entry), title: triggerText(entry), detail: detail, count: count, failed: false)
        }
    }

    /// How the sync came about, in words.
    func triggerText(_ entry: SyncLogEntry) -> String {
        if entry.outcome == .deleted { return String(localized: "Uploaded data deleted") }
        if entry.history { return String(localized: "History") }
        switch entry.trigger {
        case .observer: return String(localized: "Background")
        case .foreground: return String(localized: "Opened Rome")
        case .manual, .retry: return String(localized: "Sync now")
        case .backfill: return String(localized: "History")
        }
    }

    func symbol(_ entry: SyncLogEntry) -> String {
        if entry.history { return "clock.arrow.circlepath" }
        switch entry.trigger {
        case .observer: return "moon"
        case .foreground: return "iphone"
        case .manual, .retry: return "arrow.clockwise"
        case .backfill: return "clock.arrow.circlepath"
        }
    }

    func skipText(_ code: String?) -> String {
        switch code {
        case "locked": return String(localized: "Skipped · \(device.name) locked")
        case "no_access": return String(localized: "Skipped · no access to Health")
        default: return String(localized: "Skipped")
        }
    }

    func failureText(_ code: String?) -> String {
        switch code {
        case "signed_out": return String(localized: "Signed out of your Rome")
        case "network": return String(localized: "Couldn't reach your Rome")
        case "rate_limited": return String(localized: "Too many syncs, trying later")
        case "health_failed": return String(localized: "Couldn't read Health")
        default: return String(localized: "Your Rome couldn't take it")
        }
    }

    /// "Today", "Yesterday", or a date.
    func dayText(_ date: Date) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return String(localized: "Today") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "Yesterday")
        }
        let style = base().weekday(.wide).month(.abbreviated).day()
        return date.formatted(calendar.isDate(date, equalTo: now, toGranularity: .year) ? style : style.year())
    }

    private func base() -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }
}

struct SyncHistoryScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteFailed = false

    var body: some View {
        let health = model.health
        let days = SyncHistoryFormatter(device: model.node.device).days(health.history)
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if days.isEmpty {
                    empty
                }
                ForEach(days) { day in
                    SettingsGroup(header: LocalizedStringKey(day.title)) {
                        ForEach(Array(day.rows.enumerated()), id: \.element.id) { index, row in
                            SyncRowView(row: row, last: index == day.rows.count - 1)
                        }
                    }
                }
                if health.canSync {
                    deleteButton
                        .padding(.top, 14)
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
        .task { await health.reloadHistory() }
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

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
                .romeFont(30)
                .foregroundStyle(Palette.sub)
                .accessibilityHidden(true)
            Text("No syncs yet")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    /// Set apart at the bottom, as Sign out is in Settings.
    private var deleteButton: some View {
        SettingsGroup {
            Button { confirmDelete = true } label: {
                HStack(spacing: 8) {
                    Text("Delete uploaded data")
                        .romeFont(17)
                        .foregroundStyle(Palette.destructive)
                    if deleting { ProgressView().controlSize(.small) }
                }
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Rectangle())
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

/// A sync: its trigger's symbol in a tile, the trigger over the time, and the count.
private struct SyncRowView: View {
    let row: SyncHistoryRow
    let last: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: row.symbol)
                .romeFont(15)
                .foregroundStyle(row.failed ? Palette.destructive : Palette.fg)
                .frame(width: 30, height: 30)
                .background(Palette.secondaryFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.title)
                        .romeFont(17)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                    Text(verbatim: row.detail)
                        .romeFont(13)
                        .foregroundStyle(row.failed ? Palette.destructive : Palette.sub)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if let count = row.count {
                    Text(verbatim: count)
                        .romeFont(15, monospacedDigits: true)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            .padding(.vertical, 10)
            .frame(minHeight: 60)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
        }
        .padding(.horizontal, 14)
        .accessibilityElement(children: .combine)
    }
}

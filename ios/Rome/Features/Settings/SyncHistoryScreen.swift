import SwiftUI

// Apple Health → Sync history: Sync now, Pause and Delete uploaded data,
// then every sync of the last 30 days, one line each: when, how, and what
// it sent. Counts only, never a value. How the sync stands now is the
// Apple Health page's status line, not this page's.

/// One sync, as one line.
struct SyncHistoryLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let failed: Bool
}

struct SyncHistoryFormatter {
    var now: Date = Date()
    var calendar: Calendar = .current
    var locale: Locale = .current
    var device: DeviceKind = .iPhone

    /// Newest first. A sync that found nothing new and went well adds no
    /// line past the newest one, so the list shows what moved.
    func lines(_ entries: [SyncLogEntry]) -> [SyncHistoryLine] {
        entries.enumerated().compactMap { index, entry in
            if index > 0, entry.outcome == .ok, entry.itemCount == 0 { return nil }
            return line(entry)
        }
    }

    /// "Today 9:41 PM · Background · 7 readings".
    func line(_ entry: SyncLogEntry) -> SyncHistoryLine {
        let parts = [timeText(entry.time), triggerText(entry), resultText(entry)]
        return SyncHistoryLine(id: entry.seq, text: parts.joined(separator: " · "), failed: entry.outcome == .error)
    }

    /// How the sync came about, in words.
    func triggerText(_ entry: SyncLogEntry) -> String {
        if entry.outcome == .deleted { return String(localized: "Uploaded data deleted") }
        if entry.history { return String(localized: "History") }
        switch entry.trigger {
        case .observer: return String(localized: "Background")
        case .foreground: return String(localized: "Opened Rome")
        case .manual: return String(localized: "Sync now")
        case .backfill: return String(localized: "History")
        case .retry: return String(localized: "Retry")
        }
    }

    /// The result, with how many readings went.
    func resultText(_ entry: SyncLogEntry) -> String {
        switch entry.outcome {
        case .deleted: return String(localized: "Sync turned off")
        case .skipped: return skipText(entry.errorCode)
        case .error: return failureText(entry.errorCode)
        case .ok, .partial, .interrupted:
            var text = entry.itemCount == 0 ? String(localized: "Up to date") : String(localized: "\(entry.itemCount) readings")
            if entry.outcome == .partial { text += " · " + String(localized: "some not sent") }
            if entry.outcome == .interrupted { text += " · " + String(localized: "continues next time") }
            return text
        }
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

    /// "Today 9:41 PM", "Yesterday 7:02 AM", "Nov 3, 8:15 PM".
    func timeText(_ date: Date) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let time = date.formatted(style.hour().minute())
        if calendar.isDate(date, inSameDayAs: now) { return String(localized: "Today \(time)") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "Yesterday \(time)")
        }
        return "\(date.formatted(style.month(.abbreviated).day())), \(time)"
    }
}

struct SyncHistoryScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteFailed = false

    var body: some View {
        let health = model.health
        let lines = SyncHistoryFormatter(device: model.node.device).lines(health.history)
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                actions(health)
                if lines.isEmpty {
                    Text("No syncs yet")
                        .romeFont(15)
                        .foregroundStyle(Palette.sub)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)
                } else {
                    SettingsGroup {
                        ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                            SyncLineView(line: line, last: index == lines.count - 1)
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

private struct SyncLineView: View {
    let line: SyncHistoryLine
    let last: Bool

    var body: some View {
        Text(verbatim: line.text)
            .romeFont(14)
            .foregroundStyle(line.failed ? Palette.destructive : Palette.fg)
            // One line each, every one the same size: a long one is cut at its end.
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
            .accessibilityElement(children: .combine)
    }
}

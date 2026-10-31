import SwiftUI

/// Settings → current instance: every Rome on the account, the open one ticked.
struct InstancesScreen: View {
    let onSwitched: () -> Void
    @Environment(AppModel.self) private var model
    @State private var switching: String?
    @State private var stoppedNotice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeader(title: "Switch instance", inSheet: true)
                if model.instances.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(0..<3, id: \.self) { index in
                            SkeletonRow(last: index == 2)
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.instances.enumerated()), id: \.element.id) { index, instance in
                            row(instance, last: index == model.instances.count - 1)
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                }
                if let stoppedNotice {
                    Text(stoppedNotice)
                        .romeFont(13)
                        .foregroundStyle(Palette.destructive)
                        .padding(.horizontal, 20)
                        .transition(.opacity)
                }
                Text("Instances are managed in Rome Cloud.")
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 20)
            }
            .padding(.bottom, 32)
            .animation(.easeOut(duration: 0.2), value: stoppedNotice)
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task { await model.refreshInstances() }
    }

    private func row(_ instance: CloudInstance, last: Bool) -> some View {
        let current = instance.id == model.currentInstanceID
        return Button {
            guard !current, switching == nil else { return }
            guard instance.isRunning else {
                stoppedNotice = String(localized: "“\(instance.name)” is stopped. Start it in Rome Cloud, then open it here.")
                return
            }
            switching = instance.id
            Task {
                onSwitched()
                await model.switchInstance(to: instance)
                switching = nil
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(instance.name)
                        .romeFont(17, .semibold)
                        .foregroundStyle(Palette.fg)
                    Text(instance.host)
                        .romeFont(14)
                        .foregroundStyle(Palette.sub)
                }
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(instance.isRunning ? Palette.success : Palette.sub.opacity(0.4)).frame(width: 7, height: 7)
                    Text(instance.isRunning ? "Running" : "Stopped")
                        .romeFont(14)
                        .foregroundStyle(Palette.sub)
                }
                Group {
                    if switching == instance.id {
                        Spinner(size: 16, color: Palette.sub)
                    } else if current {
                        Image(systemName: "checkmark")
                            .romeFont(15, .bold)
                            .foregroundStyle(Palette.primary)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 20)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 60)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
            }
            .opacity(instance.isRunning ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

private struct SkeletonRow: View {
    let last: Bool
    @State private var pulse = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Palette.fill).frame(width: 96, height: 14)
                RoundedRectangle(cornerRadius: 4).fill(Palette.fill).frame(width: 140, height: 11)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 60)
        .opacity(pulse ? 0.5 : 1)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true }
        }
    }
}

/// Search across Chat and the task chats.
struct SearchScreen: View {
    let workspace: Workspace
    let onOpen: (SearchHit) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searching = false
    @State private var searched = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                GlassCircleButton(accessibilityLabel: "Back", action: { dismiss() }) {
                    Image(systemName: "chevron.left").romeFont(17, .semibold)
                }
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").romeFont(16, .medium).foregroundStyle(Palette.sub)
                    TextField("Search messages", text: $query)
                        .romeFont(17)
                        .focused($focused)
                        .submitLabel(.search)
                        .onSubmit { run() }
                    if !query.isEmpty {
                        Button { query = ""; hits = []; searched = false } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.sub)
                        }
                        .accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(Palette.elevated, in: Capsule())
                .softElevation(radius: 22)
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, 10)

            if searching {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            } else if searched && hits.isEmpty {
                Spacer()
                Text("No matching messages").romeFont(17, .semibold)
                Text("Try a different word.").romeFont(15).foregroundStyle(Palette.sub).padding(.top, 4)
                Spacer()
                Spacer()
            } else if !searched {
                Spacer()
                Text("Search messages in Chat and tasks").romeFont(15).foregroundStyle(Palette.sub)
                Spacer()
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                            Button { onOpen(hit) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(hit.session.id == conciergeChatID ? "Chat" : hit.session.name)
                                            .romeFont(13, .semibold)
                                            .foregroundStyle(Palette.sub)
                                            .lineLimit(1)
                                        Spacer()
                                        if let date = RomeDate.parse(hit.message.createdAt) {
                                            Text(RelativeTime.ago(date)).romeFont(12).foregroundStyle(Palette.sub)
                                        }
                                    }
                                    Text(highlighted(hit.message.snippet))
                                        .romeFont(16)
                                        .foregroundStyle(Palette.fg)
                                        .lineLimit(3)
                                        .multilineTextAlignment(.leading)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(alignment: .bottom) {
                                    if index < hits.count - 1 { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.immediately)
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .onAppear { focused = true }
        .task(id: query) {
            let trimmed = query.trimmingCharacters(in: .whitespaces)
            guard trimmed.count >= 2 else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            run()
        }
    }

    private func run() {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        searching = hits.isEmpty
        Task {
            let result = (try? await workspace.backend.search(trimmed)) ?? []
            hits = result
            searched = true
            searching = false
        }
    }

    private func highlighted(_ snippet: String) -> AttributedString {
        var text = AttributedString(MarkdownParser.plain(snippet))
        let needle = query.trimmingCharacters(in: .whitespaces)
        if !needle.isEmpty, let range = text.range(of: needle, options: .caseInsensitive) {
            text[range].foregroundColor = Palette.primaryText
            text[range].font = .system(size: 16, weight: .semibold)
        }
        return text
    }
}

/// The routines on this instance: what runs on its own, and when next.
struct RoutinesScreen: View {
    @Environment(AppModel.self) private var model
    @State private var routines: [Routine]?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeader(title: "Routines")
                Text("Work that runs on its own schedule. To add or change one, ask the Concierge in Chat.")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
                    .lineSpacing(4)
                    .padding(.horizontal, 20)
                    .padding(.top, -6)
                if let routines {
                    if routines.isEmpty {
                        Text("No routines yet")
                            .romeFont(17, .semibold)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(routines.enumerated()), id: \.element.id) { index, routine in
                                RoutineRow(routine: routine, last: index == routines.count - 1) { enabled in
                                    toggle(routine, enabled)
                                }
                            }
                        }
                        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                        .hairline(radius: Metrics.groupRadius)
                        .padding(.horizontal, 16)
                    }
                } else if failed {
                    CenteredMessage(title: "Could not load routines", detail: "Check the network and try again", actionTitle: "Try again") {
                        Task { await load() }
                    }
                    .frame(height: 320)
                } else {
                    Spinner(size: 20, color: Palette.sub).frame(maxWidth: .infinity).padding(.top, 60)
                }
            }
            .padding(.bottom, 32)
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task { await load() }
    }

    private func load() async {
        failed = false
        guard let backend = model.workspace?.backend else { return }
        do {
            routines = try await backend.routines().sorted { ($0.enabled ? 0 : 1, $0.name) < ($1.enabled ? 0 : 1, $1.name) }
        } catch {
            failed = true
        }
    }

    private func toggle(_ routine: Routine, _ enabled: Bool) {
        guard let index = routines?.firstIndex(where: { $0.id == routine.id }) else { return }
        routines?[index].enabled = enabled
        Task {
            do {
                try await model.workspace?.backend.setRoutine(routine.id, enabled: enabled)
            } catch {
                routines?[index].enabled = !enabled
            }
        }
    }
}

struct RoutineRow: View {
    let routine: Routine
    let last: Bool
    let onToggle: @MainActor @Sendable (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(RoutineText.title(routine.name))
                    .romeFont(17, .medium)
                    .foregroundStyle(Palette.fg)
                Text(RoutineText.schedule(routine))
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
            }
            Spacer()
            Toggle(isOn: Binding(get: { routine.enabled }, set: onToggle)) { EmptyView() }
                .labelsHidden()
                .tint(Palette.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
        }
        .accessibilityElement(children: .combine)
    }
}

enum RoutineText {
    /// `price_watch` → "Price watch"; names already in words stay as written.
    static func title(_ name: String) -> String {
        guard name.contains("_") || name == name.lowercased() else { return name }
        let words = name.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// "Daily 08:30 · Next: Tomorrow 08:30".
    static func schedule(_ routine: Routine) -> String {
        var parts: [String] = []
        if routine.trigger?["type"]?.string == "schedule" {
            let time = routine.trigger?["localTime"]?.string ?? ""
            let rule = routine.trigger?["rrule"]?.string ?? ""
            parts.append("\(frequency(rule)) \(time)".trimmingCharacters(in: .whitespaces))
        } else if let type = routine.trigger?["type"]?.string {
            parts.append(type == "event" ? String(localized: "On an event") : String(localized: "On a trigger"))
        }
        if !routine.enabled {
            parts.append(String(localized: "Paused"))
        } else if let next = RomeDate.parse(routine.nextRunAt) {
            parts.append(String(localized: "Next: \(RelativeTime.until(next))"))
        }
        return parts.joined(separator: " · ")
    }

    static func frequency(_ rule: String) -> String {
        let fields = Dictionary(rule.split(separator: ";").compactMap { part -> (String, String)? in
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            return pair.count == 2 ? (pair[0], pair[1]) : nil
        }, uniquingKeysWith: { a, _ in a })
        let interval = Int(fields["INTERVAL"] ?? "1") ?? 1
        switch fields["FREQ"] {
        case "DAILY": return interval > 1 ? String(localized: "Every \(interval) days") : String(localized: "Daily")
        case "WEEKLY":
            let byDay = (fields["BYDAY"] ?? "").split(separator: ",").compactMap { weekday(String($0)) }
            if !byDay.isEmpty {
                let list = byDay.joined(separator: String(localized: "routine.weekdaySeparator", defaultValue: ", ", comment: "Between weekdays in a weekly schedule"))
                return String(localized: "Weekly on \(list)")
            }
            return interval > 1 ? String(localized: "Every \(interval) weeks") : String(localized: "Weekly")
        case "HOURLY": return interval > 1 ? String(localized: "Every \(interval) hours") : String(localized: "Hourly")
        case "MONTHLY": return String(localized: "Monthly")
        default: return String(localized: "On a schedule")
        }
    }

    /// An RRULE `BYDAY` code as a schedule shows it: "Mon" in English, "一" in "每周一、五".
    private static func weekday(_ code: String) -> String? {
        switch code {
        case "MO": return String(localized: "Mon", comment: "Monday in a weekly schedule")
        case "TU": return String(localized: "Tue", comment: "Tuesday in a weekly schedule")
        case "WE": return String(localized: "Wed", comment: "Wednesday in a weekly schedule")
        case "TH": return String(localized: "Thu", comment: "Thursday in a weekly schedule")
        case "FR": return String(localized: "Fri", comment: "Friday in a weekly schedule")
        case "SA": return String(localized: "Sat", comment: "Saturday in a weekly schedule")
        case "SU": return String(localized: "Sun", comment: "Sunday in a weekly schedule")
        default: return nil
        }
    }
}

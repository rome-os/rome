import SwiftUI

/// The Agent page's Tasks tab: what runs for one Concierge chat, grouped as
/// Needs you, Active, Later, Running on its own and Ended. Each row is its
/// title and one line of state and time. A row does nothing when tapped: a
/// small icon after the title opens the task chat, a task that needs the
/// guardian shows Respond, and Stop and Open task chat are in the long-press
/// menu (docs/domains/chats.md#task-list).
struct TaskListView: View {
    let store: TaskListStore?
    /// Goes to the message in the chat that shows the card a task waits on.
    let onRespond: (TaskListItem.Task) -> Void
    let onOpenChat: (ConciergeTask.LinkedChat) -> Void

    @State private var endedOpen = false
    @State private var endedShown = TaskListStore.endedPage
    @State private var notice: String?

    var body: some View {
        // Times count down by the minute.
        TimelineView(.everyMinute) { context in
            content(now: context.date)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .top) {
            if let notice {
                TopBanner(kind: .error, text: notice)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: notice)
        .task(id: store?.failures) {
            guard let store, store.failures > 0 else { return }
            notice = store.failure
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            notice = nil
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        // A list read once stays up whatever a later read does; the failure
        // shows only when no list ever arrived.
        if let store, !store.loaded, store.groups.isEmpty {
            VStack {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            }
        } else if let store, store.loadFailed, store.groups.isEmpty {
            VStack {
                Spacer()
                Text("Failed to load tasks")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
                Spacer()
            }
        } else if let store, !store.groups.isEmpty {
            ScrollView {
                // Leading: a folded group, its header alone, keeps to the left
                // edge instead of centering on its own line.
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(store.groups) { group in
                        section(group, store: store, now: now)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
                .animation(.spring(response: 0.4, dampingFraction: 0.88), value: store.groups)
            }
            .scrollIndicators(.hidden)
        } else {
            empty
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Spacer()
            ChecklistGlyph(color: Palette.sub)
                .scaleEffect(1.2)
                .frame(width: 52, height: 52)
                .background(Palette.fillStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.bottom, 8)
            Text("No tasks yet")
                .romeFont(19, .semibold)
                .tracking(-0.4)
            Text("What you ask for in Chat appears here once it becomes a task.")
                .romeFont(15)
                .lineSpacing(4)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 52)
    }

    private func title(_ key: TaskListGroup.Key) -> LocalizedStringKey {
        switch key {
        case .needsYou: return "Needs you"
        case .active: return "Active"
        case .later: return "Later"
        case .onItsOwn: return "Running on its own"
        case .ended: return "Ended"
        }
    }

    private func section(_ group: TaskListGroup, store: TaskListStore, now: Date) -> some View {
        let folds = group.key == .ended
        let open = !folds || endedOpen
        let items = folds ? Array(group.items.prefix(endedShown)) : group.items
        let more = group.items.count - items.count
        return VStack(alignment: .leading, spacing: 8) {
            if folds {
                Button {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { endedOpen.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.right")
                            .romeFont(10, .bold)
                            .rotationEffect(.degrees(open ? 90 : 0))
                            .accessibilityHidden(true)
                        Text(title(group.key))
                        Text(verbatim: "\(group.items.count)").monospacedDigit().opacity(0.7)
                    }
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(open ? Text("Expanded") : Text("Collapsed"))
            } else {
                Text(title(group.key))
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 6)
                    .accessibilityAddTraits(.isHeader)
            }
            if open {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        row(item, store: store, now: now, last: index == items.count - 1 && more == 0)
                            .transition(.opacity)
                    }
                    if more > 0 {
                        Button {
                            withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { endedShown += TaskListStore.endedPage }
                        } label: {
                            Text("Show \(min(more, TaskListStore.endedPage)) more")
                                .romeFont(14)
                                .foregroundStyle(Palette.sub)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                    }
                }
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
            }
        }
    }

    @ViewBuilder
    private func row(_ item: TaskListItem, store: TaskListStore, now: Date, last: Bool) -> some View {
        switch item {
        case .task(let task):
            TaskListRow(
                item: task,
                stopping: store.stopping.contains(task.task.id),
                now: now,
                last: last,
                onRespond: { onRespond(task) },
                onStop: { store.stopTask(task.task.id) },
                onOpenChat: task.task.chat.map { chat in { onOpenChat(chat) } }
            )
        case .check(let check):
            TaskListPlainRow(title: check.check.name, line: TaskListWords.check(check, now: now), created: item.createdAt, last: last)
        case .follow(let follow):
            TaskListPlainRow(title: follow.target, line: TaskListWords.follow(follow), created: item.createdAt, dimmed: follow.state != "active", last: last)
        case .routine(let routine):
            TaskListPlainRow(
                title: routine.name,
                line: TaskListWords.routine(routine, now: now),
                created: item.createdAt,
                failed: routine.lastRun?.status == "error",
                dimmed: !routine.enabled,
                last: last
            )
        }
    }
}

/// A row with nothing to press: a check, a follow or a routine. They change
/// by asking Chat, on the web's Routines page or in settings.
struct TaskListPlainRow: View {
    let title: String
    let line: String
    let created: Date?
    var failed = false
    var dimmed = false
    let last: Bool

    var body: some View {
        TaskListRowFrame(last: last) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: title)
                    .romeFont(16, .medium)
                    .tracking(-0.3)
                    .foregroundStyle(dimmed ? Palette.sub : Palette.fg)
                    .lineLimit(2)
                if !line.isEmpty {
                    Text(verbatim: line)
                        .romeFont(13)
                        .foregroundStyle(failed ? Palette.destructive : Palette.sub)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Long-pressed, it says when it was made, and offers nothing else.
        .contextMenu {
            if let created { Text(verbatim: TaskListWords.created(created)) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A task's row: its title with a small way into its task chat, its line,
/// and Respond while it needs the guardian. Stop and Open task chat are in
/// the long-press menu; nothing asks to confirm, and a press shows at once.
struct TaskListRow: View {
    let item: TaskListItem.Task

    private var created: Date? { TaskListItem.task(item).createdAt }
    let stopping: Bool
    let now: Date
    let last: Bool
    let onRespond: () -> Void
    let onStop: () -> Void
    let onOpenChat: (() -> Void)?

    private var status: String { TaskListWords.status(item.task) }
    /// Stop on every task that has not ended; a scheduled one loses its schedule.
    private var stops: Bool { status != "ended" && !stopping }

    var body: some View {
        TaskListRowFrame(last: last) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(verbatim: item.task.title)
                            .romeFont(16, .medium)
                            .tracking(-0.3)
                            .foregroundStyle(status == "ended" ? Palette.sub : Palette.fg)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let onOpenChat {
                            Button(action: onOpenChat) {
                                Image(systemName: "bubble.left")
                                    .romeFont(12)
                                    .foregroundStyle(Palette.sub)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.vertical, -8)
                            .accessibilityLabel(Text("Open task chat"))
                        }
                    }
                    Text(verbatim: TaskListWords.task(item, now: now, stopping: stopping))
                        .romeFont(13)
                        .foregroundStyle(status == "needs_you" && !stopping ? Palette.warningText : Palette.sub)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if status == "needs_you", !stopping {
                    // An icon, as on the web: goes to the card in Chat.
                    Button(action: onRespond) {
                        Image(systemName: "arrow.up.forward")
                            .romeFont(18, .medium)
                            .foregroundStyle(Palette.fg)
                            .frame(width: 34, height: 34)
                            .background(Palette.fillStrong, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .padding(.vertical, -6)
                    .accessibilityLabel(Text("Respond"))
                }
            }
        }
        // Titled with when the task was made, as a message's menu is with its time.
        .contextMenu {
            if stops || onOpenChat != nil {
                Section {
                    if stops {
                        Button(role: .destructive, action: onStop) { Label("Stop", systemImage: "stop.circle") }
                    }
                    if let onOpenChat {
                        Button(action: onOpenChat) { Label("Open task chat", systemImage: "bubble.left") }
                    }
                } header: {
                    if let created { Text(verbatim: TaskListWords.created(created)) }
                }
            } else if let created {
                Text(verbatim: TaskListWords.created(created))
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// The frame every row of the list shares: padding and the hairline under it.
private struct TaskListRowFrame<Content: View>: View {
    let last: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.vertical, 12)
            .padding(.leading, 16)
            .padding(.trailing, 12)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
            }
            .background(Palette.elevated)
            .contentShape(Rectangle())
    }
}

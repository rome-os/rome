import SwiftUI

/// The Agent page's Tasks tab: what runs for one Concierge chat, in two tabs.
/// Tasks lists its task chats, grouped as Needs you, Active, Later and Ended;
/// Running on its own lists what is no task chat, in one list by the time each
/// runs next. A task chat's row is its name and one line of state and time,
/// opens the chat when tapped, and has Stop in its long-press menu. A dot on
/// the Tasks tab says one needs its owner (docs/domains/chats.md#task-list).
struct TaskListView: View {
    let store: TaskListStore?
    let onOpenChat: (ConciergeTask.LinkedChat) -> Void

    private enum Tab { case tasks, auto }
    @State private var tab = Tab.tasks
    @State private var endedOpen = false

    var body: some View {
        // Times count down by the minute.
        TimelineView(.everyMinute) { context in
            content(now: context.date)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The store owns the notice and clears it: nothing replays it when
        // the tab appears again.
        .overlay(alignment: .top) {
            if let notice = store?.failure {
                TopBanner(kind: .error, text: notice)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: store?.failure)
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
        } else if let store {
            let tasks = store.groups.filter { $0.key != .onItsOwn }
            let onItsOwn = store.groups.first { $0.key == .onItsOwn }?.items ?? []
            VStack(spacing: 0) {
                tabs(needsYou: store.groups.contains { $0.key == .needsYou })
                ScrollView {
                    // Leading: a folded group, its header alone, keeps to the left
                    // edge instead of centering on its own line.
                    VStack(alignment: .leading, spacing: 18) {
                        if tab == .auto {
                            if onItsOwn.isEmpty {
                                emptyLine("Nothing runs on its own.")
                            } else {
                                VStack(spacing: 0) {
                                    ForEach(Array(onItsOwn.enumerated()), id: \.element.id) { index, item in
                                        row(item, store: store, now: now, last: index == onItsOwn.count - 1)
                                    }
                                }
                                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                                .hairline(radius: Metrics.groupRadius)
                            }
                        } else if tasks.isEmpty {
                            emptyLine("No tasks yet")
                        } else {
                            ForEach(tasks) { group in
                                section(group, store: store, now: now)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                    .animation(.spring(response: 0.4, dampingFraction: 0.88), value: store.groups)
                }
                .scrollIndicators(.hidden)
            }
        } else {
            empty
        }
    }

    /// The two tabs, a segmented control; a dot on Tasks while a task chat needs its owner.
    private func tabs(needsYou: Bool) -> some View {
        HStack(spacing: 2) {
            tabButton(.tasks, title: "Tasks", dot: needsYou)
            tabButton(.auto, title: "Running on its own", dot: false)
        }
        .padding(2)
        .background(Palette.fill, in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private func tabButton(_ value: Tab, title: LocalizedStringKey, dot: Bool) -> some View {
        Button { tab = value } label: {
            Text(title)
                .romeFont(14, tab == value ? .semibold : .regular)
                .foregroundStyle(tab == value ? Palette.fg : Palette.sub)
                .padding(.horizontal, 14)
                .frame(minHeight: 32)
                .background { if tab == value { Capsule().fill(Palette.elevated) } }
                .overlay(alignment: .topTrailing) {
                    if dot {
                        Circle().fill(Palette.primaryText).frame(width: 6, height: 6)
                            .padding(.top, 6).padding(.trailing, 6)
                            .accessibilityLabel(Text("A task needs you"))
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(tab == value ? [.isSelected] : [])
    }

    private func emptyLine(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .romeFont(15)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity)
            .padding(.top, 40)
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
        // Ended is paged by the server: its first page, then the pages read since.
        let items = folds ? store.endedItems : group.items
        let more = folds ? store.endedMore : 0
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
                        Text(verbatim: "\(folds ? store.endedTotal : group.items.count)").monospacedDigit().opacity(0.7)
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
                        Button { store.showMoreEnded() } label: {
                            Group {
                                if store.loadingMore {
                                    Spinner(size: 16, color: Palette.sub)
                                } else {
                                    Text("Show \(min(more, TaskListStore.endedPage)) more")
                                        .romeFont(14)
                                        .foregroundStyle(Palette.sub)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                        .disabled(store.loadingMore)
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
                onStop: { store.stopTask(task.task.id) },
                onOpenChat: task.task.chat.map { chat in { onOpenChat(chat) } }
            )
        case .check(let check):
            TaskListPlainRow(title: check.check.name, line: TaskListWords.check(check, now: now), created: item.createdAt, last: last)
        case .follow(let listed):
            let follow = store.shown(listed)
            TaskListPlainRow(title: follow.target, line: TaskListWords.follow(follow, now: now), created: item.createdAt, dimmed: follow.state != "active", last: last)
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

/// A task chat's row: its status mark, its name and one line of state and
/// time. Tapping it opens the task chat; Stop is in the long-press menu, and
/// nothing asks to confirm.
struct TaskListRow: View {
    let item: TaskListItem.Task

    private var created: Date? { TaskListItem.task(item).createdAt }
    let stopping: Bool
    let now: Date
    let last: Bool
    let onStop: () -> Void
    let onOpenChat: (() -> Void)?

    private var status: String { TaskListWords.status(item.task) }
    /// Stop on every task that has not ended; a scheduled one loses its schedule.
    private var stops: Bool { status != "ended" && !stopping }

    var body: some View {
        Button { onOpenChat?() } label: {
            TaskListRowFrame(last: last) {
                HStack(spacing: 10) {
                    TaskStatusMark(task: item.task)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: item.task.title)
                            .romeFont(16, .medium)
                            .tracking(-0.3)
                            .foregroundStyle(status == "ended" ? Palette.sub : Palette.fg)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(verbatim: TaskListWords.task(item, now: now, stopping: stopping))
                            .romeFont(13)
                            .foregroundStyle(status == "needs_you" && !stopping ? Palette.warningText : Palette.sub)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .buttonStyle(RowPressStyle())
        .disabled(onOpenChat == nil)
        // Titled with when the task was made, as a message's menu is with its time.
        .contextMenu {
            if stops {
                Section {
                    Button(role: .destructive, action: onStop) { Label("Stop", systemImage: "stop.circle") }
                } header: {
                    if let created { Text(verbatim: TaskListWords.created(created)) }
                }
            } else if let created {
                Text(verbatim: TaskListWords.created(created))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The mark of a task's status at a row's leading edge, the set the task link
/// chip uses: needs you an alert, active the running ring, later a clock, and
/// done, failed, stopped and no response each a circle of their own.
struct TaskStatusMark: View {
    let task: ConciergeTask

    var body: some View {
        let status = TaskListWords.status(task)
        Group {
            if status == "active" {
                Spinner(size: 16, color: Palette.sub)
            } else {
                Image(systemName: TaskLinkInfo(id: task.id, name: task.title, status: status, endReason: task.endReason).symbol)
                    .romeFont(16)
                    .foregroundStyle(status == "needs_you" ? Palette.warning : Palette.sub)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
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

import SwiftUI

/// The Agent page's Tasks tab: everything that runs for one Concierge chat,
/// in the web panel's groups: Needs you, Active, Later, Scheduled and Ended,
/// empty ones left out. Each row is its name and one line of state and time;
/// a task chat's row opens the chat when tapped. A row's long-press menu acts
/// on it (`TaskListAction`), and Delete and Unfollow ask first
/// (docs/domains/chats.md#task-list).
struct TaskListView: View {
    let store: TaskListStore?
    let onOpenChat: (ConciergeTask.LinkedChat) -> Void
    @State private var endedOpen = false
    /// The action waiting on its alert.
    @State private var confirming: TaskListConfirm?

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
        .alert(
            confirming?.title ?? "",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            presenting: confirming
        ) { asked in
            Button(asked.button, role: .destructive) { store?.perform(asked.action, on: asked.item) }
            Button("Cancel", role: .cancel) {}
        } message: { asked in
            Text(verbatim: asked.message)
        }
    }

    /// Runs `action` from `item`'s menu, or asks first where it cannot be undone.
    private func run(_ action: TaskListAction, on item: TaskListItem) {
        if action.confirms {
            confirming = TaskListConfirm(action: action, item: item)
        } else {
            store?.perform(action, on: item)
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
        } else if let store {
            ScrollView {
                // Leading: a folded group, its header alone, keeps to the left
                // edge instead of centering on its own line.
                VStack(alignment: .leading, spacing: 18) {
                    if store.groups.isEmpty {
                        emptyLine("No tasks yet")
                    } else {
                        ForEach(store.groups) { group in
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
        } else {
            empty
        }
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
        case .scheduled: return "Scheduled"
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
        let pending = store.pending[item.id]
        // Nothing more is offered while an action is under way.
        let actions = pending == nil ? TaskListAction.menu(for: item) : []
        let onAction = { (action: TaskListAction) in run(action, on: item) }
        switch item {
        case .task(let task):
            TaskListRow(
                item: task,
                pending: pending,
                actions: actions,
                now: now,
                last: last,
                onAction: onAction,
                onOpenChat: task.task.chat.map { chat in { onOpenChat(chat) } }
            )
        case .check(let check):
            TaskListPlainRow(
                symbol: "clock",
                title: check.check.name,
                line: pending.map(TaskListWords.pending) ?? TaskListWords.check(check, now: now),
                created: item.createdAt,
                actions: actions,
                last: last,
                onAction: onAction
            )
        case .follow(let listed):
            let follow = store.shown(listed)
            TaskListPlainRow(
                symbol: "dot.radiowaves.left.and.right",
                title: follow.target,
                line: pending.map(TaskListWords.pending) ?? TaskListWords.follow(follow, now: now),
                created: item.createdAt,
                dimmed: follow.state != "active",
                actions: actions,
                last: last,
                onAction: onAction
            )
        case .routine(let routine):
            TaskListPlainRow(
                symbol: "flowchart",
                title: routine.name,
                line: pending.map(TaskListWords.pending) ?? TaskListWords.routine(routine, now: now),
                created: item.createdAt,
                failed: routine.lastRun?.status == "error" && pending == nil,
                dimmed: !routine.enabled,
                actions: actions,
                last: last,
                onAction: onAction
            )
        }
    }
}

/// An action that asks first, with the alert's words.
struct TaskListConfirm: Identifiable {
    let action: TaskListAction
    let item: TaskListItem

    var id: String { item.id }

    var title: String {
        switch item {
        case .routine(let routine): return String(localized: "Delete “\(routine.name)”?")
        case .follow(let follow): return String(localized: "Unfollow \(follow.target)?")
        default: return ""
        }
    }

    var message: String {
        action == .delete
            ? String(localized: "It stops running and is removed. This cannot be undone.")
            : String(localized: "Its alerts and digest entries stop coming here. To follow it again, ask Chat.")
    }

    var button: LocalizedStringKey { action == .delete ? "Delete" : "Unfollow" }
}

/// The long-press menu every row shares: titled with when its work was made,
/// as a message's menu is with its time, then the row's actions.
private struct TaskListRowMenu: View {
    let created: Date?
    let actions: [TaskListAction]
    let onAction: (TaskListAction) -> Void

    var body: some View {
        if actions.isEmpty {
            if let created { Text(verbatim: TaskListWords.created(created)) }
        } else {
            Section {
                ForEach(actions, id: \.self) { action in
                    Button(role: action.destructive ? .destructive : nil) { onAction(action) } label: {
                        Label(action.label, systemImage: action.symbol)
                    }
                }
            } header: {
                if let created { Text(verbatim: TaskListWords.created(created)) }
            }
        }
    }
}

extension TaskListAction {
    /// The menu item's words, as the web's row menu says them.
    var label: LocalizedStringKey {
        switch self {
        case .markDone: return "Mark as done"
        case .stop: return "Stop"
        case .cancel: return "Cancel"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .delete: return "Delete"
        case .unfollow: return "Unfollow"
        }
    }

    var symbol: String {
        switch self {
        case .markDone: return "checkmark.circle"
        case .stop: return "stop.circle"
        case .cancel: return "xmark.circle"
        case .pause: return "pause.circle"
        case .resume: return "play.circle"
        case .delete: return "trash"
        case .unfollow: return "minus.circle"
        }
    }

    /// Red in the menu: it ends work for good.
    var destructive: Bool { self == .stop || self == .delete }
}

/// A row that opens nothing: a reminder, a follow or a routine. Its actions
/// are in its long-press menu.
struct TaskListPlainRow: View {
    /// The SF Symbol of its kind, in the slot a task row's status mark takes,
    /// so every row's title starts on one line: a reminder a clock, a follow
    /// radio waves, a routine a flowchart, as the web's Clock, Radio and Workflow.
    let symbol: String
    let title: String
    let line: String
    let created: Date?
    var failed = false
    var dimmed = false
    var actions: [TaskListAction] = []
    let last: Bool
    var onAction: (TaskListAction) -> Void = { _ in }

    var body: some View {
        TaskListRowFrame(last: last) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .romeFont(16)
                    .foregroundStyle(Palette.sub)
                    // A paused routine or an unavailable follow fades its glyph too.
                    .opacity(dimmed ? 0.5 : 1)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
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
        }
        .contextMenu {
            TaskListRowMenu(created: created, actions: actions, onAction: onAction)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A task chat's row: its status mark, its name and one line of state and
/// time. Tapping it opens the task chat; Mark as done and Stop are in the
/// long-press menu, and nothing asks to confirm.
struct TaskListRow: View {
    let item: TaskListItem.Task

    private var created: Date? { TaskListItem.task(item).createdAt }
    let pending: TaskListAction?
    let actions: [TaskListAction]
    let now: Date
    let last: Bool
    let onAction: (TaskListAction) -> Void
    let onOpenChat: (() -> Void)?

    private var status: String { TaskListWords.status(item.task) }

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
                        Text(verbatim: TaskListWords.task(item, now: now, pending: pending))
                            .romeFont(13)
                            .foregroundStyle(status == "needs_you" && pending == nil ? Palette.warningText : Palette.sub)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .buttonStyle(RowPressStyle())
        .disabled(onOpenChat == nil)
        .contextMenu {
            TaskListRowMenu(created: created, actions: actions, onAction: onAction)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The mark of a task's status at a row's leading edge, the set and colours
/// the task link chip uses: needs you an alert, active the running ring, later
/// a clock, and done, failed, stopped and no response each a circle of their own.
struct TaskStatusMark: View {
    let task: ConciergeTask

    var body: some View {
        let info = TaskLinkInfo(id: task.id, name: task.title, status: TaskListWords.status(task), endReason: task.endReason)
        Group {
            if info.tone == .running {
                Spinner(size: 16, color: info.tone.color)
            } else {
                Image(systemName: info.symbol)
                    .romeFont(16)
                    .foregroundStyle(info.tone.color)
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

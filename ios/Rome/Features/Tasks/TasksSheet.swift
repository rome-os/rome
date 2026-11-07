import SwiftUI

/// Board 5: the Concierge's tasks, grouped by what they need from the guardian.
struct TasksSheet: View {
    let store: TasksStore
    /// The Concierge chat whose tasks it lists: the main chat or a topic chat.
    let chatId: String
    let onOpen: (ConciergeTask) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showAllDone = false

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.grabber)
                .frame(width: 36, height: 5)
                .padding(.top, 7)
            HStack {
                Text("Tasks")
                    .romeFont(24, .bold)
                    .tracking(-0.6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 54)

            let groups = store.groups(inChat: chatId, showAllDone: showAllDone)
            if !store.loaded {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            } else if groups.isEmpty {
                empty
            } else {
                ScrollView {
                    VStack(spacing: 18) {
                        ForEach(groups) { group in
                            groupView(group)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                    .animation(.spring(response: 0.4, dampingFraction: 0.88), value: store.tasks.map(\.id))
                    .animation(.spring(response: 0.4, dampingFraction: 0.88), value: store.tasks.map(\.state))
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(Palette.sheet.ignoresSafeArea())
        .task { await store.refresh() }
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

    private func groupView(_ group: TaskGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(group.key.title)
                .romeFont(13, .semibold)
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 6)
                .accessibilityAddTraits(.isHeader)

            if !group.tasks.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(group.tasks.enumerated()), id: \.element.id) { index, task in
                        TaskRow(
                            task: task,
                            status: store.rowStatus(task),
                            last: index == group.tasks.count - 1
                        ) { onOpen(task) }
                        .transition(.opacity)
                    }
                }
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
            }
            if group.hidden > 0 || (group.key == .done && showAllDone) {
                Button(showAllDone ? "Show less" : "Show \(group.hidden) older") {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { showAllDone.toggle() }
                }
                .romeFont(14, .semibold)
                .foregroundStyle(Palette.primaryText)
                .padding(.horizontal, 6)
                .padding(.top, 2)
            }
        }
    }

}

/// One task: its title and one muted line. A task waiting on the guardian has
/// a small dot before its title.
struct TaskRow: View {
    let task: ConciergeTask
    let status: TaskRowStatus
    let last: Bool
    let action: () -> Void

    private var tappable: Bool { task.chat != nil || task.sourceMessageId != nil }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        if status == .waiting {
                            Circle()
                                .fill(Palette.sub)
                                .frame(width: 6, height: 6)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                                .accessibilityHidden(true)
                        }
                        Text(task.title)
                            .romeFont(16, .medium)
                            .tracking(-0.3)
                            .foregroundStyle(Palette.fg)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    let line = TasksStore.rowLine(task, status: status, now: .now)
                    if !line.isEmpty {
                        Text(line)
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if tappable {
                    Image(systemName: "chevron.right")
                        .romeFont(11, .bold)
                        .foregroundStyle(Palette.sub)
                }
            }
            .padding(.vertical, 12)
            .padding(.leading, 16)
            .padding(.trailing, 12)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .disabled(!tappable)
        .accessibilityElement(children: .combine)
        .accessibilityHint(task.chat != nil ? String(localized: "Opens the task chat.") : (task.sourceMessageId != nil ? String(localized: "Shows the message in Chat.") : ""))
    }
}

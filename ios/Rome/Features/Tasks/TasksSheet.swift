import SwiftUI

/// Board 5: the Concierge's tasks, grouped by what they need from the guardian.
struct TasksSheet: View {
    let store: TasksStore
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
                Text("任务")
                    .romeFont(24, .bold)
                    .tracking(-0.6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 54)

            let groups = store.groups(showAllDone: showAllDone)
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
            Text("还没有任务")
                .romeFont(19, .semibold)
                .tracking(-0.4)
            Text("在 Chat 里交代的事，开成任务后会出现在这里。")
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
            HStack(spacing: 7) {
                Circle().fill(group.key.tone == .neutral ? Palette.sub.opacity(0.6) : group.key.tone.dot).frame(width: 7, height: 7)
                Text(group.key.title)
                Text("\(group.tasks.count + group.hidden)").fontWeight(.medium).opacity(0.8)
            }
            .romeFont(13, .semibold)
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 6)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            if !group.tasks.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(group.tasks.enumerated()), id: \.element.id) { index, task in
                        TaskRow(
                            task: task,
                            tone: tone(for: task),
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
                Button(showAllDone ? "收起" : "显示更早的 \(group.hidden) 项") {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { showAllDone.toggle() }
                }
                .romeFont(14, .semibold)
                .foregroundStyle(Palette.primaryText)
                .padding(.horizontal, 6)
                .padding(.top, 2)
            }
        }
    }

    private func tone(for task: ConciergeTask) -> TaskTone {
        switch task.state {
        case .needsUser: return .needsYou
        case .doing:
            if let chatId = task.chat?.id, store.chats[chatId]?.lastTurnFailed == true, store.chats[chatId]?.running != true {
                return .failed
            }
            return .running
        case .done: return .done
        case .next, .watching, .dropped: return .neutral
        }
    }
}

struct TaskRow: View {
    let task: ConciergeTask
    let tone: TaskTone
    let last: Bool
    let action: () -> Void

    private var tappable: Bool { task.chat != nil || task.sourceMessageId != nil }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                glyph
                    .frame(width: 22)
                    .padding(.top, 14)
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(task.title)
                            .romeFont(16, .medium)
                            .tracking(-0.3)
                            .foregroundStyle(Palette.fg)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if !meta.isEmpty {
                            Text(meta)
                                .romeFont(13)
                                .foregroundStyle(metaColor)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
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
                .overlay(alignment: .bottom) {
                    if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .disabled(!tappable)
        .accessibilityElement(children: .combine)
        .accessibilityHint(task.chat != nil ? "打开任务对话" : (task.sourceMessageId != nil ? "在 Chat 里查看" : ""))
    }

    @ViewBuilder
    private var glyph: some View {
        switch task.state {
        case .next:
            Circle()
                .strokeBorder(Palette.sub, style: StrokeStyle(lineWidth: 1.6, dash: [2.6, 2.4]))
                .frame(width: 18, height: 18)
                .accessibilityLabel("接下来")
        case .watching:
            Image(systemName: "eye")
                .romeFont(10, .bold)
                .foregroundStyle(Palette.sub)
                .frame(width: 18, height: 18)
                .overlay(Circle().strokeBorder(Palette.sub, lineWidth: 1.6))
                .accessibilityLabel("盯着")
        case .dropped:
            Image(systemName: "minus")
                .romeFont(9, .heavy)
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Palette.sub, in: Circle())
                .accessibilityLabel("已放下")
        default:
            StatusGlyph(tone: tone)
        }
    }

    private var meta: String {
        let now = Date.now
        var parts: [String] = []
        switch task.state {
        case .needsUser:
            parts.append(task.waitingOn ?? task.summary ?? "等你处理")
            if let date = RomeDate.fromMillis(task.updatedAt) { parts.append(RelativeTime.ago(date, now: now)) }
        case .doing:
            parts.append(tone == .failed ? "失败" : (task.summary ?? "进行中"))
        case .next, .watching:
            if let summary = task.summary { parts.append(summary) }
            if let due = RomeDate.fromMillis(task.dueAt) { parts.append(RelativeTime.until(due, now: now)) }
        case .done, .dropped:
            parts.append(task.summary ?? (task.state == .done ? "已完成" : "已放下"))
            if let date = RomeDate.fromMillis(task.completedAt ?? task.updatedAt) { parts.append(RelativeTime.ago(date, now: now)) }
        }
        if task.notSynced == true { parts.append("未同步") }
        return parts.joined(separator: " · ")
    }

    private var metaColor: Color {
        switch tone {
        case .needsYou: return Palette.warningText
        case .running: return Palette.runningText
        case .failed: return Palette.destructive
        default: return Palette.sub
        }
    }
}

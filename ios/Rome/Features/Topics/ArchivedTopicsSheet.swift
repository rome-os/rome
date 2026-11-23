import SwiftUI

/// The archived topic chats, in the sheet the drawer's Archived button
/// opens: latest activity first, grouped by week and month, a page at a time
/// as in the drawer. A row opens its chat, read only; a swipe or a press and
/// hold restores or deletes it.
struct ArchivedTopicsSheet: View {
    let workspace: Workspace
    /// A row was tapped: the sheet closes, then the chat opens.
    let onOpen: (String) -> Void
    /// A chat was deleted from the sheet: the shell leaves it if it is open.
    var onDeleted: (String) -> Void = { _ in }
    @State private var limit = TopicChatsStore.pageSize
    @State private var restoring: TopicRestoreRequest?
    @State private var deleting: TopicRetireRequest?

    private var store: ArchivedTopicsStore { workspace.archivedTopics }

    /// A second Unarchive or Delete while the first is read starts no other.
    private func restore(_ chat: ConciergeChat) {
        guard restoring == nil, deleting == nil else { return }
        restoring = TopicRestoreRequest(chatId: chat.id, name: TopicChatsStore.title(chat))
    }

    private func delete(_ chat: ConciergeChat) {
        guard restoring == nil, deleting == nil else { return }
        deleting = TopicRetireRequest(chatId: chat.id, name: TopicChatsStore.title(chat), action: .delete)
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Archived")
                .romeFont(17, .semibold)
                .foregroundStyle(Palette.fg)
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity)
                .padding(.top, 20)
                .padding(.bottom, 10)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.sheet)
        .topicRestore($restoring, workspace: workspace)
        .topicRetire($deleting, workspace: workspace, onRetired: onDeleted)
        .onAppear { store.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        let chats = store.chats
        if chats.isEmpty {
            Spacer()
            if store.loaded {
                Text("No archived chats")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
            } else {
                Spinner(size: 22, color: Palette.sub)
            }
            Spacer()
        } else {
            let shown = TopicChatsStore.shownCount(chats.count, limit: limit, openIndex: nil)
            let groups = ArchivedTopicsStore.groups(Array(chats.prefix(shown)), lastActive: store.lastActive)
            List {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.chats) { chat in
                            row(chat)
                        }
                    } header: {
                        ArchivedGroupHeader(period: group.period)
                    }
                }
                if shown < chats.count {
                    // A new view for each page, so an end still in view
                    // after a page lands asks for the next one.
                    Color.clear
                        .frame(height: 1)
                        .id(shown)
                        .onAppear { limit = shown + TopicChatsStore.pageSize }
                        .accessibilityHidden(true)
                        .sheetRow()
                }
            }
            // One rounded card per group, with hairlines between its rows.
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .environment(\.defaultMinListRowHeight, 1)
            .scrollContentBackground(.hidden)
            // Right under the title: the grouped list's own top margin is far taller.
            .contentMargins(.top, 0, for: .scrollContent)
            .contentMargins(.bottom, 14, for: .scrollContent)
        }
    }

    private func row(_ chat: ConciergeChat) -> some View {
        ArchivedTopicRow(chat: chat, lastActive: store.lastActive[chat.id]) { onOpen(chat.id) }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Palette.elevated)
            .listRowSeparatorTint(Palette.hair)
            // Unarchive, which a full swipe takes, then Delete, which
            // only a tap takes and which always asks. Not the
            // destructive role, which drops the row before the
            // guardian has answered.
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button { restore(chat) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }
                    .tint(Palette.primary)
                Button { delete(chat) } label: { Label("Delete", systemImage: "trash") }
                    .tint(Palette.destructive)
            }
            .contextMenu {
                Button { restore(chat) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }
                Button(role: .destructive) { delete(chat) } label: { Label("Delete", systemImage: "trash") }
            }
    }
}

/// A group's label, above its card, aligned with the rows' text.
private struct ArchivedGroupHeader: View {
    let period: ArchivedTopicGroup.Period

    var body: some View {
        Group {
            switch period {
            case .thisWeek: Text("This week")
            case .earlierThisMonth: Text("Earlier this month")
            case .month(let start): Text(verbatim: RelativeTime.month(start))
            case .undated: Text("Earlier")
            }
        }
        .romeFont(13, .medium)
        .foregroundStyle(Palette.sub)
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One archived topic chat: its name, then when it was last active.
private struct ArchivedTopicRow: View {
    let chat: ConciergeChat
    let lastActive: Date?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: TopicChatsStore.title(chat))
                        .romeFont(16)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                    if let lastActive {
                        Text("Last active \(RelativeTime.moment(lastActive))")
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityIdentifier("archived-topic-chat")
    }
}

private extension View {
    /// A sheet list row with nothing of the List's own: no inset, separator
    /// or background.
    func sheetRow() -> some View {
        listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

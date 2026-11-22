import SwiftUI

/// The archived topic chats, in the sheet the drawer's "Archived · N" row
/// opens: latest activity first, a page at a time as in the drawer. A row
/// opens its chat, read only; a swipe or a press and hold restores or
/// deletes it.
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
            List {
                ForEach(chats.prefix(shown)) { chat in
                    ArchivedTopicRow(chat: chat) { onOpen(chat.id) }
                        .sheetRow()
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
            .listStyle(.plain)
            .listRowSpacing(2)
            .environment(\.defaultMinListRowHeight, 1)
            .scrollContentBackground(.hidden)
            .contentMargins(.horizontal, 14, for: .scrollContent)
            .contentMargins(.bottom, 14, for: .scrollContent)
        }
    }
}

/// One archived topic chat: its name, as a drawer row draws it.
private struct ArchivedTopicRow: View {
    let chat: ConciergeChat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(verbatim: TopicChatsStore.title(chat))
                    .romeFont(16)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            // In the sheet's own color, so a swiped row covers what is under it.
            .background(Palette.sheet, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityIdentifier("archived-topic-chat")
    }
}

/// The drawer's last row under the topic chats: how many are archived. It
/// opens the Archived sheet.
struct ArchivedTopicsEntry: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "archivebox")
                    .romeFont(14)
                    .accessibilityHidden(true)
                Text("Archived · \(count)")
                    .romeFont(15)
                Spacer(minLength: 0)
            }
            // Quieter than the topic rows above it.
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityIdentifier("archived-topic-chats")
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

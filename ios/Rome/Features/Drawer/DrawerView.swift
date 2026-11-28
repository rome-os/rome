import SwiftUI

/// Board 2: search, Chat, Apps (for the guardian), the topic chats, and the account row.
struct DrawerView: View {
    let workspace: Workspace
    @Environment(AppModel.self) private var model
    let section: MainSection
    let onSection: (MainSection) -> Void
    let onNewTopic: () -> Void
    let onSettings: () -> Void
    /// A topic chat was archived or deleted from its row.
    var onTopicGone: (String) -> Void = { _ in }
    /// How many topic chats show; a scroll near the end adds a page.
    @State private var topicLimit = TopicChatsStore.pageSize
    @State private var olderLimit = TopicChatsStore.pageSize
    @State private var archivedLimit = TopicChatsStore.pageSize
    /// Archive or Delete from a row, while it is read and asked.
    @State private var retiring: TopicRetireRequest?
    /// Unarchive from an archived row's menu, while it is read and asked.
    @State private var restoring: TopicRestoreRequest?
    /// Rename from a row's menu, while its alert is up.
    @State private var renaming: TopicRenameRequest?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var folded: Bool { workspace.topics.folded }
    private var unread: Int { workspace.topics.unreadCount }

    private func toggleFold() {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
            workspace.topics.setFolded(!folded)
        }
    }

    private var foldValue: Text {
        guard folded else { return Text("Expanded") }
        return unread > 0 ? Text("Collapsed") + Text(verbatim: ", ") + Text("\(unread) unread") : Text("Collapsed")
    }

    /// How long a row's swipe takes to close after one of its actions.
    static let swipeCloseDelay = 0.6

    private func pin(_ id: String, _ pinned: Bool) {
        Task { await workspace.pinTopic(id, pinned: pinned) }
    }

    /// A second Archive, Delete or Unarchive while the first is read starts no other.
    private func retire(_ action: TopicRetireRequest.Action, _ chat: ConciergeChat) {
        guard retiring == nil, restoring == nil else { return }
        retiring = TopicRetireRequest(chatId: chat.id, name: TopicChatsStore.title(chat), action: action)
    }

    private func restore(_ chat: ConciergeChat) {
        guard retiring == nil, restoring == nil else { return }
        restoring = TopicRestoreRequest(chatId: chat.id, name: TopicChatsStore.title(chat))
    }

    private func toggle(_ change: () -> Void) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25), change)
    }

    /// A row of the current list, or of Older (`swipe` false): only the
    /// current list's rows swipe to pin.
    @ViewBuilder
    private func topicRow(_ chat: ConciergeChat, swipe: Bool = true) -> some View {
        let pinned = workspace.topics.isPinned(chat.id)
        let row = TopicItem(chat: chat, selected: section == .topic(chat.id), pinned: pinned) {
            onSection(.topic(chat.id))
        }
        // A row sliding to its new place goes over the rows it passes,
        // and the selected row over its neighbours, whose opaque rows
        // would cover its shadow.
        .zIndex(workspace.topics.moving == chat.id ? 2 : section == .topic(chat.id) ? 1 : 0)
        .drawerRow()
        if swipe {
            // Right: pin or unpin, all the way across too. The row
            // moves once its swipe has closed: moved while it is
            // still closing, the list fades the row out and in.
            row.swipeActions(edge: .leading, allowsFullSwipe: true) {
                TopicPinButton(pinned: pinned) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + Self.swipeCloseDelay) { pin(chat.id, !pinned) }
                }
                .tint(Palette.primary)
            }
            .contextMenu { topicMenu(chat, pinned: pinned) }
        } else {
            row.contextMenu { topicMenu(chat, pinned: pinned) }
        }
    }

    /// An archived chat's row: it opens read only, and its menu unarchives
    /// or deletes it. No swipe.
    private func archivedRow(_ chat: ConciergeChat) -> some View {
        TopicItem(chat: chat, selected: section == .topic(chat.id), pinned: false, muted: true) {
            onSection(.topic(chat.id))
        }
        .zIndex(section == .topic(chat.id) ? 1 : 0)
        .drawerRow()
        .contextMenu {
            Button { restore(chat) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }
            Button(role: .destructive) { retire(.delete, chat) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    /// No swipe to the left on any row: Archive and Delete, too easy to
    /// set off by accident there, are in the menu.
    @ViewBuilder
    private func topicMenu(_ chat: ConciergeChat, pinned: Bool) -> some View {
        Button {
            renaming = TopicRenameRequest(chatId: chat.id, name: TopicChatsStore.title(chat))
        } label: { Label("Rename", systemImage: "pencil") }
        TopicPinButton(pinned: pinned) { pin(chat.id, !pinned) }
        Button { retire(.archive, chat) } label: { Label("Archive", systemImage: "archivebox") }
        Button(role: .destructive) { retire(.delete, chat) } label: { Label("Delete", systemImage: "trash") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { onSection(.search) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").romeFont(16, .medium)
                    Text("Search").romeFont(17)
                    Spacer()
                }
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 14)
                .frame(height: 42)
                .background(Palette.drawerField, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(PressScaleStyle(scale: 0.98))

            VStack(spacing: 2) {
                DrawerItem(title: "Chat", selected: section == .chat, action: { onSection(.chat) }) {
                    Image(systemName: "bubble.left")
                }
                // A dashboard admin has the whole dashboard, Apps and New app included.
                DrawerItem(title: "Apps", selected: section == .apps, action: { onSection(.apps) }) {
                    Image(systemName: "square.grid.2x2")
                }
            }
            .padding(.top, 22)

            Rectangle()
                .fill(Palette.hair)
                .frame(height: 0.5)
                .padding(.horizontal, 12)
                .padding(.top, 14)

            HStack(spacing: 0) {
                // The header folds the list; the "+" beside it keeps its own tap.
                Button(action: toggleFold) {
                    HStack(spacing: 6) {
                        Text("Topic chats")
                            .romeFont(13, .semibold)
                        Image(systemName: "chevron.right")
                            .romeFont(10, .bold)
                            .rotationEffect(.degrees(folded ? 0 : 90))
                            .accessibilityHidden(true)
                        // Folded, the list's unread replies still show.
                        if folded && unread > 0 {
                            // Read out in the header's value instead.
                            UnreadBadge(count: unread)
                                .transition(.opacity)
                                .accessibilityHidden(true)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Palette.sub)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(foldValue)
                .accessibilityIdentifier("topic-chats-header")
                Button(action: onNewTopic) {
                    // Lighter and thinner than the header beside it, so it
                    // never outweighs the list.
                    Image(systemName: "plus")
                        .romeFont(15, .light)
                        .foregroundStyle(Palette.sub.opacity(0.75))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("New topic chat")
            }
            .padding(.leading, 12)
            .padding(.top, 6)

            // A List, for each row's swipe to Pin; it draws as the plain
            // stack of rows it was: no separators, insets or backgrounds of
            // its own, and the same 2 pt between rows.
            let topics = workspace.topics
            let chats = topics.chats
            let archived = workspace.archivedTopics.chats
            let openId: String? = if case .topic(let id) = section { id } else { nil }
            let groups = TopicChatsStore.groups(chats, lastActive: topics.lastActive, pinnedAt: topics.pinnedAt, held: topics.heldCurrent)
            let rows = folded ? TopicChatsStore.foldedRows(chats, openId: openId) : TopicChatsStore.page(
                groups.current, limit: topicLimit, pinnedAt: topics.pinnedAt, openId: openId
            )
            let olderShown = TopicChatsStore.shownCount(groups.older.count, limit: olderLimit, openIndex: groups.older.firstIndex { $0.id == openId })
            let archivedShown = TopicChatsStore.shownCount(archived.count, limit: archivedLimit, openIndex: archived.firstIndex { $0.id == openId })
            // Where the open chat is, so its group opens to show it. One in
            // neither list yet is unlisted, so the key changes once it is.
            let openPlace: OpenPlace = openId.map { id in
                if groups.older.contains(where: { $0.id == id }) { return .older }
                if archived.contains(where: { $0.id == id }) { return .archived }
                return chats.contains { $0.id == id } ? .current : .unlisted
            } ?? .none
            List {
                ForEach(rows) { chat in topicRow(chat) }
                if folded {
                    // Folded, an open archived chat stays reachable too.
                    ForEach(TopicChatsStore.foldedRows(archived, openId: openId)) { chat in archivedRow(chat) }
                }
                if !folded && rows.count < groups.current.count {
                    Color.clear
                        .frame(height: 1)
                        .id("current-\(topicLimit)")
                        .onAppear { topicLimit += TopicChatsStore.pageSize }
                        .accessibilityHidden(true)
                        .drawerRow()
                }
                if !folded && !groups.older.isEmpty {
                    DrawerGroupRow(title: "Older", icon: "clock", count: groups.older.count, expanded: topics.olderExpanded) {
                        toggle { topics.setOlderExpanded(!topics.olderExpanded) }
                    }
                    .accessibilityIdentifier("older-topic-chats-header")
                    .drawerRow()
                    if topics.olderExpanded {
                        ForEach(groups.older.prefix(olderShown)) { chat in topicRow(chat, swipe: false) }
                        if olderShown < groups.older.count {
                            Color.clear
                                .frame(height: 1)
                                .id("older-\(olderShown)")
                                .onAppear { olderLimit = olderShown + TopicChatsStore.pageSize }
                                .accessibilityHidden(true)
                                .drawerRow()
                        }
                    }
                }
                if !folded && !archived.isEmpty {
                    DrawerGroupRow(title: "Archived", icon: "archivebox", count: archived.count, expanded: topics.archivedExpanded) {
                        toggle { topics.setArchivedExpanded(!topics.archivedExpanded) }
                    }
                    .accessibilityIdentifier("archived-topic-chats-header")
                    .drawerRow()
                    if topics.archivedExpanded {
                        ForEach(archived.prefix(archivedShown)) { chat in archivedRow(chat) }
                        if archivedShown < archived.count {
                            Color.clear
                                .frame(height: 1)
                                .id("archived-\(archivedShown)")
                                .onAppear { archivedLimit = archivedShown + TopicChatsStore.pageSize }
                                .accessibilityHidden(true)
                                .drawerRow()
                        }
                    }
                }
            }
            // The open chat's group is decided once it is found in the list,
            // and a group holding it opens, so the selection shows.
            .onChange(of: OpenKey(id: openId, place: openPlace), initial: true) { _, key in
                topics.noteOpen(key.id)
                switch key.place {
                case .older where !topics.olderExpanded: topics.setOlderExpanded(true)
                case .archived where !topics.archivedExpanded: topics.setArchivedExpanded(true)
                default: break
                }
            }
            .listStyle(.plain)
            .listRowSpacing(2)
            .environment(\.defaultMinListRowHeight, 1)
            .scrollContentBackground(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: .infinity)
            .topicRetire($retiring, workspace: workspace, onRetired: onTopicGone)
            .topicRestore($restoring, workspace: workspace)
            .topicRename($renaming, workspace: workspace)

            // The open Rome behind its latest release, or updating in the
            // background, for a guardian and a visitor alike.
            if let state = model.update.rowState {
                DrawerUpdateRow(agentName: workspace.agentName, state: state)
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
            }

            Button(action: onSettings) {
                HStack(spacing: 12) {
                    InitialAvatar(text: workspace.accountLabel, imageURL: workspace.avatarURL, instance: workspace.host, account: workspace.backend.account)
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 6) {
                            Text(workspace.instanceName)
                                .romeFont(16, .semibold)
                                .foregroundStyle(Palette.fg)
                                .lineLimit(1)
                            if model.currentInstance?.isVisitor == true { VisitorBadge() }
                        }
                        Text(model.currentInstance?.host ?? workspace.host)
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "gearshape")
                        .romeFont(17)
                        .foregroundStyle(Palette.fg)
                        .frame(width: 36, height: 36)
                        .background(Palette.drawerField, in: Circle())
                }
                // Even sides, so the avatar and the gear sit as far from their edges.
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 60)
                .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(PressScaleStyle(scale: 0.98))
            .accessibilityLabel("\(workspace.instanceName), settings")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// Which group of the drawer's list holds the open chat.
private enum OpenPlace: Hashable {
    case none, unlisted, current, older, archived
}

private struct OpenKey: Hashable {
    let id: String?
    let place: OpenPlace
}

/// The Older and Archived rows under the topic chats: an icon, the name,
/// how many chats it holds, and a chevron that turns as it opens in place.
private struct DrawerGroupRow: View {
    let title: LocalizedStringKey
    let icon: String
    let count: Int
    let expanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .romeFont(15)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(title).romeFont(15)
                Spacer(minLength: 8)
                Text(verbatim: "\(count)")
                    .romeFont(14, monospacedDigits: true)
                Image(systemName: "chevron.right")
                    .romeFont(10, .bold)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title) + Text(verbatim: ", \(count)"))
        .accessibilityAddTraits([.isHeader, .isButton])
        .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
    }
}

private struct DrawerItem<Icon: View>: View {
    let title: LocalizedStringKey
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                icon()
                    .romeFont(18, selected ? .medium : .regular)
                    .foregroundStyle(selected ? Palette.primaryIcon : Palette.fg)
                    .frame(width: 22)
                Text(title)
                    .romeFont(17, selected ? .semibold : .regular)
                Spacer()
            }
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 12)
            .frame(height: 48)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.elevated)
                        .softElevation(radius: 14)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// One topic chat: its name, and how many replies wait unread, else a pin
/// when it is pinned.
private struct TopicItem: View {
    let chat: ConciergeChat
    let selected: Bool
    let pinned: Bool
    /// An archived chat's name, in the muted text color.
    var muted = false
    let action: () -> Void

    private var unread: Int { chat.unread ?? 0 }

    private var accessibilityValue: Text {
        switch (unread > 0, pinned) {
        case (true, true): Text("Pinned") + Text(verbatim: ", ") + Text("\(unread) unread")
        case (true, false): Text("\(unread) unread")
        case (false, true): Text("Pinned")
        case (false, false): Text(verbatim: "")
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(verbatim: TopicChatsStore.title(chat))
                    // The highlight shows the selection; the weight stays.
                    .romeFont(16)
                    .foregroundStyle(muted ? Palette.sub : Palette.fg)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if unread > 0 {
                    UnreadBadge(count: unread)
                } else if pinned {
                    Image(systemName: "pin.fill")
                        .romeFont(12)
                        .foregroundStyle(Palette.sub)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.elevated)
                        .softElevation(radius: 14)
                } else {
                    // In the drawer's own color: a row moving past another hides it.
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.drawer)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityValue(accessibilityValue)
        .accessibilityIdentifier("topic-chat")
    }
}

/// How many replies wait unread, in the drawer's primary capsule.
private struct UnreadBadge: View {
    let count: Int

    var body: some View {
        Text(verbatim: "\(count)")
            .romeFont(12, .bold, monospacedDigits: true)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .frame(minWidth: 20, minHeight: 20)
            .background(Palette.primary, in: Capsule())
    }
}

private extension View {
    /// A drawer list row with nothing of the List's own: no inset, separator
    /// or background, so it draws as the row alone.
    func drawerRow() -> some View {
        listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

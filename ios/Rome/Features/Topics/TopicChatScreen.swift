import SwiftUI

/// A Concierge topic chat, in the main Chat's style. A blank one (`chatId`
/// nil) creates nothing until the guardian sends: then it starts the chat,
/// sends the message to it, and reports the new id.
struct TopicChatScreen: View {
    let workspace: Workspace
    let chatId: String?
    /// Whose draft the composer keeps: the chat, or the blank chat until it exists.
    let draftKey: String
    let onMenu: () -> Void
    /// The Agent page for this chat: on a tab from the header's buttons, or
    /// as it was last from the mascot (nil).
    let onAgent: (String?, AgentTab?) -> Void
    /// The chat was archived or deleted: the shell shows the main Chat.
    let onArchived: () -> Void
    let onCreated: (String) -> Void
    /// Nothing covers the chat, the drawer included; read for a blank chat,
    /// which `visibleChat` cannot name.
    var inFront = true

    @Environment(\.visibleChat) private var visibleChat
    @State private var draft = ""
    @State private var starting: String?
    @State private var startFailed = false
    @State private var startFailure: SendFailure = .unknown
    @State private var startingImages: [ComposerImage] = []
    /// Rename from the header, while its alert is up.
    @State private var renaming: TopicRenameRequest?
    /// Archive or Delete from the header, while it is read and asked.
    @State private var retiring: TopicRetireRequest?
    /// Unarchive from the archived chat's banner, while it is read and asked.
    @State private var restoring: TopicRestoreRequest?
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()

    private var store: TranscriptStore? { chatId.map(workspace.topicStore) }

    /// An archived chat reads only: a banner offers Unarchive, and there is no
    /// composer, so nothing sent can bring it back unasked.
    private var archived: Bool { workspace.isArchivedTopic(chatId) }

    /// A blank chat, or one whose transcript loaded empty.
    private var showsStarters: Bool {
        if archived { return false }
        if let store { return ConciergeStarters.visible(loaded: store.readOnce, empty: store.rowsEmpty) }
        return starting == nil
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .floatingTopBar {
            // The title and the status are read by the header itself, so a
            // change in them never redraws the transcript.
            TopicChatHeader(
                workspace: workspace,
                chatId: chatId,
                draftKey: draftKey,
                share: store?.share,
                onMenu: {
                    // The keyboard would stay up over the drawer.
                    composerFocused = false
                    onMenu()
                },
                onAgent: { onAgent(chatId, $0) },
                onRename: { title in
                    guard let chatId else { return }
                    renaming = TopicRenameRequest(chatId: chatId, name: title)
                },
                onPin: { pinned in
                    guard let chatId else { return }
                    Task { await workspace.pinTopic(chatId, pinned: pinned) }
                },
                onArchive: { title in retire(.archive, title) },
                onUnarchive: unarchive,
                onDelete: { title in retire(.delete, title) }
            )
        }
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                if archived {
                    TopBanner(kind: .archived, text: String(localized: "This chat is archived"), actionTitle: String(localized: "Unarchive"), busy: restoring != nil, action: unarchive)
                    .transition(.opacity)
                }
                if let store { TranscriptBanners(store: store) }
            }
            .padding(.top, 70)
            .animation(.easeOut(duration: 0.2), value: archived)
        }
        // Reply brings the keyboard up.
        .onChange(of: store?.replies) { composerFocused = true }
        .topicRename($renaming, workspace: workspace)
        .topicRetire($retiring, workspace: workspace) { _ in onArchived() }
        .topicRestore($restoring, workspace: workspace)
        .pageBackground()
        .environment(\.taskLinks, chatId.flatMap { workspace.taskLinks(forChat: $0) })
        .composerDraft(workspace.drafts, chat: chatId ?? draftKey, text: $draft, attachments: attachments, transcript: store, onReply: { store?.restoreReply($0) }, prefill: Binding(
            get: { workspace.composerPrefills[chatId ?? draftKey] },
            set: { workspace.composerPrefills[chatId ?? draftKey] = $0 }
        )) { composerFocused = true }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                // Inside the composer's inset, so the last message rests above it too.
                UpdatedNotice(agentName: workspace.agentName, visible: chatId.map { visibleChat == $0 } ?? inFront)
                if !archived, let store, store.showsQuoteBar {
                    QuoteBar(message: store.quotedMessage) { store.cancelQuote() }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if startFailed && store == nil {
                    Text(startFailure.reason.map { String(localized: "Couldn't start the chat · \($0)") } ?? String(localized: "Couldn't start the chat"))
                        .romeFont(13, .medium)
                        .foregroundStyle(Palette.destructive)
                        .transition(.opacity)
                }
                if showsStarters {
                    ConciergeStarters { send(text: $0.text) }
                }
                if !archived {
                    TopicComposer(workspace: workspace, chatId: chatId, draft: $draft, focused: $composerFocused, attachments: attachments, sharing: store?.share.isSelecting ?? false) { send() }
                }
            }
            .shareModeComposer(store?.share)
            .animation(.easeOut(duration: 0.2), value: showsStarters)
            .animation(.easeOut(duration: 0.2), value: store?.quote)
            .disabled(starting != nil)
            .padding(.horizontal, Metrics.pagePadding)
            .readableColumn()
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        // The open starts before the first fetch, so a reply that arrives
        // live during it is never counted as unread.
        .onAppear {
            store?.beginOpen()
            store?.start()
        }
        // A blank chat that just started its chat keeps this view.
        .onChange(of: chatId) { store?.start() }
        .onDisappear {
            store?.stop()
            // Left blank, the chat is never made, and its draft goes with it.
            if chatId == nil && starting == nil { workspace.drafts.discard(chat: draftKey) }
        }
    }

    /// Read only while it is the chat on screen: never under an instance
    /// page's sheet, the Agent page or the drawer.
    private func markRead(_ store: TranscriptStore) {
        guard visibleChat == store.sessionId || (chatId != nil && visibleChat == chatId) else { return }
        // Before the read: the open reads where the unread messages start.
        store.beginOpen()
        store.markRead()
        workspace.topics.markRead(store.sessionId)
    }

    @ViewBuilder
    private var content: some View {
        if let store, store.loaded {
            TranscriptList(store: store, composerFocused: composerFocused, latestRequest: workspace.topicLatest[store.sessionId] ?? 0) { row, previous in
                ConciergeRow(row: row, info: store.info(for: row), store: store, tasks: workspace.taskChats, tinted: store.tinted != nil && row.ownMessageId == store.tinted)
                    .equatable()
                    .shareSelectable(row, share: store.share, top: TranscriptSpacing.top(row, after: previous))
            }
            .onTapGesture { composerFocused = false }
            .overlay(alignment: .top) { UnreadPillButton(store: store) }
            .onAppear { markRead(store) }
            .onChange(of: store.arrivals) { markRead(store) }
            // Back from under a sheet: what arrived meanwhile is read now.
            .onChange(of: visibleChat) { markRead(store) }
        } else if let starting {
            // The chat is being started: the message waits as a pending bubble.
            ScrollView {
                VStack(spacing: 8) {
                    UserBubble(text: starting, images: startingImages.map(UserImage.local), pending: startFailed ? .failed(startFailure) : .sending) {
                        send(text: starting, images: startingImages)
                    }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .readableColumn()
            }
            .defaultScrollAnchor(.bottom)
        } else if store != nil {
            Spacer()
            Spinner(size: 22, color: Palette.sub)
            Spacer()
        } else {
            // A blank topic chat: nothing but the composer.
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { composerFocused = false }
        }
    }

    /// Unarchive from the banner or the header's "…": a second tap while
    /// the first is read starts no other.
    private func unarchive() {
        guard let chatId, restoring == nil else { return }
        restoring = TopicRestoreRequest(chatId: chatId, name: TopicChatsStore.title(workspace.topicChat(chatId)))
    }

    /// Archive or Delete from the header: a second tap while the first is
    /// read starts no other.
    private func retire(_ action: TopicRetireRequest.Action, _ name: String) {
        guard let chatId, retiring == nil else { return }
        retiring = TopicRetireRequest(chatId: chatId, name: name, action: action)
    }

    /// Sends the draft with the composer's photos.
    private func send() {
        guard !attachments.isPreparing else { return }
        let images = attachments.images
        if let store {
            if store.send(draft, images: images, fromComposer: true, reply: store.composerReply) {
                draft = ""
                _ = attachments.take()
                store.cancelQuote()
            }
            return
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty else { return }
        draft = ""
        _ = attachments.take()
        send(text: text, images: images, fromComposer: true)
    }

    /// Sends `text`, starting the chat first when this one is blank.
    private func send(text: String, images: [ComposerImage] = [], fromComposer: Bool = false) {
        if let store {
            store.send(text, images: images, fromComposer: fromComposer)
            return
        }
        starting = text
        startingImages = images
        startFailed = false
        Task {
            if let id = await workspace.startTopicChat(firstMessage: text, images: images, blankKey: draftKey, fromComposer: fromComposer) {
                starting = nil
                onCreated(id)
            } else {
                // The message goes back into the composer, as the draft.
                starting = nil
                startFailed = true
                startFailure = workspace.startFailure ?? .unknown
                draft = text
                attachments.restore(images)
            }
        }
    }
}

/// A topic chat's composer, named after the chat. It reads the chat's name
/// itself, so a rename never redraws the transcript.
private struct TopicComposer: View {
    let workspace: Workspace
    let chatId: String?
    @Binding var draft: String
    @Binding var focused: Bool
    let attachments: ComposerAttachments
    /// Share selection hides the field while it lasts.
    let sharing: Bool
    let onSend: () -> Void
    @Environment(\.visibleChat) private var visibleChat
    @Environment(\.offScreen) private var offScreen

    /// A blank chat is never the visible chat, as it has no id yet: it goes
    /// by whether a page or a sheet covers it.
    private var onScreen: Bool { !sharing && (chatId.map { visibleChat == $0 } ?? !offScreen) }

    var body: some View {
        let chat = chatId.flatMap(workspace.topics.chat)
        // Only "Message in <name>" is fitted.
        let name = TopicChatsStore.composerName(chat)
        Composer(text: $draft, placeholder: TopicChatsStore.composerPlaceholder(chat), named: name.map { NamedPlaceholder(name: $0, text: TopicChatsStore.messageIn) }, focused: $focused, attachments: attachments, voiceInput: workspace.voiceInput, voiceKey: chatId, voiceField: .topicChat, onScreen: onScreen, onSend: onSend)
    }
}

/// A topic chat's header. It reads the chat's title, its status and whether it
/// is on screen itself, so a change in any of them redraws it alone.
private struct TopicChatHeader: View {
    let workspace: Workspace
    let chatId: String?
    let draftKey: String
    let share: ChatShareFlow?
    let onMenu: () -> Void
    /// The Agent page for this chat, on a tab or as it was last.
    let onAgent: (AgentTab?) -> Void
    /// Rename, with the chat's current title.
    let onRename: (String) -> Void
    /// Pin (true) or unpin (false).
    let onPin: (Bool) -> Void
    /// Archive, with the chat's current title.
    let onArchive: (String) -> Void
    /// Unarchive, for an archived chat.
    let onUnarchive: () -> Void
    /// Delete, with the chat's current title.
    let onDelete: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let title = TopicChatsStore.title(chatId.flatMap(workspace.topicChat))
        let activity = workspace.topics.activity(for: chatId)
        let menu = TopicHeaderMenu(blank: chatId == nil, archived: workspace.isArchivedTopic(chatId))
        ChatHeader(
            // The Concierge's name, as in the main chat; the topic's own
            // title stays in the "…" menu.
            name: workspace.agentDisplayName,
            menuTitle: title,
            activity: activity,
            announces: chatId != nil && model.visibleChat == chatId,
            onMenu: onMenu,
            onAgent: onAgent,
            zoomSource: AgentZoom.source(chatId ?? draftKey),
            tasks: chatId.flatMap { workspace.taskList(forChat: $0) },
            // A blank chat has nothing to rename, pin, archive or delete yet.
            onRename: menu.has(.rename) ? { onRename(title) } : nil,
            pinned: menu.has(.pin) && (chatId.map(workspace.topics.isPinned) ?? false),
            onPin: menu.has(.pin) ? onPin : nil,
            onArchive: menu.has(.archive) ? { onArchive(title) } : nil,
            onUnarchive: menu.has(.unarchive) ? onUnarchive : nil,
            onDelete: menu.has(.delete) ? { onDelete(title) } : nil
        )
        .shareModeHeader(share)
        // Rows blur under the header as in the main Chat, past the status
        // capsule while one hangs below the row.
        .background(alignment: .top) {
            ChatHeaderBlur(reach: ChatHeaderBlur.reach(statusShows: activity?.statusLine != nil, dynamicTypeSize))
        }
    }
}

/// What a topic chat's header "…" offers for the chat itself, besides Share
/// and Shared links: a blank chat nothing yet; an archived one, as on the web,
/// only Unarchive and Delete, since it is renamed and pinned once it is back.
struct TopicHeaderMenu: Equatable {
    enum Item: Equatable, CaseIterable { case rename, pin, archive, unarchive, delete }

    let items: [Item]

    init(blank: Bool, archived: Bool) {
        if blank {
            items = []
        } else if archived {
            items = [.unarchive, .delete]
        } else {
            items = [.rename, .pin, .archive, .delete]
        }
    }

    func has(_ item: Item) -> Bool { items.contains(item) }
}

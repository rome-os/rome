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
    /// The header's mascot was tapped: the Agent page, for this chat.
    let onAgent: (String?) -> Void
    let onOpenChat: (String, String) -> Void
    /// The chat was archived or deleted: the shell shows the main Chat.
    let onArchived: () -> Void
    let onCreated: (String) -> Void

    @Environment(\.visibleChat) private var visibleChat
    @State private var draft = ""
    @State private var starting: String?
    @State private var startFailed = false
    @State private var startFailure: SendFailure = .unknown
    @State private var startingImages: [ComposerImage] = []
    @State private var renaming = false
    @State private var confirmDelete = false
    @State private var newName = ""
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()

    private var store: TranscriptStore? { chatId.map(workspace.topicStore) }

    /// A blank chat, or one whose transcript loaded empty.
    private var showsStarters: Bool {
        if let store { return ConciergeStarters.visible(loaded: store.readOnce, rows: store.rows) }
        return starting == nil
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Under an open thread, VoiceOver reads the thread, not what it covers.
        .accessibilityHidden(store?.thread != nil)
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
                onAgent: { onAgent(chatId) },
                onRename: { title in
                    newName = title
                    renaming = true
                },
                onArchive: chatId.map { id in { archive(id) } },
                onDelete: { confirmDelete = true }
            )
            .accessibilityHidden(store?.thread != nil)
        }
        .overlay(alignment: .top) {
            if let store { TranscriptBanners(store: store).padding(.top, 70) }
        }
        // Over the header and the transcript; the composer below stays in place.
        .overlay {
            if let store, let thread = store.thread {
                ThreadOverlay(thread: thread, chat: store, tasks: workspace.tasks, name: workspace.agentDisplayName, activity: { workspace.topics.activity(for: chatId) }, onOpenChat: onOpenChat) { store.closeThread() }
            }
        }
        // Reply brings the keyboard up; a label opens the thread for reading.
        .onChange(of: store?.replies) { composerFocused = true }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                guard let chatId else { return }
                let name = newName
                Task { await workspace.renameTopic(chatId, to: name) }
            }
        }
        .deleteChatAlert(isPresented: $confirmDelete) {
            guard let chatId else { return }
            Task { if await workspace.deleteTopic(chatId) { onArchived() } }
        }
        .pageBackground()
        .composerDraft(workspace.drafts, chat: chatId ?? draftKey, text: $draft, attachments: attachments, transcript: store, onThread: { store?.reopenThread($0) }, prefill: Binding(
            get: { workspace.composerPrefills[chatId ?? draftKey] },
            set: { workspace.composerPrefills[chatId ?? draftKey] = $0 }
        )) { composerFocused = true }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                // Inside the composer's inset, so the last message rests above it too.
                UpdatePill(agentName: workspace.agentName)
                if let store, store.showsQuoteBar {
                    QuoteBar(message: store.quotedMessage, threadTitle: store.threadReplyTitle) { store.cancelQuote() }
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
                Composer(text: $draft, placeholder: store?.composerThread == nil ? String(localized: "Message") : String(localized: "Reply"), focused: $composerFocused, attachments: attachments) { send() }
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
        .onAppear { store?.start() }
        // A blank chat that just started its chat keeps this view.
        .onChange(of: chatId) { store?.start() }
        .onDisappear {
            store?.closeThread()
            store?.stop()
            // Left blank, the chat is never made, and its draft goes with it.
            if chatId == nil && starting == nil { workspace.drafts.discard(chat: draftKey) }
        }
    }

    /// Read only while it is the chat on screen: never under an instance
    /// page's sheet, the Agent page or the drawer.
    private func markRead(_ store: TranscriptStore) {
        guard visibleChat == store.sessionId || (chatId != nil && visibleChat == chatId) else { return }
        store.markRead()
        workspace.topics.markRead(store.sessionId)
    }

    @ViewBuilder
    private var content: some View {
        if let store, store.loaded {
            TranscriptList(store: store, composerFocused: composerFocused, latestRequest: workspace.topicLatest[store.sessionId] ?? 0) { row, previous in
                ConciergeRow(row: row, store: store, tasks: workspace.tasks, onOpenChat: onOpenChat)
                    .tinted(store.tinted != nil && row.ownMessageId == store.tinted)
                    .shareSelectable(row, share: store.share, top: TranscriptSpacing.top(row, after: previous))
            }
            .onTapGesture { composerFocused = false }
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

    private func archive(_ id: String) {
        Task {
            if await workspace.archiveTopic(id) { onArchived() }
        }
    }

    /// Sends the draft with the composer's photos.
    private func send() {
        guard !attachments.isPreparing else { return }
        let images = attachments.images
        if let store {
            // While a chat thread is open, the composer sends into it.
            if store.send(draft, images: images, fromComposer: true, thread: store.composerThread) {
                draft = ""
                _ = attachments.take()
                store.closeThread()
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

/// A topic chat's header. It reads the chat's title, its status and whether it
/// is on screen itself, so a change in any of them redraws it alone.
private struct TopicChatHeader: View {
    let workspace: Workspace
    let chatId: String?
    let draftKey: String
    let share: ChatShareFlow?
    let onMenu: () -> Void
    /// The header's mascot was tapped: the Agent page, for this chat.
    let onAgent: () -> Void
    /// Rename, with the chat's current title.
    let onRename: (String) -> Void
    let onArchive: (() -> Void)?
    let onDelete: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let title = TopicChatsStore.title(chatId.flatMap(workspace.topics.chat))
        ChatHeader(
            // The Concierge's name, as in the main chat; the topic's own
            // title stays in the "…" menu.
            name: workspace.agentDisplayName,
            menuTitle: title,
            activity: workspace.topics.activity(for: chatId),
            announces: chatId != nil && model.visibleChat == chatId,
            onMenu: onMenu,
            onAgent: onAgent,
            zoomSource: AgentZoom.source(chatId ?? draftKey),
            // A blank chat has nothing to rename, archive or delete yet.
            onRename: chatId == nil ? nil : { onRename(title) },
            onArchive: onArchive,
            onDelete: chatId == nil ? nil : onDelete
        )
        .shareModeHeader(share)
    }
}

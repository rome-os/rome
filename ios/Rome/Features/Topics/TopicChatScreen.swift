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
    let onTasks: (String?) -> Void
    let onOpenChat: (String, String) -> Void
    /// The chat was archived: the shell shows the main Chat.
    let onArchived: () -> Void
    let onCreated: (String) -> Void

    @State private var draft = ""
    @State private var starting: String?
    @State private var startFailed = false
    @State private var startingImages: [ComposerImage] = []
    @State private var renaming = false
    @State private var newName = ""
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()

    private var store: TranscriptStore? { chatId.map(workspace.topicStore) }

    /// A blank chat, or one whose transcript loaded empty.
    private var showsStarters: Bool {
        if let store { return ConciergeStarters.visible(loaded: store.loaded, rows: store.rows) }
        return starting == nil
    }

    private var title: String {
        TopicChatsStore.title(chatId.flatMap(workspace.topics.chat))
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .floatingTopBar {
            ChatHeader(
                title: Text(verbatim: title),
                onMenu: {
                    // The keyboard would stay up over the drawer.
                    composerFocused = false
                    onMenu()
                },
                onTasks: { onTasks(chatId) },
                // A blank chat has nothing to rename or archive yet.
                onRename: chatId == nil ? nil : {
                    newName = title
                    renaming = true
                },
                onArchive: chatId.map { id in { archive(id) } },
                plainTitle: true
            )
        }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                guard let chatId else { return }
                let name = newName
                Task { await workspace.renameTopic(chatId, to: name) }
            }
        }
        .pageBackground()
        .composerDraft(workspace.drafts, chat: chatId ?? draftKey, text: $draft, attachments: attachments)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                if showsStarters {
                    ConciergeStarters { send(text: $0.text) }
                }
                Composer(text: $draft, placeholder: String(localized: "Message"), focused: $composerFocused, attachments: attachments) { send() }
            }
            .animation(.easeOut(duration: 0.2), value: showsStarters)
            .disabled(starting != nil)
            .padding(.horizontal, Metrics.pagePadding)
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        .onAppear { store?.start() }
        // A blank chat that just started its chat keeps this view.
        .onChange(of: chatId) { store?.start() }
        .onDisappear {
            store?.stop()
            // Left blank, the chat is never made, and its draft goes with it.
            if chatId == nil && starting == nil { workspace.drafts.discard(chat: draftKey) }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let store, store.loaded {
            TranscriptList(store: store, composerFocused: composerFocused, latestRequest: workspace.topicLatest[store.sessionId] ?? 0) { row, previous in
                ConciergeRow(row: row, store: store, tasks: workspace.tasks, onOpenChat: onOpenChat)
                    .padding(.top, TranscriptSpacing.top(row, after: previous))
            }
            .onTapGesture { composerFocused = false }
            .onAppear { store.markRead() }
            .onChange(of: store.arrivals) { store.markRead() }
        } else if let starting {
            // The chat is being started: the message waits as a pending bubble.
            ScrollView {
                VStack(spacing: 8) {
                    UserBubble(text: starting, images: startingImages.map(UserImage.local), pending: startFailed ? .failed : .sending) {
                        send(text: starting, images: startingImages)
                    }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .frame(maxWidth: .infinity, alignment: .trailing)
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
            if store.send(draft, images: images) {
                draft = ""
                _ = attachments.take()
            }
            return
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty else { return }
        draft = ""
        _ = attachments.take()
        send(text: text, images: images)
    }

    /// Sends `text`, starting the chat first when this one is blank.
    private func send(text: String, images: [ComposerImage] = []) {
        if let store {
            store.send(text, images: images)
            return
        }
        starting = text
        startingImages = images
        startFailed = false
        Task {
            if let id = await workspace.startTopicChat(firstMessage: text, images: images) {
                starting = nil
                onCreated(id)
            } else {
                startFailed = true
            }
        }
    }
}

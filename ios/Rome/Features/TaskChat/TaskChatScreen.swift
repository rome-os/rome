import SwiftUI

/// Board 6: one task chat. Its brief sits on top, tool work folds into a pill,
/// and what needs the guardian (an approval, a question) stands out.
struct TaskChatScreen: View {
    let workspace: Workspace
    let chatId: String
    let initialTitle: String

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    /// Kept on the workspace, so a failed send's bubble and Retry are still
    /// there when the guardian comes back, and the draft waits for it to load.
    private var store: TranscriptStore { workspace.taskStore(chatId) }
    @State private var draft = ""
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()
    @State private var confirmDelete = false

    private var title: String { workspace.tasks.title(forChat: chatId, fallback: initialTitle) }

    /// The header shows a spinner only while this chat runs a turn. The
    /// task's own state is left out: it is not reported accurately enough.
    private var spinning: Bool { store.running }

    var body: some View {
        VStack(spacing: 0) {
            if store.loaded {
                transcript(store)
            } else {
                Spacer()
                Spinner(size: 22, color: Palette.sub)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .floatingTopBar { header }
        .overlay(alignment: .top) {
            TranscriptBanners(store: store)
                .padding(.top, 62)
        }
        .background(Palette.bg.ignoresSafeArea())
        .composerDraft(workspace.drafts, chat: chatId, text: $draft, attachments: attachments, transcript: store)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Composer(
                text: $draft,
                placeholder: String(localized: "Reply to this task"),
                stopVisible: store.running,
                stopping: store.stopping,
                focused: $composerFocused,
                attachments: attachments,
                onSend: {
                    guard !attachments.isPreparing else { return }
                    if store.send(draft, images: attachments.images, fromComposer: true) {
                        draft = ""
                        _ = attachments.take()
                    }
                },
                onStop: { store.stopTurn() }
            )
            .shareModeComposer(store.share)
            .padding(.horizontal, Metrics.pagePadding)
            .readableColumn()
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        .onAppear {
            // Starting again after a return reloads and resubscribes; it is a no-op while running.
            store.start()
        }
        .onDisappear {
            store.markRead()
            store.stop()
        }
        // Keep the swipe-back gesture with a hidden navigation bar.
        .background(SwipeBackEnabler())
        .deleteChatAlert(isPresented: $confirmDelete) {
            Task { if await workspace.deleteTaskChat(chatId) { dismiss() } }
        }
    }

    private func archive() {
        Task { if await workspace.archiveTaskChat(chatId) { dismiss() } }
    }

    private var header: some View {
        HStack(spacing: 8) {
            GlassCircleButton(accessibilityLabel: "Back", action: { dismiss() }) {
                Image(systemName: "chevron.left").romeFont(17, .semibold)
            }
            HStack(spacing: 6) {
                Text(title)
                    .romeFont(15, .semibold)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityAddTraits(.isHeader)
                if spinning {
                    Spinner(size: 11, lineWidth: 2.2, color: Palette.sub, trackOpacity: 0.3)
                        .transition(.opacity)
                        .accessibilityLabel("Running")
                }
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity)
            .animation(.easeInOut(duration: 0.25), value: spinning)
            Menu {
                Button(action: archive) { Label("Archive", systemImage: "archivebox") }
                Button(role: .destructive) { confirmDelete = true } label: {
                    Label("Delete", systemImage: "trash")
                }
                ChatShareMenuItems(share: store.share)
            } label: {
                Image(systemName: "ellipsis")
                    .romeFont(17, .semibold)
                    .foregroundStyle(Palette.fg)
                    .frame(width: 44, height: 44)
                    .glassSurface(Circle(), interactive: true)
            }
            .accessibilityLabel("More")
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .frame(height: 52)
        .shareModeHeader(store.share)
        .headerFade()
    }

    @ViewBuilder
    private func transcript(_ store: TranscriptStore) -> some View {
        let briefID = store.brief?.id
        TranscriptList(
            store: store,
            composerFocused: composerFocused,
            alignTop: true,
            footer: store.running && store.loaded ? AnyView(runningLine(store)) : nil
        ) { row, previous in
            taskRow(row, store: store, briefID: briefID)
                .shareSelectable(row, share: store.share, top: spacing(row, after: previous), placement: isBrief(row, briefID) ? .corner : nil)
        }
        .onTapGesture { composerFocused = false }
    }

    private func runningLine(_ store: TranscriptStore) -> some View {
        HStack(spacing: 8) {
            Spinner(size: 15, color: Palette.running)
            Text(store.stopping ? "Stopping…" : "Running…")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
            Spacer()
        }
        .padding(.horizontal, 2)
        .padding(.top, 14)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func taskRow(_ row: TranscriptRow, store: TranscriptStore, briefID: String?) -> some View {
        switch row {
        case .separator(let id, let date):
            // The brief opens the chat; no time line above it.
            if let briefID, id == "sep-\(briefID)" {
                EmptyView()
            } else {
                TimeSeparator(date: date)
            }
        case .userText(let id, let text, let images, let pending):
            if let briefID, id.hasPrefix(briefID + ":") {
                BriefCard(text: text)
            } else if let message = row.messageId.flatMap(store.message), message.saidByAgent {
                // The Concierge relays the guardian's words: their side, its name.
                ConciergeBubble(name: message.sender?.name ?? model.workspace?.agentDisplayName ?? AgentName.fallback, text: text, menu: menu(row))
            } else {
                UserBubble(text: text, images: images, pending: pending, onRetry: { store.retry(id) }, onDelete: { store.removePending(id) }, menu: menu(row))
            }
        case .agentText(_, let text, _, let forwardedFrom, let position):
            AgentBubble(text: text, forwardedFrom: forwardedFrom, position: position, menu: menu(row))
        case .tools, .approval, .question, .webOnly, .routineDraft, .connect, .widgetUI:
            InteractionRow(row: row, store: store)
        case .error(_, let error):
            ErrorLine(error: error)
        case .notice(_, let text):
            NoticeLine(text: text)
        case .taskCard(_, let id, let title, _, _):
            TaskCard(title: title) {}
        case .taskAsk, .threadLabel, .sourceLabel:
            // Only a Concierge chat shows a task's question alone, or thread labels.
            EmptyView()
        case .typing:
            TypingDots().frame(maxWidth: .infinity, alignment: .leading)
        case .sessionRenewal:
            // Only a Concierge chat draws its faint lines.
            EmptyView()
        }
    }

    /// The brief opens the chat as a card, though it is the guardian's message.
    private func isBrief(_ row: TranscriptRow, _ briefID: String?) -> Bool {
        guard let briefID, case .userText(let id, _, _, _) = row else { return false }
        return id.hasPrefix(briefID + ":")
    }

    /// A task chat's bubbles: the time, Copy and Share; no threads to reply in.
    private func menu(_ row: TranscriptRow) -> BubbleMenu {
        let message = row.messageId.flatMap(store.message)
        let onShare: (() -> Void)? = message?.turnId == nil ? nil : { store.share.begin(fromRow: row.id) }
        return BubbleMenu(date: message?.date, onShare: onShare)
    }

    /// Task chats space every block by 12 pt, as on the board; bubbles in a run keep 3 pt.
    private func spacing(_ row: TranscriptRow, after previous: TranscriptRow?) -> CGFloat {
        guard let previous else { return 12 }
        if case .separator = row { return 20 }
        if case .separator(let id, _) = previous {
            // Directly under a hidden separator: the brief starts the page.
            return id == "sep-\(store.brief?.id ?? "")" ? 4 : 14
        }
        if case .agentText = row, case .agentText = previous { return 3 }
        return 12
    }
}

/// Keeps the edge swipe-back working on screens that hide the navigation bar.
/// The gesture only begins when there is a screen to go back to, so a swipe on
/// the root screen never leaves the stack waiting on a pop that cannot happen.
struct SwipeBackEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { Controller() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let gesture = navigationController?.interactivePopGestureRecognizer else { return }
            gesture.isEnabled = true
            gesture.delegate = self
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            let begins = (navigationController?.viewControllers.count ?? 0) > 1
            // The back swipe starts: the keyboard goes with the page.
            if begins {
                Keyboard.dismiss()
                Scrolling.stopGlides()
            }
            return begins
        }
    }
}

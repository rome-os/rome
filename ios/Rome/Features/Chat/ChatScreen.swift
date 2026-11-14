import os
import SwiftUI

/// The transcript's scroll, for reading on a device: `log stream --predicate 'category == "TranscriptScroll"'`.
let transcriptScrollLog = Logger(subsystem: "cc.romeos.mobile", category: "TranscriptScroll")

/// Board 4: the Concierge chat, the app's home screen.
struct ChatScreen: View {
    let workspace: Workspace
    /// What it calls in its window's shell: the drawer, the Agent page.
    let shell: ShellActions
    /// Chat is the page in front, with nothing pushed over it.
    var visible = true

    #if DEBUG
    @Environment(AppModel.self) private var model
    #endif
    @State private var draft = ""
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()

    private var store: TranscriptStore { workspace.concierge }

    var body: some View {
        let _ = PerfProbe.count("chatBody")
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Under an open thread, VoiceOver reads the thread, not what it covers.
        .accessibilityHidden(store.thread != nil)
        // The bar is clear: the transcript scrolls under its glass items.
        .floatingTopBar {
            VStack(spacing: 0) {
                // The status, the access notice and the push prompt are read
                // by these two, so a change in them never redraws the transcript.
                ChatHeaderBar(workspace: workspace, store: store, onMenu: { [shell] in
                    // The keyboard would stay up over the drawer.
                    composerFocused = false
                    shell.toggleNavigation.run(())
                }, onAgent: { [shell] in shell.openAgent.run(()) })
                ChatBanners(workspace: workspace, store: store)
            }
            .accessibilityHidden(store.thread != nil)
        }
        // Over the header and the transcript; the composer below stays in place.
        .overlay {
            if let thread = store.thread {
                ThreadOverlay(thread: thread, chat: store, tasks: workspace.tasks, name: workspace.agentDisplayName, activity: { workspace.mainChatActivity }, onClose: { store.closeThread() })
            }
        }
        // Reply brings the keyboard up; a label opens the thread for reading.
        .onChange(of: store.replies) { composerFocused = true }
        .pageBackground()
        // Also when the main chat's store is replaced by the one with its own id.
        .onChange(of: "\(store.sessionId)|\(visible)", initial: true) { store.onScreen = visible }
        .background { ChatLeaveWatch(store: store) }
        .composerDraft(workspace.drafts, chat: workspace.concierge.sessionId, text: $draft, attachments: attachments, transcript: workspace.concierge, onThread: { store.reopenThread($0) }, prefill: Binding(
            get: { workspace.composerPrefills[conciergeChatID] },
            set: { workspace.composerPrefills[conciergeChatID] = $0 }
        )) { composerFocused = true }
        .toolbar(.hidden, for: .navigationBar)
        #if DEBUG
        .onChange(of: model.debugCommand) { _, command in
            if case .composerPhotos(let count) = command { Task { await debugPhotos(count) } }
        }
        #endif
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if workspace.conciergeState == .ready {
                VStack(spacing: 10) {
                    // Inside the composer's inset, so the last message rests above it too.
                    UpdatePill(agentName: workspace.agentName)
                    if store.showsQuoteBar {
                        QuoteBar(message: store.quotedMessage, threadTitle: store.threadReplyTitle) { store.cancelQuote() }
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if ConciergeStarters.visible(loaded: store.readOnce, empty: store.rowsEmpty) {
                        ConciergeStarters { store.send($0.text) }
                    }
                    // While a chat thread is open, the composer sends into it.
                    Composer(text: $draft, placeholder: store.composerThread == nil ? String(localized: "Message") : String(localized: "Reply"), focused: $composerFocused, attachments: attachments) {
                        // A photo still being made small would land in the next message.
                        guard !attachments.isPreparing else { return }
                        if store.send(draft, images: attachments.images, fromComposer: true, thread: store.composerThread) {
                            draft = ""
                            _ = attachments.take()
                            store.closeThread()
                        }
                    }
                }
                .shareModeComposer(store.share)
                .animation(.easeOut(duration: 0.2), value: store.rowsEmpty)
                .animation(.easeOut(duration: 0.2), value: store.quote)
                .padding(.horizontal, Metrics.pagePadding)
                .readableColumn()
                .padding(.top, 6)
                .padding(.bottom, 8)
            }
        }
    }

    #if DEBUG
    /// Snapshot runs only: sample photos in the composer.
    private func debugPhotos(_ count: Int) async {
        _ = attachments.take()
        let colors: [UIColor] = [.systemOrange, .systemTeal, .systemIndigo, .systemPink]
        let images = (0..<count).map { index in
            UIGraphicsImageRenderer(size: CGSize(width: 400, height: 300)).image { context in
                colors[index % colors.count].setFill()
                context.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
            }
        }
        await attachments.add(images: images)
    }
    #endif

    @ViewBuilder
    private var content: some View {
        switch workspace.conciergeState {
        case .loading:
            Spacer()
            Spinner(size: 22, color: Palette.sub)
            Spacer()
        case .off:
            if workspace.isVisitor {
                // Turning Chat on is the owner's setting.
                CenteredMessage(title: "Chat is off", detail: "Ask the owner of this Rome to turn it on.")
            } else {
                CenteredMessage(
                    title: "Chat is off",
                    detail: "Turn it on to chat here.",
                    actionTitle: "Turn on Chat"
                ) { Task { await workspace.enableConcierge() } }
            }
        case .failed:
            CenteredMessage(
                title: "Could not reach your Rome",
                detail: "Check the network and try again",
                actionTitle: "Try again"
            ) { Task { await workspace.openConcierge() } }
        case .ready:
            if store.readOnce && store.rowsEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Spacer()
                    Text("What needs doing?")
                        .romeFont(30, .bold)
                        .tracking(-0.8)
                    Text("I turn bigger jobs into tasks and tell you when they're done.")
                        .romeFont(16)
                        .lineSpacing(5)
                        .foregroundStyle(Palette.sub)
                    Spacer()
                    Spacer()
                }
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { composerFocused = false }
            } else {
                TranscriptList(store: store, composerFocused: composerFocused, latestRequest: workspace.latestRequest) { row, previous in
                    ConciergeRow(row: row, info: store.info(for: row), store: store, tasks: workspace.tasks)
                        .equatable()
                        .tinted(store.tinted != nil && row.ownMessageId == store.tinted)
                        .shareSelectable(row, share: store.share, top: TranscriptSpacing.top(row, after: previous))
                }
                .onTapGesture { composerFocused = false }
                .overlay(alignment: .top) { UnreadPillButton(store: store) }
                .onAppear { store.arrived() }
                .onChange(of: store.arrivals) { store.arrived() }
            }
        }
    }
}

extension Workspace {
    /// What the Concierge is doing in the main chat.
    var mainChatActivity: ConciergeActivity? {
        topics.activity(for: mainChatServerID ?? conciergeChatID)
    }
}

/// Closes the main Chat's open when another page or a sheet covers it, so
/// coming back opens it again; the drawer over it does not. It reads
/// `offScreen` itself, so the change never draws Chat's body again.
private struct ChatLeaveWatch: View {
    let store: TranscriptStore
    @Environment(\.offScreen) private var offScreen

    var body: some View {
        Color.clear.onChange(of: offScreen) { _, hidden in
            if hidden { store.endOpen() }
        }
    }
}

/// The main Chat's header. It reads the chat's status and whether the chat is
/// on screen itself, so a change in either redraws it alone.
private struct ChatHeaderBar: View {
    let workspace: Workspace
    let store: TranscriptStore
    let onMenu: () -> Void
    let onAgent: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        ChatHeader(name: workspace.agentDisplayName, activity: workspace.mainChatActivity, announces: model.visibleChat == conciergeChatID, onMenu: onMenu, onAgent: onAgent, zoomSource: AgentZoom.source(conciergeChatID), showsMenu: false)
            .shareModeHeader(store.share)
    }
}

/// What shows under the main Chat's header: the access notice, the store's
/// banners and the push prompt. It reads their state itself, and the status
/// the header's capsule hangs under it with.
private struct ChatBanners: View {
    let workspace: Workspace
    let store: TranscriptStore
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// How far the header's status capsule reaches below the header row.
    private var statusOverhang: CGFloat {
        workspace.mainChatActivity?.statusLine == nil ? 0 : ChatIdentity.statusHeight(for: dynamicTypeSize)
    }

    /// Offered once Concierge is open, never while it loads or is off.
    private var offersPush: Bool {
        workspace.conciergeState == .ready && !workspace.isVisitor && model.push.offersPrompt()
    }

    var body: some View {
        VStack(spacing: 8) {
            if let hint = model.accessNotice {
                TopBanner(kind: .info, text: hint)
                    .onTapGesture { model.accessNotice = nil }
                    .task {
                        try? await Task.sleep(for: .seconds(5))
                        withAnimation { model.accessNotice = nil }
                    }
            }
            TranscriptBanners(store: store)
            if offersPush {
                PushPromptCard(
                    onTurnOn: { Task { await model.push.setEnabled(true) } },
                    onNotNow: { model.push.notNow() }
                )
                .padding(.horizontal, Metrics.pagePadding)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        // Below the header's status capsule, which hangs under the header row.
        .padding(.top, model.accessNotice != nil || TranscriptBanners.shows(store) || offersPush ? 10 + statusOverhang : 0)
        .readableColumn()
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.accessNotice)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: offersPush)
    }
}

/// One row of a Concierge chat, the main chat or a topic chat. It draws from
/// values (`row`, `info`) and acts through the store's `ChatActions`, and so
/// compares equal, and is not drawn again, while its message does not change.
struct ConciergeRow: View, Equatable {
    let row: TranscriptRow
    /// What the row draws from its message (`TranscriptStore.info(for:)`).
    let info: RowInfo
    let store: TranscriptStore
    let tasks: TasksStore
    /// Drawn in an open thread view: no thread labels, no share mode, and a
    /// tap on a message never closes the view.
    var inThread = false

    nonisolated static func == (lhs: ConciergeRow, rhs: ConciergeRow) -> Bool {
        lhs.row == rhs.row && lhs.info == rhs.info && lhs.store === rhs.store && lhs.tasks === rhs.tasks && lhs.inThread == rhs.inThread
    }

    @Environment(\.openTaskChat) private var openTaskChat

    /// From a row in a thread view, the thread closes first, or the chat
    /// would be pushed under it.
    private func openChat(_ chatId: String, _ title: String) {
        if inThread { store.closeThread() }
        openTaskChat?.run((chatId: chatId, title: title))
    }

    /// Only the Agent's text can be replied to: never a card of any kind
    /// (task, question, approval, open or folded), nor the guardian's own.
    static func offersReply(_ row: TranscriptRow) -> Bool {
        if case .agentText = row { return true }
        return false
    }

    /// The message's time, and Reply on the Agent's messages: the reply bar,
    /// with an open thread view kept open.
    private func menu(reply: Bool) -> BubbleMenu {
        let actions = store.actions
        let onReply: (() -> Void)? = reply
            ? row.messageId.map { id in { actions.reply(to: id) } }
            : nil
        // Share opens share mode on the message's turn; a pending send has none.
        let onShare: (() -> Void)? = inThread || !info.canShare ? nil : { [rowId = row.id] in actions.share(fromRow: rowId) }
        return BubbleMenu(date: info.date, onReply: onReply, onShare: onShare, inThread: inThread)
    }

    var body: some View {
        let actions = store.actions
        let _ = PerfProbe.count("rowBody")
        switch row {
        case .separator(_, let date):
            TimeSeparator(date: date)
        case .userText(let id, let text, let images, let pending):
            let replyId = row.messageId ?? ""
            let onQuote: (() -> Void)? = inThread || !info.quoteLeads ? nil : info.quote.map { quote in { actions.quote(reply: replyId, original: quote.messageId) } }
            UserBubble(text: text, images: images, pending: pending, onRetry: { actions.retry(id) }, onDelete: info.isPending ? { actions.remove(id) } : nil, menu: menu(reply: Self.offersReply(row)),
                       mark: info.mark,
                       quote: info.quote, onQuote: onQuote)
        case .agentText(_, let text, _, let forwardedFrom, let position):
            AgentBubble(text: text, forwardedFrom: forwardedFrom, position: position, onOpenChat: { openChat($0, $1) }, menu: menu(reply: Self.offersReply(row)))
        case .threadLabel(_, let messageId, let title):
            if !inThread {
                ThreadLabelLine(title: title) { actions.openThread(at: messageId) }
            }
        case .sourceLabel(_, let text):
            if !inThread { SourceLabelLine(text: text) }
        case .taskCard(_, let chatId, _, _, _) where tasks.isGone(chat: chatId):
            // Archived or deleted from this app.
            EmptyView()
        case .taskCard(_, let chatId, let title, let latest, let ask):
            let name = tasks.title(forChat: chatId, fallback: title)
            VStack(alignment: .leading, spacing: 8) {
                let state = tasks.cardState(forChat: chatId)
                TaskCard(
                    title: name,
                    state: state,
                    stopping: state.taskId.map { tasks.stopping.contains($0) } ?? false,
                    onStop: state.taskId.map { id in { tasks.stopTask(id: id) { store.stopTaskFailed() } } }
                ) {
                    openChat(chatId, name)
                }
                // The newest card from before `show` of a task that waits on
                // the guardian shows what it asks, answered right here.
                if latest, !inThread, let ask, TaskAskMode.of(card: ask, latest: true, task: tasks.task(forChat: chatId), tasksListed: tasks.listed) != .settled {
                    TaskAskView(chatId: chatId, card: ask, latest: true, tasks: tasks, store: store) { openChat(chatId, name) }
                }
            }
        case .taskAsk(_, let chatId, _, _, _) where tasks.isGone(chat: chatId):
            EmptyView()
        case .taskAsk(_, let chatId, let title, let card, let latest):
            TaskAskView(chatId: chatId, card: card, latest: latest, tasks: tasks, store: store) {
                openChat(chatId, tasks.title(forChat: chatId, fallback: title))
            }
            .keepsTaps(inThread)
        case .typing:
            TypingDots().frame(maxWidth: .infinity, alignment: .leading)
        case .approval, .question, .webOnly, .routineDraft, .tools, .connect, .widgetUI:
            // In a thread a tap on a card stays on it, never closing the thread.
            InteractionRow(row: row, store: store)
                .keepsTaps(inThread)
        case .error(_, let error):
            ErrorLine(error: error)
        case .notice(_, let text):
            NoticeLine(text: text)
        case .sessionRenewal(_, let reason, let sessionId):
            SessionRenewalLine(reason: reason)
        case .unreadDivider:
            UnreadDivider()
        }
    }
}

private extension View {
    /// Takes the taps on its own content, so they never reach a view behind.
    @ViewBuilder
    func keepsTaps(_ on: Bool) -> some View {
        if on { self.onTapGesture {} } else { self }
    }
}

/// The floating header: the drawer button, the Agent's identity and, in a
/// topic chat, the "…" menu.
struct ChatHeader: View {
    /// The Concierge's name, in the main chat and in topic chats alike.
    let name: String
    /// The chat's own title, atop the "…" menu: a topic chat's name.
    var menuTitle: String? = nil
    /// What the Concierge is doing here; nil shows the name alone.
    var activity: ConciergeActivity? = nil
    /// The chat is the one on screen: its status changes are read out.
    var announces = false
    let onMenu: () -> Void
    /// The mascot was tapped: the Agent page.
    let onAgent: () -> Void
    /// The avatar the Agent page zooms out of.
    var zoomSource: String? = nil
    /// The "…" menu; the main Chat has none, its right slot stays clear so
    /// the identity keeps the middle.
    var showsMenu = true
    /// A topic chat's options in the "…" menu.
    var onRename: (() -> Void)? = nil
    var onArchive: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil

    var body: some View {
        // The row is as tall as the identity with its name alone, so the
        // buttons never move. A status line grows the pill down, past the
        // row, over the transcript, never pushing it.
        HStack(alignment: .center) {
            GlassCircleButton(accessibilityLabel: "Open navigation", action: onMenu) {
                MenuGlyph()
            }
            ChatIdentity.Slot { ChatIdentity(name: name, activity: activity, announces: announces, zoomSource: zoomSource, onTap: onAgent) }
            if showsMenu {
                ChatMoreMenu(title: menuTitle ?? "", onRename: onRename, onArchive: onArchive, onDelete: onDelete)
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 4)
    }
}

/// A Concierge chat's identity at the top: a round avatar with the mascot,
/// a small name tag over its lower edge, and, while the Concierge does
/// something, the status in a capsule of its own below. A short name never
/// sits lost in a capsule stretched by a long status.
struct ChatIdentity: View {
    let name: String
    /// Nil or idle: the name alone, and the pill shrinks back.
    var activity: ConciergeActivity? = nil
    /// A copy laid over the header (a chat thread): no reactions to a tap.
    var still = false
    /// Read status changes out: only for the chat on screen, and only once
    /// (the header below a thread does it, not the copy over it).
    var announces = false

    /// The avatar the Agent page zooms out of.
    var zoomSource: String? = nil
    /// After the poke: the Agent page.
    var onTap: (() -> Void)? = nil

    @State private var pokes = 0
    @State private var haptic = UIImpactFeedbackGenerator(style: .soft)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.agentZoom) private var agentZoom

    /// What VoiceOver reads when the status changes: nothing for a chat
    /// that is not the one on screen.
    static func announcement(_ line: String?, announces: Bool) -> String? {
        announces ? line : nil
    }

    static let avatarSize: CGFloat = 50
    /// How far the name tag reaches up over the avatar's lower edge.
    static let overlap: CGFloat = 6
    /// The name tag's padding around its text.
    static let tagPadding = (horizontal: CGFloat(8), vertical: CGFloat(2.5))
    /// The widest the name runs before it is cut: about eight CJK characters.
    static func nameWidth(for size: DynamicTypeSize) -> CGFloat { ScaledFont.scaled(12, for: size) * 8.5 }
    /// The widest the status capsule grows, on an iPad too.
    static let statusWidth: CGFloat = 360
    /// The status capsule's height with its gap: what it adds below the
    /// header row, which banners under the header leave room for.
    static func statusHeight(for size: DynamicTypeSize) -> CGFloat {
        UIFont.systemFont(ofSize: ScaledFont.scaled(12, for: size), weight: .medium).lineHeight + 8 + 4
    }

    /// The identity's height with the name alone, at the current text size:
    /// what the header row is laid out for.
    static func restingHeight(for size: DynamicTypeSize) -> CGFloat {
        let name = UIFont.systemFont(ofSize: ScaledFont.scaled(12, for: size), weight: .medium).lineHeight
        return avatarSize - overlap + name + tagPadding.vertical * 2
    }

    /// Holds the identity at the top of a fixed-height slot: the slot is the
    /// resting height, and what grows below it overflows downward.
    struct Slot<Content: View>: View {
        @ViewBuilder var content: () -> Content
        @Environment(\.dynamicTypeSize) private var dynamicTypeSize

        var body: some View {
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: ChatIdentity.restingHeight(for: dynamicTypeSize))
                .overlay(alignment: .top) { content() }
        }
    }

    private var status: String? { activity?.statusLine }
    private var busy: Bool { activity?.isBusy ?? false }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 4) {
            VStack(spacing: -Self.overlap) {
                // A solid disc: two overlapping layers never share a color
                // (DESIGN.md 1). Busy, the mascot bobs and glances; at rest it
                // blinks; under Reduce Motion it stays still.
                Mascot(alive: busy && !reduceMotion, blinks: !reduceMotion, pokes: pokes)
                    .frame(height: 28)
                    .frame(width: Self.avatarSize, height: Self.avatarSize)
                    .background(Palette.elevated, in: Circle())
                    .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                    .shadow(color: Palette.avatarShadow, radius: 4, x: 0, y: 1)
                    // The Agent page grows out of the avatar.
                    .agentZoomSource(still ? nil : zoomSource, in: agentZoom)
                    // The avatar: a soft tap, a reaction, then the Agent page.
                    .contentShape(Circle())
                    .onTapGesture {
                        guard !still else { return }
                        haptic.impactOccurred()
                        haptic.prepare()
                        pokes += 1
                        onTap?()
                    }
                    .onAppear { if !still { haptic.prepare() } }
                // The name tag, over the avatar's lower edge; wider than the
                // avatar for a long name, cut at the end past about eight CJK
                // characters.
                CappedWidth(max: Self.nameWidth(for: dynamicTypeSize)) {
                    Text(verbatim: name)
                        .romeFont(12, .medium)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.horizontal, Self.tagPadding.horizontal)
                    .padding(.vertical, Self.tagPadding.vertical)
                    .modifier(HeaderCapsule())
                    .zIndex(1)
            }
            if let status {
                // The status in its own capsule: one muted line, cut at the end.
                StatusLine(text: status, shimmers: busy && !reduceMotion)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .modifier(HeaderCapsule())
                    .frame(maxWidth: Self.statusWidth)
            }
        }
        // A new status or name switches at once: no resize or fade. Only
        // those changes: the mascot's blink, bob and reactions keep theirs.
        .animation(nil, value: status)
        .animation(nil, value: name)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: status.map { "\(name), \($0)" } ?? name))
        .accessibilityAddTraits(still || onTap == nil ? .isHeader : [.isHeader, .isButton])
        .accessibilityAction { if !still { onTap?() } }
        .onChange(of: status) { _, line in
            // Read out politely, as the web's live region is.
            guard let line = Self.announcement(line, announces: announces) else { return }
            var announcement = AttributedString(line)
            announcement.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(announcement).post()
        }
    }
}

/// The surface of the header's name tag and status capsule: solid, like the
/// avatar, so rows scrolling under never show through the text (DESIGN.md 1).
private struct HeaderCapsule: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Palette.elevated, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.hair, lineWidth: 0.5))
            .shadow(color: Palette.avatarShadow, radius: 4, x: 0, y: 1)
    }
}

/// The header's status line: small and muted in every state, with a faint
/// left-to-right shimmer while the Concierge works.
private struct StatusLine: View {
    let text: String
    let shimmers: Bool
    @Environment(\.offScreen) private var offScreen

    var body: some View {
        let line = Text(verbatim: text)
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
        if shimmers {
            line.overlay {
                TimelineView(.animation(paused: offScreen)) { context in
                    let _ = PerfProbe.count("shimmerTick")
                    // One pass every two seconds, left to right.
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2
                    GeometryReader { geometry in
                        let band = geometry.size.width * 0.45
                        LinearGradient(colors: [.clear, Palette.fg.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: -band + (geometry.size.width + band) * phase)
                    }
                    .mask(line)
                }
                .allowsHitTesting(false)
            }
        } else {
            line
        }
    }
}

/// A menu title cut to one line at the end. A system menu wraps a long
/// title onto as many lines as it needs and ignores a line limit.
enum MenuTitle {
    /// The width a menu's section title gets: a system menu is about 250 pt
    /// wide on every phone and iPad and leaves about 190 pt for its title,
    /// so this keeps a margin for heavier text settings.
    static let width: CGFloat = 168

    static func oneLine(_ title: String, width: CGFloat = width, font: UIFont = .preferredFont(forTextStyle: .footnote, compatibleWith: UITraitCollection(legibilityWeight: .bold))) -> String {
        func fits(_ text: String) -> Bool {
            (text as NSString).size(withAttributes: [.font: font]).width <= width
        }
        guard !fits(title) else { return title }
        var characters = Array(title)
        while !characters.isEmpty {
            characters.removeLast()
            let cut = String(characters).trimmingCharacters(in: .whitespaces) + "…"
            if fits(cut) { return cut }
        }
        return "…"
    }
}

/// A topic chat's "…" button: its title in small grey text on top, then
/// the chat's own options and Shared links. The main Chat has no "…"
/// button; tasks are on the Agent page, from the mascot.
struct ChatMoreMenu: View {
    let title: String
    var onRename: (() -> Void)? = nil
    var onArchive: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil
    @Environment(\.chatShare) private var share

    var body: some View {
        Menu {
            Section {
                if let onRename {
                    Button(action: onRename) { Label("Rename", systemImage: "pencil") }
                }
                if let onArchive {
                    // Not red: an archived chat can come back.
                    Button(action: onArchive) { Label("Archive", systemImage: "archivebox") }
                }
                if let onDelete {
                    Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
                }
                ChatShareMenuItems(share: share)
            } header: {
                // A system menu wraps its title whatever the line limit: it is cut here.
                if !title.isEmpty { Text(verbatim: MenuTitle.oneLine(title)) }
            }
        } label: {
            Image(systemName: "ellipsis")
                .romeFont(17, .semibold)
                .foregroundStyle(Palette.fg)
                .frame(width: 44, height: 44)
                .glassSurface(Circle(), interactive: true)
        }
        .accessibilityLabel("More")
    }
}

/// A drawer page's header (Search): the drawer button at the left
/// and a plain title in the middle, as a topic chat has it.
struct DrawerPageHeader: View {
    let title: Text
    let onMenu: () -> Void

    var body: some View {
        HStack {
            GlassCircleButton(accessibilityLabel: "Open navigation", action: onMenu) {
                MenuGlyph()
            }
            PlainHeaderTitle(title: title)
            // Balances the button, so the title sits in the middle.
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .frame(height: 52)
        .headerFade()
    }
}

/// The fade a plain title needs; the main Chat's pill reads on its own.
/// A header title without a pill: one line of small semibold text, cut at
/// the end, centered between the side buttons.
struct PlainHeaderTitle: View {
    let title: Text

    var body: some View {
        title
            .romeFont(15, .semibold)
            .foregroundStyle(Palette.fg)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Three lines, the last one shorter.
struct MenuGlyph: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let scale = size.width / 20
            for (y, length) in [(6.0, 13.0), (10.0, 13.0), (14.0, 9.0)] {
                path.move(to: CGPoint(x: 3.5 * scale, y: y * scale))
                path.addLine(to: CGPoint(x: (3.5 + length) * scale, y: y * scale))
            }
            context.stroke(path, with: .color(Palette.fg), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
        }
        .frame(width: 20, height: 20)
    }
}

/// Three ticked rows.
struct ChecklistGlyph: View {
    var color: Color = Palette.fg

    var body: some View {
        Canvas { context, size in
            let s = size.width / 20
            var path = Path()
            for y in [5.2, 10.2, 15.2] {
                path.move(to: CGPoint(x: 3 * s, y: y * s))
                path.addLine(to: CGPoint(x: 4.4 * s, y: (y + 1.4) * s))
                path.addLine(to: CGPoint(x: 7 * s, y: (y - 1.2) * s))
                path.move(to: CGPoint(x: 9.8 * s, y: (y + 0.3) * s))
                path.addLine(to: CGPoint(x: 16.8 * s, y: (y + 0.3) * s))
            }
            context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 20, height: 20)
    }
}

/// A title, a line, and one button, centered: empty and error states.
struct CenteredMessage: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    /// No button when nil: there is nothing this person can do here.
    var actionTitle: LocalizedStringKey? = nil
    var action: () -> Void = {}

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            VStack(spacing: 8) {
                Text(title).romeFont(20, .semibold)
                Text(detail).romeFont(15).foregroundStyle(Palette.sub)
            }
            .multilineTextAlignment(.center)
            if let actionTitle {
                PrimaryButton(title: actionTitle, action: action)
                    .frame(maxWidth: 240)
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }
}

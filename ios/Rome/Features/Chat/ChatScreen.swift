import os
import SwiftUI

/// The transcript's scroll, for reading on a device: `log stream --predicate 'category == "TranscriptScroll"'`.
let transcriptScrollLog = Logger(subsystem: "cc.romeos.mobile", category: "TranscriptScroll")

/// Board 4: the Concierge chat, the app's home screen.
struct ChatScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    /// The header's mascot was tapped: the Agent page.
    let onAgent: () -> Void
    let onOpenChat: (String, String) -> Void
    /// Chat is the page in front, with nothing pushed over it.
    var visible = true

    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// How far the header's status capsule reaches below the header row.
    private var statusOverhang: CGFloat {
        let activity = workspace.topics.activity(for: workspace.mainChatServerID ?? conciergeChatID)
        return activity?.statusLine == nil ? 0 : ChatIdentity.statusHeight(for: dynamicTypeSize)
    }
    @State private var draft = ""
    @State private var composerFocused = false
    @State private var attachments = ComposerAttachments()

    private var store: TranscriptStore { workspace.concierge }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Under an open thread, VoiceOver reads the thread, not what it covers.
        .accessibilityHidden(store.thread != nil)
        // The bar is clear: the transcript scrolls under its glass items.
        .floatingTopBar {
            VStack(spacing: 0) {
                ChatHeader(name: workspace.agentDisplayName, activity: workspace.topics.activity(for: workspace.mainChatServerID ?? conciergeChatID), announces: model.visibleChat == conciergeChatID, onMenu: {
                    // The keyboard would stay up over the drawer.
                    composerFocused = false
                    onMenu()
                }, onAgent: onAgent, zoomSource: AgentZoom.source(conciergeChatID), showsMenu: false)
                .shareModeHeader(store.share)
                banners
            }
            .accessibilityHidden(store.thread != nil)
        }
        // Over the header and the transcript; the composer below stays in place.
        .overlay {
            if let thread = store.thread {
                ThreadOverlay(thread: thread, chat: store, tasks: workspace.tasks, name: workspace.agentDisplayName, activity: workspace.topics.activity(for: workspace.mainChatServerID ?? conciergeChatID), onOpenChat: onOpenChat) { store.closeThread() }
            }
        }
        // Reply brings the keyboard up; a label opens the thread for reading.
        .onChange(of: store.replies) { composerFocused = true }
        .pageBackground()
        // Also when the main chat's store is replaced by the one with its own id.
        .onChange(of: "\(store.sessionId)|\(visible)", initial: true) { store.onScreen = visible }
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
                        QuoteBar(message: store.quotedMessage) { store.cancelQuote() }
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if ConciergeStarters.visible(loaded: store.loaded, rows: store.rows) {
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
                .animation(.easeOut(duration: 0.2), value: store.rows.isEmpty)
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
    private var banners: some View {
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

    /// Offered once Concierge is open, never while it loads or is off.
    private var offersPush: Bool {
        workspace.conciergeState == .ready && !workspace.isVisitor && model.push.offersPrompt()
    }

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
            if store.loaded && store.rows.isEmpty {
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
                    ConciergeRow(row: row, store: store, tasks: workspace.tasks, onOpenChat: onOpenChat)
                        .tinted(store.tinted != nil && row.ownMessageId == store.tinted)
                        .shareSelectable(row, share: store.share, top: TranscriptSpacing.top(row, after: previous))
                }
                .onTapGesture { composerFocused = false }
                .onAppear { store.arrived() }
                .onChange(of: store.arrivals) { store.arrived() }
            }
        }
    }
}

/// One row of a Concierge chat, the main chat or a topic chat.
struct ConciergeRow: View {
    let row: TranscriptRow
    let store: TranscriptStore
    let tasks: TasksStore
    let onOpenChat: (String, String) -> Void
    /// Drawn in an open thread view: no thread labels, no share mode, and a
    /// tap on a message never closes the view.
    var inThread = false
    @Environment(AppModel.self) private var model

    /// The message's time, and Reply on the Agent's messages: the reply bar,
    /// with an open thread view kept open.
    private func menu(reply: Bool) -> BubbleMenu {
        let message = row.messageId.flatMap { store.message($0) ?? store.thread?.messages.first { [id = $0] in $0.id == id } }
        let onReply: (() -> Void)? = reply
            ? row.messageId.map { id in { store.reply(to: id) } }
            : nil
        // Share opens share mode on the message's turn; a pending send has none.
        let onShare: (() -> Void)? = inThread || message?.turnId == nil ? nil : { [row] in store.share.begin(fromRow: row.id) }
        return BubbleMenu(date: message?.date, onReply: onReply, onShare: onShare, inThread: inThread)
    }

    /// The quote a reply carries, on the first bubble of its message.
    private func quote(_ id: String) -> MessagePart.ReplyQuote? {
        guard let messageId = row.messageId, let message = store.message(messageId) ?? store.thread?.messages.first(where: { $0.id == messageId }) else { return nil }
        guard let first = message.parts.firstIndex(where: { $0.textContent != nil }), id == "\(messageId):\(first)" else { return nil }
        return message.parts.lazy.compactMap(\.replyQuote).first
    }

    var body: some View {
        switch row {
        case .separator(_, let date):
            TimeSeparator(date: date)
        case .userText(let id, let text, let images, let pending):
            let quote = quote(id)
            UserBubble(text: text, images: images, pending: pending, onRetry: { store.retry(id) }, onDelete: { store.removePending(id) }, menu: menu(reply: false),
                       mark: store.statusMark(ofRow: row),
                       quote: quote, onQuote: quote.flatMap { inThread ? nil : store.quoteAction(reply: row.messageId ?? "", original: $0.messageId) })
        case .agentText(_, let text, _, let forwardedFrom, let position):
            AgentBubble(text: text, forwardedFrom: forwardedFrom, position: position, onOpenChat: onOpenChat, menu: menu(reply: true))
        case .threadLabel(_, let messageId, let title):
            if !inThread {
                ThreadLabelLine(title: title) { store.openThread(at: messageId) }
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
                    onStop: state.taskId.map { id in { tasks.stopTask(id: id) } }
                ) {
                    onOpenChat(chatId, name)
                }
                // The newest card from before `show` of a task that waits on
                // the guardian shows what it asks, answered right here.
                if latest, !inThread, let ask, TaskAskMode.of(card: ask, latest: true, task: tasks.task(forChat: chatId)) != .settled {
                    TaskAskView(chatId: chatId, card: ask, latest: true, tasks: tasks, store: store) { onOpenChat(chatId, name) }
                }
            }
        case .taskAsk(_, let chatId, _, _, _) where tasks.isGone(chat: chatId):
            EmptyView()
        case .taskAsk(_, let chatId, let title, let card, let latest):
            TaskAskView(chatId: chatId, card: card, latest: latest, tasks: tasks, store: store) {
                onOpenChat(chatId, tasks.title(forChat: chatId, fallback: title))
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

    var body: some View {
        let line = Text(verbatim: text)
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
        if shimmers {
            line.overlay {
                TimelineView(.animation) { context in
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

/// A transcript that follows its bottom while the guardian is there, loads
/// older pages at the top, and offers a back-to-bottom button far up, with a
/// dot when something arrives while they read above it.
struct TranscriptList<Row: View>: View {
    let store: TranscriptStore
    var composerFocused = false
    /// Short transcripts sit at the top instead of the bottom (task chats).
    var alignTop = false
    /// Drawn after the last row, inside the scroll: the "Running…" line.
    var footer: AnyView? = nil
    /// Goes up when the newest rows must come into view (a tapped push).
    var latestRequest = 0
    @ViewBuilder let row: (TranscriptRow, TranscriptRow?) -> Row

    /// The list keeps the bottom in view. It turns off when the guardian scrolls
    /// away from the bottom and back on when they come back, never because
    /// content arrived.
    @State private var following = true
    @State private var bottomVisible = true
    /// No finger or fling is moving the scroll.
    @State private var atRest = true
    @State private var unseen = 0
    @State private var visibleHeight: CGFloat = 0
    /// The guardian is far above the newest rows: the back-to-bottom button shows.
    @State private var showsBackToBottom = false
    @State private var legacyScroll = LegacyScrollMonitor()
    @State private var scrollHandle = ScrollHandle()
    /// A scroll to the bottom is on its way. An older page waits for it to
    /// land: rows added under the animation would stop it short.
    @State private var jumping = false
    /// The bottom was on screen when the app left the foreground.
    @State private var leftAtBottom = false
    /// Until then, new last rows scroll into view: the refetch after a return
    /// or a push tap lands a moment after it.
    @State private var catchUpUntil: Date?
    /// A finger is on the list: an older page waits, so the rows under it
    /// never move. A glide does not hold it back.
    @State private var fingerDown = false
    /// Once the stack has gone lazy it stays lazy, so it changes kind at
    /// most once.
    @State private var lazyLocked = false
    /// How tall the rows are, without the space under short content.
    @State private var rowsHeight: CGFloat = 0

    /// Rows that do not reach well past the screen, with older pages behind
    /// them: no scroll up will ever come near the top, so older pages load
    /// now, one after another, until the screen is filled.
    static func needsOlderToFill(hasOlder: Bool, rowsHeight: CGFloat, visibleHeight: CGFloat) -> Bool {
        // Both measured: before that, a full screen reads as empty.
        hasOlder && visibleHeight > 0 && rowsHeight > 0 && rowsHeight < visibleHeight * 1.5
    }

    /// Up to this many rows a transcript is laid out all at once. A lazy
    /// stack guesses the height of rows it has not laid out, and a chat that
    /// mixes cards with short bubbles makes it guess wrong: the content then
    /// shrinks under the scroll as rows leave the screen, and the rows jump.
    /// A launch holds at most the kept rows and the newest page (about 90
    /// messages, well under this), so only paging far back reaches it.
    /// Past it the lazy stack's memory saving wins.
    static var eagerRowLimit: Int { 400 }

    /// Eager while the history held is short, older pages or not: they load
    /// by the scroll's position near the top, never by rows appearing, so an
    /// eager stack does not page through them. Past the limit the stack goes
    /// lazy, but only away from the bottom and at rest: switching rebuilds
    /// every row and leaves the new stack's guessed heights in the content
    /// size, which under a list on the bottom showed as a gap under the last
    /// message until the next touch. Once lazy, it stays lazy.
    static func isLazy(rows: Int, locked: Bool, following: Bool, atRest: Bool) -> Bool {
        locked || (rows > eagerRowLimit && !following && atRest)
    }

    var body: some View {
        let rows = store.rows
        let lazy = Self.isLazy(rows: rows.count, locked: lazyLocked, following: following, atRest: atRest)
        ScrollViewReader { proxy in
            ScrollView {
                TranscriptStack(lazy: lazy) {
                    // Older pages load by the scroll's position near the top
                    // (`DistanceFromBottom`, `LegacyContentMoves`): in an
                    // eager stack every row's onAppear runs at once.
                    if store.hasOlder {
                        Spinner(size: 16, color: Palette.sub)
                            .padding(.vertical, 12)
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                        row(item, index > 0 ? rows[index - 1] : nil)
                            .id(item.id)
                    }
                    if let footer {
                        footer
                    }
                    BottomMarker(visible: $bottomVisible, viewportBottom: visibleHeight, space: Self.scrollSpace) { distance in
                        // Before iOS 18 the marker's frame tells how far the bottom is.
                        let next = BackToBottom.shows(showsBackToBottom, distance: distance, height: visibleHeight)
                        if next != showsBackToBottom { showsBackToBottom = next }
                    }
                        .id("bottom")
                }
                .padding(.horizontal, Metrics.pagePadding)
                .readableColumn()
                .environment(\.shareTurns, store.share.isSelecting ? ShareTurns(messages: store.messages, rows: rows) : nil)
                // The rows' own height, before the space below fills it out.
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
                // Never shorter than the space between the bars. Content shorter
                // than that is held at the bottom by a top inset the scroll view
                // adds, and takes back a frame late once the rows outgrow the
                // screen: for that frame the rows sat far below their place, a
                // drop on every open. A list that fills its space needs no inset.
                .frame(minHeight: visibleHeight, alignment: alignTop ? .top : .bottom)
                .background(ScrollViewFinder(handle: scrollHandle))
                .modifier(LegacyContentMoves(monitor: legacyScroll, space: Self.scrollSpace, visibleHeight: visibleHeight) {
                    Task { await store.loadOlder() }
                })
            }
            .coordinateSpace(.named(Self.scrollSpace))
            .modifier(FollowBottom(following: $following, bottomVisible: bottomVisible, holdOlder: store.placingOlder, atRest: $atRest, jumping: $jumping, fingerDown: $fingerDown, legacy: legacyScroll, handle: scrollHandle))
            .onAppear { legacyScroll.attach(following: $following, atRest: $atRest, bottomVisible: $bottomVisible, jumping: $jumping, fingerDown: $fingerDown) }
            // The page goes in as soon as it is here, a glide included: its
            // offset shift keeps the rows in view where they are. Before iOS
            // 18 there is no shift, so it waits for the scroll to rest.
            .onChange(of: store.olderPage != nil && !jumping && (Self.placesInGlide ? !fingerDown : atRest)) { _, ready in
                if ready { Task { await store.placeOlderPage() } }
            }
            .scrollDismissesKeyboard(.interactively)
            .softTopScrollEdge()
            // The height between the bars. The content scrolls under them, but
            // the frame measured here, and the space named after it, stop at them.
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { visibleHeight = $0 }
            .onChange(of: following) { _, now in
                transcriptScrollLog.notice("following \(now, privacy: .public), bottom visible \(bottomVisible, privacy: .public)")
                unseen = BackToBottom.unseen(unseen, following: now)
            }
            .onChange(of: bottomVisible) { _, now in
                transcriptScrollLog.notice("bottom visible \(now, privacy: .public), height \(visibleHeight, privacy: .public)")
            }
            .task(id: "\(Self.needsOlderToFill(hasOlder: store.hasOlder, rowsHeight: rowsHeight, visibleHeight: visibleHeight))|\(store.messages.count)") {
                if Self.needsOlderToFill(hasOlder: store.hasOlder, rowsHeight: rowsHeight, visibleHeight: visibleHeight) {
                    await store.loadOlder()
                }
            }
            .onChange(of: lazy, initial: true) { _, now in
                if now { lazyLocked = true }
            }
            .onChange(of: rows.last?.id) {
                // Before iOS 18 a list that follows also scrolls to a new last
                // row itself, in case the anchor does not hold the bottom.
                if let until = catchUpUntil, Date.now < until {
                    scrollToBottom(proxy)
                } else if following && !Self.anchorFollowsBottom {
                    scrollToBottom(proxy)
                }
            }
            // The swipe home, or Notification Center pulled down, starts on the
            // list and reads as a drag away from the bottom. Where the list
            // stood when the app left decides instead.
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
                leftAtBottom = bottomVisible
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                guard leftAtBottom else { return }
                catchUp(proxy)
            }
            .onChange(of: latestRequest) { catchUp(proxy) }
            // A quote led to its original: it comes into view, mid-screen.
            .onChange(of: store.jumps) {
                guard let target = store.jumpTarget, let row = rows.first(where: { $0.ownMessageId == target }) else { return }
                _ = scrollHandle.stop()
                following = false
                withAnimation(.easeOut(duration: 0.35)) { proxy.scrollTo(row.id, anchor: .center) }
            }
            .onChange(of: store.pending.count) { old, new in
                if new > old { scrollToBottom(proxy) }
            }
            .onChange(of: store.arrivals) {
                if !following { unseen += 1 }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused {
                    Task {
                        try? await Task.sleep(for: .milliseconds(300))
                        scrollToBottom(proxy)
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if BackToBottom.visible(far: showsBackToBottom, unseen: unseen, following: following) {
                    // Outside the scroll's content, so a tap mid-glide reaches it.
                    Button {
                        transcriptScrollLog.notice("back-to-bottom tapped, phase \(atRest ? "rest" : "moving", privacy: .public)")
                        scrollToBottom(proxy)
                    } label: {
                        BackToBottomGlyph(dot: unseen > 0)
                    }
                    .buttonStyle(PressScaleStyle(scale: 0.9))
                    // About 12 pt above the composer, with the list's own inset.
                    .padding(.bottom, 4)
                    .accessibilityLabel(unseen > 0 ? Text("New messages. Scroll to the latest message") : Text("Scroll to the latest message"))
                    .transition(.scale(scale: 0.7).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.2), value: BackToBottom.visible(far: showsBackToBottom, unseen: unseen, following: following))
            .animation(.easeOut(duration: 0.2), value: unseen > 0)
            .modifier(DistanceFromBottom(visibleHeight: visibleHeight, showing: $showsBackToBottom, bottomVisible: $bottomVisible, onNearTop: {
                Task { await store.loadOlder() }
            }, onContentChange: { old, new in
                // An older page went in above the rows in view: move the offset
                // by what the content grew and the scroll did not follow, so the
                // rows stay where they are, mid-glide too.
                // Content that shrank under a resting list can leave its offset
                // past the new end: a gap under the last row, or a blank list,
                // until a scroll. Bring the offset back to the end.
                if new.contentHeight < old.contentHeight { scrollHandle.clampToEnd() }
                guard store.placingOlder else { return }
                let grew = new.contentHeight - old.contentHeight
                let followed = new.offset - old.offset
                if grew > 1 && abs(grew - followed) > 1 { scrollHandle.shift(by: grew - followed) }
            }))
        }
    }

    private static var scrollSpace: String { "transcript" }

    private static var placesInGlide: Bool {
        if #available(iOS 18, *) { return true }
        return false
    }

    private static var anchorFollowsBottom: Bool {
        if #available(iOS 18, *) { return true }
        return false
    }

    private func catchUp(_ proxy: ScrollViewProxy) {
        catchUpUntil = .now + 5
        scrollToBottom(proxy)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        // A fling still gliding wins over scrollTo, and the list glides on
        // as if nothing was asked. Stop it where it is first.
        let gliding = scrollHandle.stop()
        transcriptScrollLog.notice("scroll to bottom, stopped a glide: \(gliding, privacy: .public)")
        // Only when the list will move: the rest after it ends the jump.
        if gliding || !bottomVisible { jumping = true }
        following = true
        unseen = 0
        // Eases out onto the bottom: a spring would run past it and back.
        withAnimation(.easeOut(duration: 0.35)) { proxy.scrollTo("bottom", anchor: .bottom) }
    }
}

/// The transcript's stack: lazy for a long transcript, all at once for a
/// short one (`TranscriptList.eagerRowLimit`).
private struct TranscriptStack<Content: View>: View {
    let lazy: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        if lazy {
            LazyVStack(spacing: 0, content: content)
        } else {
            VStack(spacing: 0, content: content)
        }
    }
}

/// Where the transcript holds still as its content changes: it opens at the
/// bottom; while it follows the bottom, new content pushes up from there;
/// while the guardian reads further up, the rows they see stay put, also when
/// an older page lands above them.
private struct FollowBottom: ViewModifier {
    @Binding var following: Bool
    /// The bottom marker is on screen.
    let bottomVisible: Bool
    /// An older page is going in at the top; it must land above the rows in view.
    let holdOlder: Bool
    @Binding var atRest: Bool
    @Binding var jumping: Bool
    @Binding var fingerDown: Bool
    let legacy: LegacyScrollMonitor
    let handle: ScrollHandle
    /// A finger is on the list. Read only before iOS 18.
    @GestureState private var touching = false

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                // The role nearest the scroll view wins over the general anchor.
                // An older page placed above is held by its own offset shift
                // (`ScrollHandle.shift`), which works in a glide as well.
                .defaultScrollAnchor(following ? .bottom : .top, for: .sizeChanges)
                .defaultScrollAnchor(.bottom)
                .onScrollPhaseChange { old, phase, context in
                    transcriptScrollLog.notice("phase \(String(describing: old), privacy: .public) -> \(String(describing: phase), privacy: .public) at \(context.geometry.contentOffset.y, privacy: .public) of \(context.geometry.contentSize.height, privacy: .public), container \(context.geometry.containerSize.height, privacy: .public), insets \(context.geometry.contentInsets.top, privacy: .public)/\(context.geometry.contentInsets.bottom, privacy: .public), visible \(context.geometry.visibleRect.height, privacy: .public)")
                    atRest = phase == .idle || phase == .animating
                    if fingerDown != (phase == .interacting) { fingerDown = phase == .interacting }
                    switch phase {
                    case .interacting:
                        // A drag owns the scroll: nothing moves it from under the finger.
                        following = false
                    case .idle:
                        // Where a drag or fling comes to rest decides; a tap or a
                        // programmatic scroll only turns following back on.
                        if handle.stoppedForJump {
                            // Stopped for the jump to the bottom, which follows.
                            handle.stoppedForJump = false
                            following = true
                            return
                        }
                        jumping = false
                        if old == .interacting || old == .decelerating {
                            following = bottomVisible
                        } else if bottomVisible {
                            following = true
                        }
                    default:
                        break
                    }
                }
        } else {
            // One anchor serves the first offset and every size change here.
            // Following starts on, so the list still opens at the bottom.
            content
                .defaultScrollAnchor(following || holdOlder ? .bottom : .top)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 4)
                        .updating($touching) { _, touching, _ in touching = true }
                )
                .onChange(of: touching) { _, down in legacy.finger(down: down) }
        }
    }
}

/// The UIScrollView under the transcript, found from inside its content.
@MainActor
final class ScrollHandle {
    weak var view: UIScrollView?
    /// The glide was stopped to jump to the bottom: the rest that follows is
    /// not where the guardian left the list.
    var stoppedForJump = false

    /// Moves the content by `dy` without stopping a glide: what an older page
    /// added above the rows in view.
    func shift(by dy: CGFloat) {
        guard let view else { return }
        view.contentOffset.y += dy
        transcriptScrollLog.notice("shifted by \(dy, privacy: .public) to \(view.contentOffset.y, privacy: .public)")
    }

    /// Moves an offset left past the end of the content back to the end. A
    /// drag or a glide is left alone: its bounce past the end is its own.
    func clampToEnd() {
        guard let view, !view.isDragging, !view.isDecelerating else { return }
        guard let end = Self.clampedOffset(
            offset: view.contentOffset.y, contentHeight: view.contentSize.height, viewHeight: view.bounds.height,
            topInset: view.adjustedContentInset.top, bottomInset: view.adjustedContentInset.bottom
        ) else { return }
        transcriptScrollLog.notice("offset \(view.contentOffset.y, privacy: .public) past the end, back to \(end, privacy: .public)")
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: end), animated: false)
    }

    /// The end offset when `offset` lies past it, else nil. Content shorter
    /// than the view ends at its top.
    nonisolated static func clampedOffset(offset: CGFloat, contentHeight: CGFloat, viewHeight: CGFloat, topInset: CGFloat, bottomInset: CGFloat) -> CGFloat? {
        let end = max(contentHeight + bottomInset - viewHeight, -topInset)
        return offset > end + 0.5 ? end : nil
    }

    /// Stops a drag's glide where it is. Returns whether one was moving.
    func stop() -> Bool {
        guard let view, view.isDecelerating else { return false }
        stoppedForJump = true
        view.setContentOffset(view.contentOffset, animated: false)
        return true
    }
}

private struct ScrollViewFinder: UIViewRepresentable {
    let handle: ScrollHandle

    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.handle = handle
        probe.isUserInteractionEnabled = false
        return probe
    }

    func updateUIView(_ probe: Probe, context: Context) {
        probe.handle = handle
        probe.find()
    }

    final class Probe: UIView {
        weak var handle: ScrollHandle?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            find()
        }

        func find() {
            var view = superview
            while let current = view, !(current is UIScrollView) { view = current.superview }
            if let scroll = view as? UIScrollView { handle?.view = scroll }
        }
    }
}

/// Before iOS 18 there is no scroll phase to read, so this stands in for one:
/// a finger on the list, then the content offset going still for a moment,
/// is a drag or fling coming to rest. It writes the list's state only when
/// that changes, not on every scrolled frame.
@MainActor
private final class LegacyScrollMonitor {
    private var following: Binding<Bool>?
    private var atRest: Binding<Bool>?
    private var bottomVisible: Binding<Bool>?
    private var jumping: Binding<Bool>?
    private var fingerBinding: Binding<Bool>?
    private var userMoved = false
    private var fingerDown = false
    private var settle: Task<Void, Never>?

    func attach(following: Binding<Bool>, atRest: Binding<Bool>, bottomVisible: Binding<Bool>, jumping: Binding<Bool>, fingerDown: Binding<Bool>) {
        self.jumping = jumping
        fingerBinding = fingerDown
        self.following = following
        self.atRest = atRest
        self.bottomVisible = bottomVisible
    }

    func finger(down: Bool) {
        fingerDown = down
        if fingerBinding?.wrappedValue != down { fingerBinding?.wrappedValue = down }
        if down {
            userMoved = true
            following?.wrappedValue = false
            setAtRest(false)
            settle?.cancel()
        } else {
            moved()
        }
    }

    func moved() {
        setAtRest(false)
        settle?.cancel()
        settle = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self, !self.fingerDown else { return }
            self.comeToRest()
        }
    }

    private func comeToRest() {
        if jumping?.wrappedValue == true { jumping?.wrappedValue = false }
        setAtRest(true)
        let atBottom = bottomVisible?.wrappedValue ?? true
        if userMoved {
            following?.wrappedValue = atBottom
        } else if atBottom {
            following?.wrappedValue = true
        }
        userMoved = false
    }

    private func setAtRest(_ value: Bool) {
        if atRest?.wrappedValue != value { atRest?.wrappedValue = value }
    }
}

/// Reports content offset changes to the monitor before iOS 18.
private struct LegacyContentMoves: ViewModifier {
    let monitor: LegacyScrollMonitor
    let space: String
    /// The height between the bars.
    let visibleHeight: CGFloat
    /// Within 1.5 screens of the top of what is loaded: time to fetch the
    /// older page, as iOS 18 reads it from the scroll's geometry.
    var onNearTop: () -> Void = {}

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
        } else {
            content.onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .named(space)).minY
            } action: { minY in
                monitor.moved()
                // A load already on its way, or none left, makes this a no-op.
                if visibleHeight > 0, -minY < visibleHeight * 1.5 { onNearTop() }
            }
        }
    }
}

/// The space under the last row. It reports whether the bottom is on screen:
/// from the scroll view on iOS 18 and later, from its frame against the
/// visible area before. Appearing and disappearing would not tell, because a
/// lazy stack keeps it alive off screen.
/// When the back-to-bottom button shows: once the newest rows are more than
/// a screen below, and until they are back within 0.6 of one, so it does not
/// flicker at the line.
enum BackToBottom {
    static func shows(_ showing: Bool, distance: CGFloat, height: CGFloat) -> Bool {
        guard height > 0 else { return false }
        return distance > height * (showing ? 0.6 : 1)
    }

    /// How far the content's end is below the visible area, the bars' and
    /// keyboard's insets left out: 0 at the bottom, with the keyboard up too.
    static func distance(contentHeight: CGFloat, offset: CGFloat, topInset: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        contentHeight - (offset + topInset + visibleHeight)
    }

    /// Far from the bottom, or at any distance once something new arrived
    /// while the guardian reads above it.
    static func visible(far: Bool, unseen: Int, following: Bool) -> Bool {
        far || (unseen > 0 && !following)
    }

    /// The dot's count: gone once the list follows the bottom again, after a
    /// tap or a scroll down by hand.
    static func unseen(_ count: Int, following: Bool) -> Int {
        following ? 0 : count
    }
}

/// The arrow on the composer's glass, with a dot while something new waits below.
private struct BackToBottomGlyph: View {
    let dot: Bool
    @Environment(\.pageBackground) private var pageBackground

    var body: some View {
        Image(systemName: "arrow.down")
            .romeFont(16, .semibold)
            .foregroundStyle(Palette.fg)
            .frame(width: 40, height: 40)
            .glassSurface(Circle(), interactive: true, frost: Frost.composer)
            .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
            .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
            .overlay(alignment: .topTrailing) {
                if dot {
                    Circle()
                        .fill(Palette.primary)
                        .frame(width: 10, height: 10)
                        .padding(2)
                        .background(pageBackground, in: Circle())
                        .offset(x: 2, y: -2)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
    }
}

/// From iOS 18, the scroll's own geometry tells how far the bottom is.
private struct DistanceFromBottom: ViewModifier {
    struct Reading: Equatable {
        var nearTop: Bool
        var contentHeight: CGFloat
        var distance: CGFloat
        var offset: CGFloat
    }

    let visibleHeight: CGFloat
    @Binding var showing: Bool
    /// The bottom marker at least half on screen, from the offset: the
    /// marker's own visibility can report it seen at the top after a page lands.
    @Binding var bottomVisible: Bool
    /// Within 1.5 screens of the top of what is loaded: time to fetch the older page.
    var onNearTop: () -> Void = {}
    var onContentChange: (Reading, Reading) -> Void = { _, _ in }

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            // One reading for both ends: two on one view do not both fire.
            content.onScrollGeometryChange(for: Reading.self) { geometry in
                Reading(
                    nearTop: geometry.contentOffset.y + geometry.contentInsets.top < geometry.containerSize.height * 1.5,
                    // A page that lands while still near the top asks for the next.
                    contentHeight: geometry.contentSize.height,
                    distance: BackToBottom.distance(contentHeight: geometry.contentSize.height, offset: geometry.contentOffset.y, topInset: geometry.contentInsets.top, visibleHeight: geometry.containerSize.height),
                    offset: geometry.contentOffset.y
                )
            } action: { old, new in
                if abs(new.contentHeight - old.contentHeight) > 50 {
                    transcriptScrollLog.notice("content \(old.contentHeight, privacy: .public) -> \(new.contentHeight, privacy: .public), offset \(old.offset, privacy: .public) -> \(new.offset, privacy: .public)")
                }
                if old.contentHeight != new.contentHeight { onContentChange(old, new) }
                let atBottom = new.distance < BottomMarker.height / 2
                if atBottom != bottomVisible { bottomVisible = atBottom }
                if new.nearTop && (!old.nearTop || old.contentHeight != new.contentHeight) { onNearTop() }
                let distance = new.distance
                let next = BackToBottom.shows(showing, distance: distance, height: visibleHeight)
                if next != showing {
                    transcriptScrollLog.notice("back-to-bottom \(next ? "shows" : "hides", privacy: .public) at distance \(distance, privacy: .public)")
                    showing = next
                }
            }
        } else {
            content
        }
    }
}

private struct BottomMarker: View {
    static let height: CGFloat = 14
    @Binding var visible: Bool
    let viewportBottom: CGFloat
    let space: String
    /// Before iOS 18: how far below the visible area the bottom is.
    var onDistance: (CGFloat) -> Void = { _ in }
    /// Read only before iOS 18.
    @State private var midY: CGFloat = .infinity

    var body: some View {
        if #available(iOS 18, *) {
            // Whether it is on screen comes from the scroll's geometry.
            Color.clear
                .frame(height: Self.height)
        } else {
            Color.clear
                .frame(height: Self.height)
                // The position lives here, so a scrolled frame redraws only this view.
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.frame(in: .named(space)).midY
                } action: { midY = $0 }
                .onChange(of: midY <= viewportBottom, initial: true) { _, onScreen in visible = onScreen }
                .onChange(of: midY) { _, y in onDistance(y - viewportBottom) }
        }
    }
}

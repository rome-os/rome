import SwiftUI

/// Loads a stored upload's bytes; the shell sets it from the open instance.
/// The second argument is a width the server shrinks the picture to (600 or 900),
/// or nil for the original.
extension EnvironmentValues {
    @Entry var assetLoader: (@MainActor (String, Int?) async throws -> Data)? = nil
    /// An `/api/…` path and its percent-encoded query, fetched with the session.
    @Entry var apiFileLoader: (@MainActor (String, String?) async throws -> Data)? = nil
    /// The instance's origin: an absolute URL on it is one of its own.
    @Entry var instanceOrigin: URL? = nil
    /// Opens a link tapped in chat text; the shell sets it so app and
    /// instance links stay in the app.
    @Entry var chatLinkOpener: ShellAction<URL, OpenURLAction.Result>? = nil
    /// A dashboard admin, not the guardian: approvals are not theirs to answer.
    @Entry var isVisitor = false
    /// Opens a task chat in this window, over the page the row is on.
    @Entry var openTaskChat: ShellAction<(chatId: String, title: String), Void>? = nil
    /// The start of today, moved on at midnight by `RootView`. A view whose
    /// text says "Today" or "Yesterday" reads it: a row drawn from values is
    /// not drawn again on its own when the day turns.
    @Entry var today = Calendar.current.startOfDay(for: .now)
    /// The chat on screen, by its store's id: nil under a sheet, the drawer
    /// or a pushed page. A chat marks what arrives as read only while it is.
    @Entry var visibleChat: String? = nil
}

/// The guardian's bubble: coral, right-aligned, fully round. Photos sent with
/// it sit above the text.
/// The long-press menu of a message bubble: its time on top, then Reply
/// where a message can be replied to, Copy, Select text and Share.
struct BubbleMenu {
    /// When the message was written; nil leaves the title out.
    var date: Date? = nil
    /// Quotes the message in the reply bar; nil where there are no replies.
    var onReply: (() -> Void)? = nil
    /// Opens share mode on the message's turn; nil shares the text.
    var onShare: (() -> Void)? = nil
    /// A message that did not go through: its reason and what to do come first.
    var problem: SendProblem? = nil
}

/// The menu's items, shared by both bubbles.
private struct BubbleMenuItems: View {
    let text: String
    let menu: BubbleMenu
    /// Puts the message in select mode; nil where its text cannot be selected.
    let onSelect: (() -> Void)?
    @Environment(\.today) private var today

    var body: some View {
        // Read, so the header's "Today" follows the day.
        let _ = today
        if let problem = menu.problem {
            // Not sent, so there is nothing to reply to or share yet.
            SendProblemItems(problem: problem, text: text)
        } else {
        Section {
            if let onReply = menu.onReply {
                Button(action: onReply) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            }
            CopyButton(text: text)
            if let onSelect {
                Button(action: onSelect) { Label("Select text", systemImage: "selection.pin.in.out") }
            }
            if let onShare = menu.onShare {
                Button(action: onShare) { Label("Share", systemImage: "square.and.arrow.up") }
            } else {
                ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
            }
        } header: {
            if let date = menu.date { Text(verbatim: RelativeTime.separator(date)) }
        }
        }
    }
}

private extension View {
    /// The bubble lifts under the finger with the system's menu. Reply is
    /// also an action of its own
    /// for VoiceOver.
    /// `selects` says whether the text has anything Select text can select.
    func bubbleMenu(text: String, menu: BubbleMenu, selects: Bool) -> some View {
        modifier(BubbleMenuModifier(text: text, menu: menu, selects: selects))
    }
}

/// The bubble's menu, with Select text where the transcript has a select
/// mode. In select mode it has no menu: a long press there selects text.
private struct BubbleMenuModifier: ViewModifier {
    let text: String
    let menu: BubbleMenu
    /// The text has something to select: not only pictures or a table.
    let selects: Bool
    @Environment(\.textSelection) private var selection
    @Environment(\.transcriptRowID) private var rowID

    func body(content: Content) -> some View {
        let selecting = selection?.isSelecting(row: rowID, text: text) ?? false
        let onSelect: (() -> Void)? = {
            guard let selection, let rowID, selects else { return nil }
            return { [text] in selection.begin(row: rowID, text: text) }
        }()
        content
            .contextMenu {
                if !selecting { BubbleMenuItems(text: text, menu: menu, onSelect: onSelect) }
            }
            // A message that streams on, or is edited, leaves select mode.
            .onChange(of: text) { selection?.messageChanged(row: rowID, text: text) }
            .accessibilityActions {
                if menu.problem == nil, let onReply = menu.onReply {
                    Button("Reply", action: onReply)
                }
            }
    }
}

struct UserBubble: View {
    let text: String
    var images: [UserImage] = []
    let pending: PendingSend.State?
    var onRetry: () -> Void = {}
    /// Removes a send that cannot go through; nil leaves it out.
    var onDelete: (() -> Void)? = nil
    var menu = BubbleMenu()
    /// The badge on the message: Rome's status, else the Concierge's reaction.
    var mark: MessageMark? = nil
    /// What the message replies to, quoted at the top of the bubble, when it
    /// does not sit right under it.
    var quote: MessagePart.ReplyQuote? = nil
    /// The quote's tap: it goes to the original; nil leaves it plain.
    var onQuote: (() -> Void)? = nil
    @Environment(\.rowTinted) private var tinted
    @Environment(\.textSelection) private var selection
    @Environment(\.transcriptRowID) private var rowID
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The message has a bubble under its photos: text, or a quote drawn in it.
    private var hasBubble: Bool { !Self.badgeOnPhotos(text: text, quoteInBubble: quote != nil) }

    /// Where the mark sits: on the text bubble when there is one, and on the
    /// photos' corner only for photos sent alone.
    nonisolated static func badgeOnPhotos(text: String, quoteInBubble: Bool) -> Bool {
        text.isEmpty && !quoteInBubble
    }

    private var problem: SendProblem? {
        SendProblem(pending, onRetry: onRetry, onDelete: onDelete)
    }

    /// The long-press menu, with the problem first when the message has one.
    private var bubbleMenu: BubbleMenu {
        var menu = menu
        menu.problem = problem
        return menu
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                if let problem {
                    SendProblemIcon(problem: problem, text: text)
                }
                VStack(alignment: .trailing, spacing: 6) {
                    if !images.isEmpty {
                        UserImageGrid(images: images)
                            // Only photos alone carry it.
                            .markBadge(hasBubble ? nil : mark)
                    }
                    if hasBubble {
                        Group {
                            if !text.isEmpty {
                                Text(text)
                                    .romeFont(16)
                                    .lineSpacing(5)
                                    .foregroundStyle(.white)
                                    // Select mode lays a text view over it that
                                    // selects it but draws none of it, so the
                                    // text never moves as select mode starts or ends.
                                    .overlay(alignment: .topLeading) {
                                        if selection?.isSelecting(row: rowID, text: text) == true {
                                            SelectableTextView(
                                                text: SelectableText.invisible(SelectableText.plain(text, style: SelectableTextStyle(color: .white, dynamicTypeSize: dynamicTypeSize))),
                                                start: SelectionStart(point: selection?.target?.point, first: true), tint: .white)
                                        }
                                    }
                            }
                        }
                            .quotedAbove(quote, tone: .sent, hasContent: !text.isEmpty, onTap: onQuote)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Palette.primary, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .bubbleMenu(text: text, menu: bubbleMenu, selects: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .markBadge(mark)
                    }
                }
                .opacity(pending == .sending ? 0.55 : 1)
                // Behind the photos and the bubble, not the row.
                .tinted(tinted)
                .threadFocusHitArea()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 56)
        .animation(.easeOut(duration: 0.2), value: pending)
        .animation(.easeOut(duration: 0.15), value: mark)
    }
}

private extension View {
    /// The message's badge on the top leading corner of its text bubble, or of
    /// its photos when they come with no text, over the corner and clear of
    /// the first line's start.
    func markBadge(_ mark: MessageMark?) -> some View {
        overlay(alignment: .topLeading) {
            if let mark {
                StatusMarkBadge(mark: mark)
                    .offset(x: -StatusMarkBadge.size / 2, y: -StatusMarkBadge.size / 2)
                    .transition(.opacity)
            }
        }
    }
}

/// One photo large, or two to a row.
private struct UserImageGrid: View {
    let images: [UserImage]
    @State private var showViewer = false
    @State private var viewerStart = 0

    /// The pictures of the message, for the viewer; other files stay tiles.
    private var gallery: [ViewerImage] {
        images.compactMap { image in
            switch image {
            case .local(let photo): return photo.thumbnail == nil ? nil : .local(photo)
            case .stored(let upload): return upload.isImage ? .stored(upload) : nil
            }
        }
    }

    private func open(_ image: UserImage) {
        let id: String
        switch image {
        case .local(let photo): id = photo.id.uuidString
        case .stored(let upload): id = upload.linkPath
        }
        guard let start = gallery.firstIndex(where: { $0.id == id }) else { return }
        viewerStart = start
        showViewer = true
    }

    var body: some View {
        let side: CGFloat = images.count == 1 ? 200 : 110
        let count = min(2, images.count)
        let columns = Array(repeating: GridItem(.fixed(side), spacing: 6), count: count)
        // A grid takes the whole width, its tiles trailing. Held to its tiles,
        // its leading corner is the first photo's, where the badge goes.
        let width = CGFloat(count) * side + CGFloat(count - 1) * 6
        LazyVGrid(columns: columns, alignment: .trailing, spacing: 6) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                UserImageTile(image: image)
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture { open(image) }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Opens the photo full screen")
            }
        }
        .frame(width: width)
        .fullScreenCover(isPresented: $showViewer) {
            PhotoViewer(images: gallery, start: viewerStart)
        }
    }
}

private struct UserImageTile: View {
    let image: UserImage
    /// A width the server offers; the tile only needs a small thumbnail.
    private static let assetWidth = 600
    @Environment(\.assetLoader) private var assetLoader
    @Environment(\.apiFileLoader) private var apiLoader
    @State private var loaded: CGImage?
    @State private var failed = false

    init(image: UserImage) {
        self.image = image
        // Already in memory, it shows in the first frame, with no spinner.
        if case .stored(let upload) = image {
            _loaded = State(initialValue: StoredImageCache.shared.image(StoredImageCache.shared.key(upload.assetPath)))
        }
    }

    var body: some View {
        switch image {
        case .local(let photo):
            if let thumbnail = photo.thumbnail {
                Image(decorative: thumbnail, scale: 1).resizable().scaledToFill()
                    .accessibilityLabel("Photo")
            } else {
                attachmentLabel(nil)
            }
        case .stored(let upload):
            if let loaded {
                Image(decorative: loaded, scale: 1).resizable().scaledToFill()
                    .accessibilityLabel("Photo")
            } else if !upload.isImage || (assetLoader == nil && apiLoader == nil) {
                attachmentLabel(upload.name)
            } else if failed {
                // Offline for a moment, say: a tap, or the next time it scrolls in, tries again.
                ImageFailedTile(label: upload.name)
                    .onTapGesture { failed = false }
                    .onDisappear { failed = false }
            } else {
                Palette.fill
                    .overlay { Spinner(size: 16, color: Palette.sub) }
                    .task(id: upload) { await load(upload) }
            }
        }
    }

    private func load(_ upload: UploadLines.Upload) async {
        do {
            loaded = try await StoredImageCache.shared.load(
                upload.assetPath, maxPixel: ComposerImage.thumbnailPixels, onDisk: upload.source.isStoredAsset
            ) {
                try await ImageFetch.data(
                    upload.source, assetLoader: assetLoader, apiLoader: apiLoader, width: Self.assetWidth
                )
            }
        } catch is CancellationError {
            // Scrolled away mid-load: the next appear loads it.
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    /// A file that cannot be shown as a picture.
    private func attachmentLabel(_ name: String?) -> some View {
        Palette.fill.overlay {
            VStack(spacing: 4) {
                Image(systemName: "paperclip").romeFont(16, .medium)
                Text("Attachment").romeFont(12, .medium)
            }
            .foregroundStyle(Palette.sub)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name.map { Text(verbatim: $0) } ?? Text("Attachment"))
    }
}

/// The agent's bubble. In a run of bubbles the first keeps a small bottom-left
/// corner and the last a small top-left corner, as on the design's Chat board.
/// Every reply sits in a bubble, a long one too: past about twenty-five lines it
/// folds under a soft fade, with a small chevron below to unfold it.
struct AgentBubble: View {
    let text: String
    let forwardedFrom: MessagePart.ForwardedFrom?
    let position: BubblePosition
    var onOpenChat: (String, String) -> Void = { _, _ in }
    var menu = BubbleMenu()
    /// What the message replies to, quoted at the top of the bubble, when it
    /// does not sit right under it.
    var quote: MessagePart.ReplyQuote? = nil
    /// The quote's tap: it goes to the original; nil leaves it plain.
    var onQuote: (() -> Void)? = nil
    #if DEBUG
    /// Snapshot runs only: long bubbles open unfolded.
    static var startsExpanded = false
    #else
    static let startsExpanded = false
    #endif
    @State private var expanded = AgentBubble.startsExpanded
    /// The reply's laid-out height, measured: Chinese fits far fewer
    /// characters on a line than English, so characters cannot tell.
    @State private var fullHeight: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.rowTopHold) private var rowTopHold
    @Environment(\.transcriptRowID) private var rowID
    @Environment(\.textSelection) private var selection

    /// How many lines a bubble shows before it folds.
    nonisolated static let foldedLines = 25

    /// The height of `foldedLines` lines of body text at a text size.
    nonisolated static func foldHeight(for size: DynamicTypeSize) -> CGFloat {
        let fontSize = ScaledFont.scaled(16, for: size)
        // The system font's line height is about 1.2 em; MarkdownText adds 5 pt between lines.
        return CGFloat(foldedLines) * (fontSize * 1.2 + 5)
    }

    /// Whether text that lays out `height` tall folds.
    nonisolated static func folds(height: CGFloat, size: DynamicTypeSize) -> Bool {
        height > foldHeight(for: size) + 1
    }

    private var shape: UnevenRoundedRectangle {
        let big = Metrics.bubbleRadius
        let small = Metrics.bubbleTight
        let topLeft = position == .last || position == .middle ? small : big
        let bottomLeft = position == .first || position == .middle ? small : big
        return UnevenRoundedRectangle(
            topLeadingRadius: topLeft, bottomLeadingRadius: bottomLeft,
            bottomTrailingRadius: big, topTrailingRadius: big, style: .continuous
        )
    }

    private var selecting: Bool { selection?.isSelecting(row: rowID, text: text) == true }
    /// How far a selection handle's knob reaches past the text.
    private static let handleRoom: CGFloat = 24

    /// Where the fold hides the text, down from its top: above the fade over
    /// the last folded lines, where the text is still in sight.
    private var foldBottom: CGFloat { Self.foldHeight(for: dynamicTypeSize) - Self.fadeHeight }
    /// The fade over a folded reply's last lines (`expandButton`).
    static let fadeHeight: CGFloat = 40

    private var folds: Bool { Self.folds(height: fullHeight, size: dynamicTypeSize) }
    /// Held to the folded height until it is measured, so a long reply is
    /// folded from its first frame. Unfolded first, it shrank by hundreds of
    /// points after the list had placed its bottom.
    private var capped: Bool { Self.capped(measured: fullHeight, expanded: expanded, size: dynamicTypeSize) }

    /// Whether the text is held to the folded height: until it is measured
    /// (`measured` is 0), and while a long one is folded. Select mode leaves
    /// the fold as it is: its first selection is the paragraph pressed, which
    /// is in sight, and text inside the fold is selected once it is unfolded.
    nonisolated static func capped(measured: CGFloat, expanded: Bool, size: DynamicTypeSize) -> Bool {
        !expanded && (measured == 0 || folds(height: measured, size: size))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownText(source: text, selectable: selecting, selectFrom: selection?.target?.point,
                         foldBottom: selecting && capped ? foldBottom : nil)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: capped ? Self.foldHeight(for: dynamicTypeSize) : nil, alignment: .top)
                // In select mode the clip leaves room for the selection's
                // handles above and beside the text; folded, it still hides
                // the text under the fold.
                .clipShape(FoldClip(handleRoom: selecting ? Self.handleRoom : 0, folded: capped))
                .overlay(alignment: .bottom) {
                    // Folded, the chevron sits on the fade over the last
                    // lines, so the bubble does not grow for it.
                    if folds && !expanded { expandButton }
                }
            // Open, it sits right under the last line.
            if folds && expanded { expandButton.padding(.top, -6) }
        }
        .quotedAbove(quote, tone: .received, onTap: onQuote)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Palette.bubble, in: shape)
        .threadFocusHitArea()
        .contentShape(.contextMenuPreview, shape)
        .bubbleMenu(text: text, menu: menu, selects: MarkdownText.hasSelectableText(text))
        .bubbleWidth()
    }

    /// A small grey chevron, centred. Folded, its backdrop is the fade into
    /// the bubble's colour; open, it stands alone. Either way it lays out
    /// short and taps 44 pt tall: the tap area reaches past its frame.
    private var expandButton: some View {
        Button(action: toggle) {
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .romeFont(13, .semibold)
                .foregroundStyle(Palette.sub.opacity(0.6))
                .frame(maxWidth: .infinity, minHeight: expanded ? 16 : Self.fadeHeight, alignment: .bottom)
                .background {
                    if !expanded {
                        LinearGradient(colors: [Palette.bubble.opacity(0), Palette.bubble], startPoint: .top, endPoint: .bottom)
                    }
                }
                .contentShape(Rectangle().inset(by: expanded ? -14 : -4))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? Text("Show less") : Text("Show more"))
    }

    private func toggle() {
        // The bubble opens downward and closes upward: its top, and every
        // row above it, stay where they are.
        if let rowID { rowTopHold?.hold(rowID) }
        // In one step: animated, the bubble's height eased inside a cell UIKit
        // had already given its new height, so the text dipped and rose.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { expanded.toggle() }
    }
}

/// What the Concierge said in a task chat it started (rome-os/rome#1976):
/// on the guardian's side, since it speaks for them, but in a neutral
/// bubble under its own name and mascot, so it never reads as the guardian.
struct ConciergeBubble: View {
    let name: String
    let text: String
    var menu = BubbleMenu()
    @Environment(\.textSelection) private var selection
    @Environment(\.transcriptRowID) private var rowID

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 4) {
                Text(verbatim: name)
                    .romeFont(12)
                    .foregroundStyle(Palette.sub)
                    .lineLimit(1)
                MarkdownText(source: text, selectable: selection?.isSelecting(row: rowID, text: text) == true, selectFrom: selection?.target?.point)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Palette.bubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .bubbleMenu(text: text, menu: menu, selects: MarkdownText.hasSelectableText(text))
            }
            Mascot()
                .frame(height: 16)
                .frame(width: 28, height: 28)
                .background(Palette.elevated, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                .padding(.top, 18)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

struct CopyButton: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }
}

/// A task the Concierge started, as a card in the chat: the label and the
/// title. The label says only what the task chat says live: Working or Needs
/// you. It has no Stop; Stop is on the Tasks tab's row.
struct TaskCard: View {
    let title: String
    /// How the task chat stands; nil keeps the bare "Task".
    var state: TaskCardState? = nil
    let action: () -> Void

    /// The line above the title.
    private var label: String {
        guard let state else { return String(localized: "Task") }
        guard let word = state.word else { return String(localized: "Task chat") }
        return String(localized: "Task chat · \(word)")
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: label)
                    .romeFont(CardScale.label)
                    .foregroundStyle(Palette.sub)

                HStack(spacing: 8) {
                    Text(title)
                        .romeFont(CardScale.body, .semibold)
                        .foregroundStyle(Palette.fg)
                        .multilineTextAlignment(.leading)
                }
            }
            // One width whatever the state line says, so a state change never moves the card's edge.
            .fillsBubbleWidth()
            .cardPadding()
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .softElevation(radius: Metrics.cardRadius)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .bubbleWidth()
        .accessibilityLabel(Text(verbatim: "\(label), \(title)"))
        .accessibilityIdentifier("task-card")
    }
}

struct TimeSeparator: View {
    let date: Date
    @Environment(\.today) private var today

    var body: some View {
        // Read, so "Today" becomes "Yesterday" when the day turns.
        let _ = today
        Text(RelativeTime.separator(date))
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The spacing above a row, which carries the design's rhythm: 2 pt inside a
/// run of replies to one message, 8 pt between other bubbles, 18 pt when the
/// sender changes, room around time separators.
enum TranscriptSpacing {
    static func top(_ row: TranscriptRow, after previous: TranscriptRow?) -> CGFloat {
        guard let previous else { return 8 }
        if case .separator = row { return 20 }
        if case .separator = previous { return 14 }
        if case .typing = row { return 14 }
        if case .notice = row { return 14 }
        if case .providerOutage = row { return 14 }
        // A faint line stands apart, like a time separator.
        switch (row, previous) {
        case (.sessionRenewal, _), (_, .sessionRenewal), (.unreadDivider, _), (_, .unreadDivider): return 14
        default: break
        }
        // Tight under its own message, and apart from the next one.
        if case .sourceLabel = row { return 3 }
        if case .sourceLabel = previous { return row.isGuardian ? 18 : 14 }
        if row.isGuardian != previous.isGuardian { return 18 }
        if row.isGuardian { return 6 }
        switch (row, previous) {
        case (.agentText(_, _, _, _, let position), .agentText(_, _, _, _, let above)):
            return position.joinsAbove && above.joinsBelow ? 2 : 8
        case (.taskCard, .agentText), (.agentText, .taskCard), (.taskCard, .taskCard): return 6
        case (.taskAsk, .agentText), (.agentText, .taskAsk): return 6
        default: return 12
        }
    }
}

/// The clip of a reply's text: `handleRoom` past its top and sides for a
/// selection's handles, and past its bottom too unless the reply is folded,
/// whose text below the fold stays hidden.
struct FoldClip: Shape {
    let handleRoom: CGFloat
    let folded: Bool

    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX - handleRoom, y: rect.minY - handleRoom,
                    width: rect.width + handleRoom * 2,
                    height: rect.height + handleRoom + (folded ? 0 : handleRoom)))
    }
}

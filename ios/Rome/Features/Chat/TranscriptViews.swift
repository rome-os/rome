import PhotosUI
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
/// where a message can be replied to, Copy and Share.
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
    /// The bubble lifts under the finger with the system's menu.
    func bubbleMenu(text: String, menu: BubbleMenu) -> some View {
        contextMenu { BubbleMenuItems(text: text, menu: menu) }
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
                            }
                        }
                            .quotedAbove(quote, tone: .sent, hasContent: !text.isEmpty, onTap: onQuote)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Palette.primary, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .bubbleMenu(text: text, menu: bubbleMenu)
                            .markBadge(mark)
                    }
                }
                .opacity(pending == .sending ? 0.55 : 1)
                // Behind the photos and the bubble, not the row.
                .tinted(tinted)
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
            loaded = try await StoredImageCache.shared.load(upload.assetPath, maxPixel: ComposerImage.thumbnailPixels) {
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
/// Every reply sits in a bubble, a long one too: past about fifteen lines it
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

    /// How many lines a bubble shows before it folds.
    nonisolated static let foldedLines = 15

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

    private var folds: Bool { Self.folds(height: fullHeight, size: dynamicTypeSize) }
    /// Held to the folded height until it is measured, so a long reply is
    /// folded from its first frame. Unfolded first, it shrank by hundreds of
    /// points after the list had placed its bottom.
    private var capped: Bool { Self.capped(measured: fullHeight, expanded: expanded, size: dynamicTypeSize) }

    /// Whether the text is held to the folded height: until it is measured
    /// (`measured` is 0), and while a long one is folded.
    nonisolated static func capped(measured: CGFloat, expanded: Bool, size: DynamicTypeSize) -> Bool {
        !expanded && (measured == 0 || folds(height: measured, size: size))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownText(source: text)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: capped ? Self.foldHeight(for: dynamicTypeSize) : nil, alignment: .top)
                .clipped()
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
        .contentShape(.contextMenuPreview, shape)
        .bubbleMenu(text: text, menu: menu)
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
                .frame(maxWidth: .infinity, minHeight: expanded ? 16 : 40, alignment: .bottom)
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

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 4) {
                Text(verbatim: name)
                    .romeFont(12)
                    .foregroundStyle(Palette.sub)
                    .lineLimit(1)
                MarkdownText(source: text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Palette.bubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .bubbleMenu(text: text, menu: menu)
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

/// The capsule composer: a growing text field and a round send button.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    /// Set when `placeholder` names something: a long name is shortened to fit.
    var named: NamedPlaceholder? = nil
    var stopVisible = false
    var stopping = false
    @Binding var focused: Bool
    /// Photos to send with the message; nil leaves out the +.
    var attachments: ComposerAttachments? = nil
    /// The instance's voice input; nil (demo data, previews) shows no control.
    var voiceInput: VoiceInputService? = nil
    /// The chat this field writes in, so voice input stopped by leaving it
    /// says why on return; nil keeps no such notice.
    var voiceKey: String? = nil
    /// Which field this is, for the voice input start's signpost.
    var voiceField: VoiceInputField = .chat
    /// False while the field's chat is covered or hidden but still mounted
    /// (Chat under another section, a sheet, the drawer): listening stops.
    var onScreen = true
    let onSend: () -> Void
    var onStop: () -> Void = {}

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var multiline = false
    @State private var composerWidth: CGFloat = 300
    @State private var editorHeight: CGFloat?
    @State private var overflows = false
    @State private var voice = VoiceInputController()
    @State private var textHandle = ComposerTextHandle()
    @State private var choosingPhotos = false
    @State private var takingPhoto = false
    @State private var picked: [PhotosPickerItem] = []
    /// The text without what an input method is still composing (pinyin).
    @State private var committedText = ""

    /// The + and Send sit on the text's last line, 36 pt tall.
    private var controlPadding: CGFloat {
        ComposerTextView.controlBottomPadding(height: 36, size: dynamicTypeSize)
    }

    private var hasPhotos: Bool { !(attachments?.images.isEmpty ?? true) }
    private var canSend: Bool {
        guard !(attachments?.isPreparing ?? false) else { return false }
        // Sending waits for the spoken words to land.
        guard !voice.active else { return false }
        return !committedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos
    }

    private var usesRows: Bool {
        focused || multiline || text.contains("\n") || expanded || hasPhotos || voice.active || dynamicTypeSize.isAccessibilitySize
    }

    private var shapeAnimation: Animation? {
        reduceMotion ? nil : .smooth(duration: 0.32, extraBounce: 0)
    }

    private var compactWidth: CGFloat {
        composerWidth - compactGutter * 2 - leadingInset(rows: false) - trailingInset(rows: false)
    }

    private var compactGutter: CGFloat { composerWidth >= 340 ? 24 : 0 }
    private var showsExpansion: Bool { (overflows || expanded) && !voice.active }

    private func leadingInset(rows: Bool) -> CGFloat { rows || attachments == nil ? 18 : 51 }
    private func trailingInset(rows: Bool) -> CGFloat { rows ? 18 : (voiceInput?.available ?? false) ? 95 : 51 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = voice.notice {
                VoiceInputNotice(stop: notice)
                    .padding(.top, 10)
                    .padding(.horizontal, 18)
            }
            if let attachments, !attachments.images.isEmpty || attachments.preparing > 0 {
                ComposerThumbnails(attachments: attachments)
                    .padding(.top, 10)
                    .padding(.leading, 12)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            // One editor and one set of controls retain focus and move through the morph.
            ComposerTextView(
                text: $text,
                focused: $focused,
                placeholder: placeholder,
                named: named,
                onPasteImages: attachments.map { attachments in
                    { providers in Task { await attachments.add(providers: providers) } }
                },
                committedText: $committedText,
                handle: textHandle,
                editable: !voice.active,
                onReturn: returnSends,
                onEdit: { voice.edited(service: voiceInput, chat: voiceKey) },
                expanded: expanded,
                compactWidth: compactWidth,
                onMeasure: { multiple, height, overflow in
                    var transaction = Transaction()
                    transaction.disablesAnimations = editorHeight == nil || !onScreen
                    withTransaction(transaction) {
                        if multiline != multiple { multiline = multiple }
                        if editorHeight == nil || abs((editorHeight ?? 0) - height) > 0.5 { editorHeight = height }
                        if overflows != overflow { overflows = overflow }
                        if !overflow { expanded = false }
                    }
                }
            )
            .frame(height: editorHeight)
            .padding(.leading, leadingInset(rows: usesRows))
            .padding(.trailing, trailingInset(rows: usesRows))
            .padding(.bottom, usesRows ? 44 : 0)
            .overlay(alignment: .bottomLeading) {
                if let attachments {
                    plusMenu(attachments)
                        .padding(.leading, 7)
                        .padding(.bottom, usesRows ? 7 : controlPadding)
                }
            }
            .overlay(alignment: .bottom) {
                if voice.state == .listening {
                    VoiceInputWaveform(meter: voice.meter)
                        .padding(.horizontal, 96)
                        .padding(.bottom, 7 + (36 - VoiceInputWaveform.height) / 2)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                HStack(spacing: 0) {
                    Button {
                        expanded.toggle()
                    } label: {
                        Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                            .romeFont(15, .medium)
                            .foregroundStyle(Palette.sub)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel(expanded ? String(localized: "Collapse input") : String(localized: "Expand input"))
                    .accessibilityIdentifier("composer-expand")
                    .opacity(showsExpansion ? 1 : 0)
                    .frame(width: showsExpansion ? 44 : 0)
                    .clipped()
                    .allowsHitTesting(showsExpansion)
                    .accessibilityHidden(!showsExpansion)
                    HStack(spacing: 8) { controls }
                }
                .padding(.trailing, 7)
                .padding(.bottom, usesRows ? 7 : controlPadding)
            }
        }
        .frame(minHeight: ComposerTextView.minHeight)
        .onChange(of: text.isEmpty) { _, empty in if empty { expanded = false } }
        // Frosted glass: the transcript behind blurs out so the placeholder
        // reads. In light the glass alone barely parts from the page, so it
        // keeps an edge.
        .glassSurface(RoundedRectangle(cornerRadius: 25, style: .continuous), interactive: true, frost: Frost.composer)
        .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
        .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
        .padding(.horizontal, usesRows ? 0 : compactGutter)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { composerWidth = $0 }
        .animation(shapeAnimation, value: usesRows)
        .animation(shapeAnimation, value: showsExpansion)
        .animation(shapeAnimation, value: expanded)
        .animation(shapeAnimation, value: editorHeight)
        // The main Chat stays mounted under other sections, so it asks again on each return.
        .task(id: onScreen) { if onScreen { await voiceInput?.refresh() } }
        .onAppear { voice.arrive(service: voiceInput, chat: voiceKey) }
        .onDisappear { voice.leave(service: voiceInput, chat: voiceKey) }
        .onChange(of: voice.state) { voice.stateShown() }
        .onChange(of: onScreen) { _, now in
            if now {
                voice.arrive(service: voiceInput, chat: voiceKey)
            } else {
                voice.leave(service: voiceInput, chat: voiceKey)
                expanded = false
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: canSend)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: stopVisible)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: attachments?.images.count)
        .photosPicker(
            isPresented: $choosingPhotos,
            selection: $picked,
            maxSelectionCount: max(1, attachments?.remaining ?? 1),
            matching: .images
        )
        .onChange(of: picked) { _, items in
            guard !items.isEmpty, let attachments else { return }
            picked = []
            // The slots are held before loading: a spinner shows, the + and
            // Send wait, and nothing picked is dropped.
            let taken = attachments.reserve(items.count)
            guard taken > 0 else { return }
            Task {
                var files: [Data] = []
                for item in items.prefix(taken) {
                    if let data = try? await item.loadTransferable(type: Data.self) { files.append(data) }
                }
                await attachments.fill(reserved: taken, data: files)
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                guard let attachments else { return }
                Task { await attachments.add(images: [image]) }
            }
            .ignoresSafeArea()
        }
    }

    /// Return on a hardware keyboard while listening: listening ends, and the
    /// message is sent once the last words are in. Shift-Return does nothing.
    private var returnSends: (() -> Void)? {
        guard voice.active else { return nil }
        return sendWhenHeard
    }

    private func sendWhenHeard() {
        voice.stopAndSend {
            guard !(attachments?.isPreparing ?? false),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos
            else { return }
            voice.edited(service: voiceInput, chat: voiceKey)
            onSend()
        }
    }

    /// The voice control, and Send or the turn's stop.
    @ViewBuilder private var controls: some View {
        if let voiceInput, voiceInput.available {
            VoiceInputButton(state: voice.state) {
                voice.toggle(service: voiceInput, chat: voiceKey, field: voiceField, text: $text, handle: textHandle)
            }
        }
        Group {
            // While listening, the field's stop is the voice control's.
            if stopVisible && !canSend && !voice.active {
                Button(action: onStop) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Palette.bg)
                        .frame(width: 12, height: 12)
                        .frame(width: 36, height: 36)
                        .background(Palette.fg, in: Circle())
                        .opacity(stopping ? 0.5 : 1)
                }
                .disabled(stopping)
                .accessibilityLabel("Stop")
                .transition(.scale.combined(with: .opacity))
            } else {
                Button {
                    voice.edited(service: voiceInput, chat: voiceKey)
                    onSend()
                } label: {
                    Image(systemName: "arrow.up")
                        .romeFont(16, .bold)
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Palette.primary, in: Circle())
                        .opacity(canSend ? 1 : 0.35)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("send")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
    }

    private func plusMenu(_ attachments: ComposerAttachments) -> some View {
        Menu {
            Button {
                takingPhoto = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            Button {
                choosingPhotos = true
            } label: {
                Label("Choose from library", systemImage: "photo.on.rectangle")
            }
        } label: {
            Image(systemName: "plus")
                .romeFont(17, .medium)
                .foregroundStyle(attachments.isFull ? Palette.sub.opacity(0.5) : Palette.sub)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        // The camera would cover the voice control while it listens.
        .disabled(attachments.isFull || voice.active)
        .accessibilityLabel("Add photos")
    }
}

/// The photos waiting in the composer, each with an ×.
private struct ComposerThumbnails: View {
    let attachments: ComposerAttachments

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments.images) { image in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let thumbnail = image.thumbnail {
                                Image(decorative: thumbnail, scale: 1).resizable().scaledToFill()
                            } else {
                                Palette.fill
                            }
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Photo")
                        Button {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { attachments.remove(image.id) }
                        } label: {
                            Image(systemName: "xmark")
                                .romeFont(9, .bold)
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(.black.opacity(0.6), in: Circle())
                                .frame(width: 32, height: 32)
                                .contentShape(Rectangle())
                        }
                        .offset(x: 8, y: -8)
                        .accessibilityLabel("Remove photo")
                    }
                    .transition(.scale.combined(with: .opacity))
                }
                ForEach(0..<attachments.preparing, id: \.self) { _ in
                    Palette.fill
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay { Spinner(size: 14, color: Palette.sub) }
                }
            }
            .padding(.top, 8)
            .padding(.trailing, 12)
        }
        .scrollIndicators(.hidden)
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

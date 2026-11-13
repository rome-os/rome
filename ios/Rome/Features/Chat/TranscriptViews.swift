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
    @Entry var chatLinkOpener: (@MainActor (URL) -> OpenURLAction.Result)? = nil
    /// An allow-listed visitor, not the guardian: approvals are not theirs to answer.
    @Entry var isVisitor = false
    /// The chat on screen, by its store's id: nil under a sheet, the drawer
    /// or a pushed page. A chat marks what arrives as read only while it is.
    @Entry var visibleChat: String? = nil
}

/// The guardian's bubble: coral, right-aligned, fully round. Photos sent with
/// it sit above the text.
/// The long-press menu of a message bubble: its time on top, then Reply
/// where a thread can open, Copy and Share.
struct BubbleMenu {
    /// When the message was written; nil leaves the title out.
    var date: Date? = nil
    /// Quotes the message in the reply bar; nil where there are no replies.
    var onReply: (() -> Void)? = nil
    /// Opens share mode on the message's turn; nil shares the text.
    var onShare: (() -> Void)? = nil
    /// Inside a thread view: a tap on the bubble stays on it.
    var inThread = false
}

/// The menu's items, shared by both bubbles.
private struct BubbleMenuItems: View {
    let text: String
    let menu: BubbleMenu

    var body: some View {
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

private extension View {
    /// The bubble lifts under the finger with the system's menu. Inside a
    /// thread view it keeps its own tap, so one on the message never closes it.
    @ViewBuilder
    func bubbleMenu(text: String, menu: BubbleMenu) -> some View {
        if menu.inThread {
            self.onTapGesture {}.contextMenu { BubbleMenuItems(text: text, menu: menu) }
        } else {
            self.contextMenu { BubbleMenuItems(text: text, menu: menu) }
        }
    }
}

struct UserBubble: View {
    let text: String
    var images: [UserImage] = []
    let pending: PendingSend.State?
    var onRetry: () -> Void = {}
    var menu = BubbleMenu()
    /// Rome's mark on the message: being worked on, or failed.
    var mark: StatusMark? = nil
    /// The bubble keeps room for a mark whether or not it has one, so a mark
    /// coming or going never moves the rows around it.
    var reservesMark = false
    /// What the message replies to, quoted at the top of the bubble.
    var quote: MessagePart.ReplyQuote? = nil
    /// The quote's tap: the thread view, or the original; nil leaves it plain.
    var onQuote: (() -> Void)? = nil

    private var failure: SendFailure? {
        if case .failed(let failure)? = pending { return failure }
        return nil
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                if let failure {
                    if failure.retryable {
                        Button(action: onRetry) { AlertGlyph(size: 18) }
                            .frame(width: 28, height: 28)
                            .accessibilityLabel(failure.line)
                    } else {
                        AlertGlyph(size: 18).frame(width: 28, height: 28)
                    }
                }
                VStack(alignment: .trailing, spacing: 6) {
                    if !images.isEmpty {
                        UserImageGrid(images: images)
                    }
                    if !text.isEmpty || quote != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            if let quote {
                                QuotedReply(quote: quote, onTap: onQuote)
                            }
                            if !text.isEmpty {
                                Text(text)
                                    .romeFont(16)
                                    .lineSpacing(5)
                                    .foregroundStyle(.white)
                            }
                        }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Palette.primary, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                            .bubbleMenu(text: text, menu: menu)
                    }
                }
                // The mark hangs on the inner bottom corner of the bubble, or of the photos.
                .overlay(alignment: .bottomLeading) {
                    if let mark {
                        StatusMarkBadge(mark: mark).offset(x: -6, y: 11)
                    }
                }
                .opacity(pending == .sending ? 0.55 : 1)
            }
            if let failure {
                if failure.retryable {
                    Button(failure.line, action: onRetry)
                        .romeFont(12, .medium)
                        .foregroundStyle(Palette.destructive)
                } else {
                    Text(failure.line)
                        .romeFont(12, .medium)
                        .foregroundStyle(Palette.destructive)
                }
            } else if pending == .notDelivered {
                Text("Not delivered").romeFont(12, .medium).foregroundStyle(Palette.destructive)
            } else if pending == .unconfirmed {
                Text("Delivery unconfirmed · not sent again").romeFont(12, .medium).foregroundStyle(Palette.sub)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 56)
        // Room for the mark that hangs below the bubble.
        .padding(.bottom, reservesMark || mark != nil ? 12 : 0)
        .animation(.easeOut(duration: 0.2), value: pending)
        .animation(.easeOut(duration: 0.15), value: mark)
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
        let columns = Array(repeating: GridItem(.fixed(side), spacing: 6), count: min(2, images.count))
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
        let key = StoredImageCache.shared.key(upload.assetPath)
        if let cached = StoredImageCache.shared.image(key) {
            loaded = cached
            return
        }
        do {
            let data = try await ImageFetch.data(upload.source, assetLoader: assetLoader, apiLoader: apiLoader, width: Self.assetWidth)
            // Decoded small and off the main actor: an upload from the web may be huge.
            let thumbnail = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: ComposerImage.thumbnailPixels)
            }.value
            guard let thumbnail else { throw APIError.network }
            StoredImageCache.shared.store(thumbnail, for: key)
            loaded = thumbnail
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

/// Stored photos already loaded, so scrolling back does not fetch them again.
/// It holds at most 64 MB of decoded pixels. The app uses `shared`; a test
/// makes its own, so it never sees another test's pictures or resets.
@MainActor
final class StoredImageCache {
    static let shared = StoredImageCache()

    private final class Box {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    private let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    /// The open workspace's: keys carry it, so a picture loaded for one
    /// instance or account never shows in another.
    private var scope = UUID()

    /// The key for a path in the open workspace. Taken before a load starts,
    /// so a load that ends after a switch lands under the old scope.
    func key(_ path: String) -> String { "\(scope.uuidString)|\(path)" }

    /// A workspace opened or closed, or a sign-out: nothing cached carries over.
    func reset() {
        scope = UUID()
        cache.removeAllObjects()
    }

    func image(_ path: String) -> CGImage? {
        cache.object(forKey: path as NSString)?.image
    }

    func store(_ image: CGImage, for path: String) {
        cache.setObject(Box(image), forKey: path as NSString, cost: image.bytesPerRow * image.height)
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
            if let forwardedFrom {
                Button {
                    onOpenChat(forwardedFrom.chatId, forwardedFrom.title)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.right").romeFont(11, .semibold)
                        Text("From “\(forwardedFrom.title)”").lineLimit(1)
                    }
                    .romeFont(12, .semibold)
                    .foregroundStyle(Palette.sub)
                }
                .buttonStyle(.plain)
            }
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
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Palette.bubble, in: shape)
        .overlay(alignment: .leading) {
            if forwardedFrom != nil {
                Capsule().fill(Palette.sub.opacity(0.55)).frame(width: 3).padding(.vertical, 10).padding(.leading, 5)
            }
        }
        .contentShape(.contextMenuPreview, shape)
        .bubbleMenu(text: text, menu: menu)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, forwardedFrom == nil ? 64 : 32)
    }

    /// A small grey chevron, centred. Folded, its backdrop is the fade into
    /// the bubble's colour; open, it stands alone. Either way it lays out
    /// short and taps 44 pt tall: the tap area reaches past its frame.
    private var expandButton: some View {
        Button(action: toggle) {
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .romeFont(13, .semibold)
                .foregroundStyle(Palette.sub)
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
        withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { expanded.toggle() }
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

/// A card for a task chat the Concierge started: "Task" + status, then its title.
/// A task the Concierge started, as a card in the chat: the label and the
/// title. Its status is left out, since progress is not reported accurately.
struct TaskCard: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Task")
                    .romeFont(CardScale.label)
                    .foregroundStyle(Palette.sub)
                HStack(spacing: 8) {
                    Text(title)
                        .romeFont(CardScale.title, .semibold)
                        .tracking(-0.3)
                        .foregroundStyle(Palette.fg)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .romeFont(12, .bold)
                        .foregroundStyle(Palette.sub)
                }
            }
            .cardPadding()
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .softElevation(radius: Metrics.cardRadius)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .containerRelativeFrame(.horizontal) { width, _ in (Metrics.column(width) - 32) * 0.82 }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Task, \(title)")
    }
}

struct TimeSeparator: View {
    let date: Date

    var body: some View {
        Text(RelativeTime.separator(date))
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The spacing above a row, which carries the design's rhythm: 3 pt inside a
/// run, 18 pt when the sender changes, room around time separators.
enum TranscriptSpacing {
    static func top(_ row: TranscriptRow, after previous: TranscriptRow?) -> CGFloat {
        guard let previous else { return 8 }
        if case .separator = row { return 20 }
        if case .separator = previous { return 14 }
        if case .typing = row { return 14 }
        if case .notice = row { return 14 }
        // Tight under its own message, and apart from the next one.
        if case .threadLabel = row { return 3 }
        if case .threadLabel = previous { return row.isGuardian ? 18 : 14 }
        if row.isGuardian != previous.isGuardian { return 18 }
        if row.isGuardian { return 6 }
        switch (row, previous) {
        case (.agentText, .agentText): return 3
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
    var stopVisible = false
    var stopping = false
    @Binding var focused: Bool
    /// Photos to send with the message; nil leaves out the +.
    var attachments: ComposerAttachments? = nil
    let onSend: () -> Void
    var onStop: () -> Void = {}

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
        return !committedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let attachments, !attachments.images.isEmpty || attachments.preparing > 0 {
                ComposerThumbnails(attachments: attachments)
                    .padding(.top, 10)
                    .padding(.leading, 12)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            HStack(alignment: .bottom, spacing: 8) {
                if let attachments {
                    plusMenu(attachments)
                        .padding(.bottom, controlPadding)
                }
                ComposerTextView(
                    text: $text,
                    focused: $focused,
                    placeholder: placeholder,
                    onPasteImages: attachments.map { attachments in
                        { providers in Task { await attachments.add(providers: providers) } }
                    },
                    committedText: $committedText
                )
                Group {
                    if stopVisible && !canSend {
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
                        Button(action: onSend) {
                            Image(systemName: "arrow.up")
                                .romeFont(16, .bold)
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Palette.primary, in: Circle())
                                .opacity(canSend ? 1 : 0.35)
                        }
                        .disabled(!canSend)
                        .accessibilityLabel("Send")
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .buttonStyle(PressScaleStyle(scale: 0.9))
                .padding(.bottom, controlPadding)
            }
            .padding(.leading, attachments == nil ? 18 : 7)
            .padding(.trailing, 7)
        }
        .frame(minHeight: ComposerTextView.minHeight)
        // Frosted glass: the transcript behind blurs out so the placeholder
        // reads. In light the glass alone barely parts from the page, so it
        // keeps an edge.
        .glassSurface(RoundedRectangle(cornerRadius: 25, style: .continuous), interactive: true, frost: Frost.composer)
        .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
        .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
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
        .disabled(attachments.isFull)
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

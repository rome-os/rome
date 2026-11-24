import ChatLayout
import os
import SwiftUI
import UIKit.UIGestureRecognizerSubclass
import UIKit

/// A transcript in a `UICollectionView` laid out by ChatLayout, with each row
/// a SwiftUI view in its own cell. Only the rows near the screen are built
/// and measured. The layout keeps the rows in view where they are when older
/// pages go in above or rows above them grow, and keeps the newest row at the
/// bottom while the guardian is there.
struct TranscriptList<Row: View>: View {
    let store: TranscriptStore
    var sharedContent = false
    var showsBackToBottom = true
    var scrollState: TranscriptScroll? = nil
    var composerFocused = false
    /// Short transcripts sit at the top instead of the bottom (task chats).
    var alignTop = false
    /// Drawn after the last row: the "Running…" line.
    var footer: AnyView? = nil
    /// Goes up when the newest rows must come into view (a tapped push).
    var latestRequest = 0
    var thread: ThreadFocus? = nil
    var focusPosition: TranscriptFocusPosition? = nil
    var onBlankTap: (() -> Void)? = nil
    @ViewBuilder let row: (TranscriptRow, TranscriptRow?) -> Row

    @State private var ownScroll = TranscriptScroll()
    private var scroll: TranscriptScroll { scrollState ?? ownScroll }
    /// The newest rows were on screen when the app left the foreground.
    @State private var leftAtBottom = false
    /// Until then, new rows bring the list to the bottom: the refetch after
    /// a return or a push tap lands a moment after it.
    @State private var catchUpUntil: Date?
    /// When a Reply last brought the composer up: the list then keeps the
    /// replied message in view instead of going to the bottom.
    @State private var repliedAt: Date?

    var body: some View {
        let rows = store.rows
        GeometryReader { proxy in
            ChatCollection(
                rows: rows,
                sharedContent: sharedContent,
                hasOlder: thread.map { $0.initial == nil && $0.hasOlder } ?? store.hasOlder,
                footer: footer,
                insets: proxy.safeAreaInsets,
                alignTop: alignTop,
                scroll: scroll,
                selection: store.textSelection,
                position: focusPosition ?? (thread == nil ? store.focusPosition : nil),
                thread: thread,
                suspended: store.threadFocus != nil,
                onBlankTap: onBlankTap,
                row: row,
                onNearTop: {
                    if store.threadFocus != nil { return }
                    if let thread {
                        Task { await thread.load(.before) }
                        return
                    }
                    Task {
                        // A page of only hidden messages adds no row and no
                        // scroll, so nothing would ask for the next one.
                        while true {
                            let held = (messages: store.messages.count, rows: store.rows.count)
                            await store.loadOlder()
                            guard store.hasOlder, store.messages.count > held.messages, store.rows.count == held.rows else { break }
                        }
                    }
                },
                onDividerAbove: { [pill = store.unreadPill] in pill.dividerAbove($0) }
            )
            .environment(\.shareTurns, store.share.isSelecting ? ShareTurns(messages: store.messages, rows: rows) : nil)
            .environment(\.textSelection, store.textSelection)
            .ignoresSafeArea()
        }
        // The composer taking focus, or share mode, ends select mode.
        .onChange(of: composerFocused) { if composerFocused { store.textSelection.end() } }
        // Leaving the chat ends it: back, the drawer, another chat. The store
        // outlives the screen, and a press point is no place to come back to.
        .onDisappear { store.textSelection.end() }
        .onChange(of: store.share.isSelecting) { if store.share.isSelecting { store.textSelection.end() } }
        .onChange(of: rows.last?.id) {
            if store.threadFocus == nil, let until = catchUpUntil, Date.now < until { scroll.toBottom() }
        }
        // The swipe home, or Notification Center pulled down, starts on the
        // list and reads as a drag away from the bottom. Where the list stood
        // when the app left decides instead.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            leftAtBottom = scroll.atBottom
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            guard leftAtBottom else { return }
            catchUp()
        }
        .onChange(of: latestRequest) { catchUp() }
        // A quote led to its original: it comes into view, mid-screen. The
        // unread line goes to the top, under the header.
        .onChange(of: store.jumps) {
            guard let target = store.jumpTarget, let row = rows.first(where: { $0.ownMessageId == target || $0.id == target }) else { return }
            scroll.reveal(row.id, atTop: row == .unreadDivider)
        }
        .onChange(of: store.pending.count) { old, new in
            if store.threadFocus == nil, new > old { scroll.toBottom() }
        }
        .onChange(of: store.arrivals) {
            if !scroll.following { scroll.unseen += 1 }
        }
        // A Reply from the menu: the replied message stays in
        // view as the keyboard comes up (`TranscriptScroll.keep`).
        .onChange(of: store.replies) {
            guard thread == nil, store.threadFocus == nil else { return }
            repliedAt = .now
            if let row = store.replyRow { scroll.keep(row) }
        }
        .onChange(of: composerFocused) { _, focused in
            // Brought up by a Reply, the composer leaves the list where it is.
            if focused, let repliedAt, Date.now.timeIntervalSince(repliedAt) < 1 { return }
            if focused, thread == nil, store.threadFocus == nil {
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    if store.threadFocus == nil { scroll.toBottom() }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if showsBackToBottom { TranscriptBackToBottom(scroll: scroll, hidden: store.threadFocus != nil || thread != nil) }
        }
    }

    private func catchUp() {
        guard store.threadFocus == nil else { return }
        catchUpUntil = .now + 5
        scroll.toBottom()
    }
}

/// Where the transcript's scroll stands, and what moves it. The list writes
/// a value only when it changes, not on every scrolled frame.
@MainActor
@Observable
final class TranscriptScroll {
    /// The list keeps the newest row in view: on at the start, off when the
    /// guardian drags away, on again when they come back or jump there.
    fileprivate(set) var following = true
    /// The newest row is on screen.
    fileprivate(set) var atBottom = true
    /// Far above the newest rows: the back-to-bottom button shows.
    fileprivate(set) var far = false
    /// What arrived while the guardian read above the newest rows.
    var unseen = 0 {
        didSet { if unseen != 0 && following { unseen = 0 } }
    }
    @ObservationIgnored fileprivate weak var target: TranscriptScrollTarget?

    func toBottom() {
        set(following: true)
        target?.scrollToBottom()
    }

    func reveal(_ rowId: String, atTop: Bool) {
        set(following: false)
        target?.reveal(rowId, atTop: atTop)
    }

    /// Keeps a row in view, moving the list as little as it can, now and as
    /// the keyboard comes up: the message a Reply picked.
    func keep(_ rowId: String) {
        target?.keep(rowId)
    }

    fileprivate func set(following: Bool) {
        if self.following != following { self.following = following }
        if following && unseen != 0 { unseen = 0 }
    }

    fileprivate func set(atBottom: Bool, far: Bool) {
        if self.atBottom != atBottom { self.atBottom = atBottom }
        if self.far != far { self.far = far }
    }
}

@MainActor
private protocol TranscriptScrollTarget: AnyObject {
    func scrollToBottom()
    func reveal(_ rowId: String, atTop: Bool)
    func keep(_ rowId: String)
}

/// Where the list goes to keep a row in view: as little a move as shows it
/// whole, a little clear of the header and the composer, or its top when it
/// is taller than the space between them.
enum TranscriptKeep {
    static let margin: CGFloat = 8

    static func offset(current: CGFloat, row: CGRect, top: CGFloat, bottom: CGFloat, height: CGFloat) -> CGFloat {
        // The highest offset with the row's top in view, the lowest with its bottom.
        let showsTop = row.minY - margin - top
        let showsBottom = row.maxY + margin + bottom - height
        guard showsBottom <= showsTop else { return showsTop }
        return min(max(current, showsBottom), showsTop)
    }
}

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
    static func distance(contentHeight: CGFloat, offset: CGFloat, viewHeight: CGFloat, bottomInset: CGFloat) -> CGFloat {
        contentHeight + bottomInset - (offset + viewHeight)
    }

    /// Far from the bottom, or at any distance once something new arrived
    /// while the guardian reads above it.
    static func visible(far: Bool, unseen: Int, following: Bool) -> Bool {
        far || (unseen > 0 && !following)
    }
}

/// The screen owns this control separately from either collection's content.
struct TranscriptBackToBottom: View {
    let scroll: TranscriptScroll
    var hidden = false
    var body: some View {
        Group {
            if !hidden, BackToBottom.visible(far: scroll.far, unseen: scroll.unseen, following: scroll.following) {
                Button { scroll.toBottom() } label: { BackToBottomGlyph(dot: scroll.unseen > 0) }
                    .buttonStyle(PressScaleStyle(scale: 0.9))
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("transcript-back-to-bottom")
                    .accessibilityLabel(scroll.unseen > 0 ? Text("New messages. Scroll to the latest message") : Text("Scroll to the latest message"))
            }
        }
        // No focus-driven insertion/removal or inherited list animation.
        .transaction { if hidden { $0.animation = nil; $0.disablesAnimations = true } }
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

// MARK: - The collection view

/// Item ids besides the rows' own.
private enum ItemID {
    static let older = "transcript.older"
    static let footer = "transcript.footer"
}

/// One row's values, observed by its cell alone: a streamed reply redraws
/// its own cell, not the list.
@MainActor
@Observable
private final class RowBox {
    var row: TranscriptRow
    var previous: TranscriptRow?

    init(row: TranscriptRow, previous: TranscriptRow?) {
        self.row = row
        self.previous = previous
    }
}

/// What every cell draws besides its row: the SwiftUI environment where the
/// list sits, which hosted cells do not inherit, and the footer.
@MainActor
@Observable
private final class CellContext {
    var environment = EnvironmentValues()
    var footer: AnyView?
    /// Cards' surfaces, kept while their cells are reused for other rows.
    @ObservationIgnored let surfaces = WidgetSurfaces()
    /// Keeps a row's top where it is on screen while it changes height.
    @ObservationIgnored let topHold = RowTopHold()
}

/// Asked by a row about to change its own height, such as a long reply
/// unfolding: the list keeps the row's top where it is, so the row opens
/// downward instead of pushing what is above it up. One per list, so the
/// environment value never changes and no row redraws for it.
@MainActor
final class RowTopHold {
    fileprivate var action: ((String) -> Void)?

    func hold(_ rowID: String) { action?(rowID) }
}

extension EnvironmentValues {
    @Entry var rowTopHold: RowTopHold? = nil
    /// The transcript row a view is drawn in.
    @Entry var transcriptRowID: String? = nil
}

private struct ChatCollection<Row: View>: UIViewRepresentable {
    let rows: [TranscriptRow]
    let sharedContent: Bool
    let hasOlder: Bool
    let footer: AnyView?
    let insets: EdgeInsets
    let alignTop: Bool
    let scroll: TranscriptScroll
    let selection: TextSelection
    let position: TranscriptFocusPosition?
    let thread: ThreadFocus?
    let suspended: Bool
    let onBlankTap: (() -> Void)?
    let row: (TranscriptRow, TranscriptRow?) -> Row
    let onNearTop: () -> Void
    let onDividerAbove: (Bool) -> Void

    func makeCoordinator() -> TranscriptCoordinator<Row> {
        TranscriptCoordinator(row: row, alignTop: alignTop)
    }

    func makeUIView(context: Context) -> UICollectionView {
        let view = context.coordinator.makeView()
        if thread == nil { _ = position?.claimMain(view, take: true) }
        return view
    }

    /// A chat closed mid-fold still turns UIKit's animations back on and
    /// stops the hold's display link.
    static func dismantleUIView(_ view: UICollectionView, coordinator: TranscriptCoordinator<Row>) {
        coordinator.endHold()
        coordinator.focusPosition?.detach(view)
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
        let coordinator = context.coordinator
        coordinator.sharedContent = sharedContent
        coordinator.row = row
        coordinator.onNearTop = onNearTop
        coordinator.onDividerAbove = onDividerAbove
        coordinator.scroll = scroll
        coordinator.selection = selection
        if thread != nil { coordinator.layoutKeepsBottom(false) }
        coordinator.initialThread = thread
        coordinator.initialRows = rows
        view.accessibilityIdentifier = thread == nil ? "transcript" : "reply-chain-transcript"
        if thread != nil && !coordinator.positionedThread { view.alpha = 0 }
        coordinator.suspended = suspended
        view.accessibilityElementsHidden = suspended
        view.isUserInteractionEnabled = !suspended
        coordinator.onBlankTap = onBlankTap
        coordinator.focusHitAreas = context.environment.threadFocusHitAreas
        coordinator.onNearBottom = thread.map { thread in { Task { await thread.load(.after) } } }
        coordinator.focusPosition = position
        // A copy of this chat on its way out keeps its rows but stops
        // laying out the shared ones.
        let ownsShared = thread != nil || position?.claimMain(view) == true
        if thread == nil {
            if ownsShared {
                position?.pause = { [weak coordinator] in coordinator?.pauseForFocus() }
                position?.frame = { [weak coordinator] id in coordinator?.windowFrame(id) }
                position?.mainGeometry = { [weak coordinator] id in coordinator?.contentWindowFrame(id) }
            }
        } else {
            position?.focusedGeometry = { [weak coordinator] id in coordinator?.contentWindowFrame(id) }
        }
        if sharedContent, ownsShared { position?.registerInput(view, gestures: coordinator.contentGestures) }
        scroll.target = coordinator
        PerfProbe.count("listUpdate")
        coordinator.cells.environment = context.environment
        coordinator.cells.footer = footer
        coordinator.set(insets: insets)
        coordinator.apply(rows: rows, hasOlder: hasOlder, footer: footer != nil)
        position?.layout()
        if let thread {
            coordinator.positionThread(thread, rows: rows)
            DispatchQueue.main.async { [weak coordinator] in coordinator?.positionThread(thread, rows: rows) }
        }
    }
}

/// Keeps the collection view's items, insets and scroll for `ChatCollection`.
@MainActor
private final class TranscriptCoordinator<RowView: View>: NSObject, UICollectionViewDelegate, UIGestureRecognizerDelegate, ChatLayoutDelegate, TranscriptScrollTarget {
    var sharedContent = false
    var contentGestures: [UIGestureRecognizer] = []
    var row: (TranscriptRow, TranscriptRow?) -> RowView
    var onNearTop: () -> Void = {}
    var onNearBottom: (() -> Void)?
    var onBlankTap: (() -> Void)?
    weak var focusPosition: TranscriptFocusPosition?
    var focusHitAreas: ThreadFocusHitAreas?
    var suspended = false
    private(set) var positionedThread = false
    var initialThread: ThreadFocus?
    var initialRows: [TranscriptRow] = []
    private var positioningThread = false
    private var threadReading: (id: String, y: CGFloat)?
    private var applyingRows = false
    private var askedNewer: ContinuousClock.Instant?
    var onDividerAbove: (Bool) -> Void = { _ in }
    weak var scroll: TranscriptScroll?
    /// The transcript's select mode, which a scroll or a tap outside the message ends.
    weak var selection: TextSelection?
    let cells = CellContext()
    private let alignTop: Bool
    private var boxes: [String: RowBox] = [:]
    /// Oldest first, as on screen.
    private var items: [String] = []
    private var dataSource: ChatLayoutDiffableDataSource<Int, String>?
    private weak var view: UICollectionView?
    private let layout = CollectionViewChatLayout()
    /// Measured heights by item id, so a row coming back is estimated well.
    private var heights: [String: CGFloat] = [:]
    /// The bars' and keyboard's insets, as on screen.
    private var screenInsets = UIEdgeInsets.zero
    /// A row a jump is bringing into view.
    private var revealing: (id: String, atTop: Bool)?
    /// The status-bar tap is taking the list to its top: older pages wait
    /// until it gets there, or the top would keep moving away.
    private var scrollingToTop = false
    /// When older rows were last asked for, and how many items there were:
    /// a fetch that failed is asked again at most once a second, not on
    /// every frame of a scroll.
    private var askedOlder: (count: Int, at: ContinuousClock.Instant)?
    /// The last answer given to `onDividerAbove`.
    private var dividerAbove: Bool?
    /// The row a Reply picked, kept in view until the keyboard has come up.
    private var keeping: (id: String, until: CFTimeInterval)?
    #if DEBUG
    private let holdProbe = HoldProbe()
    #endif

    init(row: @escaping (TranscriptRow, TranscriptRow?) -> RowView, alignTop: Bool) {
        self.row = row
        self.alignTop = alignTop
    }

    func pauseForFocus() {
        suspended = true
        endHold()
        revealing = nil
        keeping = nil
        if let view { view.setContentOffset(view.contentOffset, animated: false) }
    }

    func layoutKeepsBottom(_ keeps: Bool) {
        layout.keepContentOffsetAtBottomOnBatchUpdates = keeps
    }

    func makeView() -> UICollectionView {
        layout.delegate = self
        cells.topHold.action = { [weak self] id in self?.holdTop(of: id) }
        layout.settings.estimatedItemSize = CGSize(width: 300, height: Self.estimate)
        // Updates keep what is on screen anchored to the bottom of the
        // visible area: a page above, or a row above that grows, moves
        // nothing in view, and the newest row stays at the bottom.
        layout.keepContentOffsetAtBottomOnBatchUpdates = true
        layout.keepContentAtBottomOfVisibleArea = !alignTop
        layout.supportSelfSizingInvalidation = true
        let view = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
        view.onLayout = { [weak self] in
            self?.focusPosition?.layout()
            guard let self, let thread = self.initialThread else { return }
            if self.positionedThread { self.alignThreadReading() }
            else { self.positionThread(thread, rows: self.initialRows) }
        }
        view.backgroundColor = .clear
        view.contentInsetAdjustmentBehavior = .never
        view.keyboardDismissMode = .interactive
        view.alwaysBounceVertical = true
        view.selfSizingInvalidation = .enabled
        // https://openradar.appspot.com/40926834: prefetching keeps stale cells.
        view.isPrefetchingEnabled = false
        if #available(iOS 26, *) {
            // The header draws its own blur behind it (`ChatHeaderBlur`). On a
            // phone the system's top edge effect for the floating bar drew here
            // too, as a whitish band with a hard edge where the bar ends; the
            // simulator never drew it.
            view.topEdgeEffect.isHidden = true
        }
        view.delegate = self
        let tap = UITapGestureRecognizer(target: self, action: #selector(tappedOutsideSelection))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        view.addGestureRecognizer(tap)
        // Where each touch lands: Select text opens on the paragraph the
        // long press that opened the menu was on.
        let touches = TouchDownRecorder { [weak self] point in self?.selection?.touchedDown(at: point) }
        view.addGestureRecognizer(touches)
        contentGestures = [view.panGestureRecognizer, tap, touches]
        #if DEBUG
        // A fling `ROME_PERF=paging` drives in code is a drag away from the bottom.
        NotificationCenter.default.addObserver(forName: PerfProbe.flingStarted, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.scroll?.set(following: false)
                self?.holdProbe.end()
            }
        }
        NotificationCenter.default.addObserver(forName: PerfProbe.flingEnded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let view = self.view else { return }
                self.holdProbe.begin(view: view, layout: self.layout, id: { [weak self] in self?.items[safe: $0] }, index: { [weak self] in self?.items.firstIndex(of: $0) })
            }
        }
        #endif
        let registration = UICollectionView.CellRegistration<TranscriptCell, String> { [weak self] cell, _, id in
            guard let self else { return }
            PerfProbe.count("cellConfigure")
            cell.accessibilityIdentifier = id
            cell.contentConfiguration = self.configuration(for: id, in: cell)
            cell.backgroundConfiguration = .clear()
        }
        dataSource = ChatLayoutDiffableDataSource<Int, String>(collectionView: view) { collectionView, indexPath, id in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
        }
        self.view = view
        return view
    }

    private static var estimate: CGFloat { 80 }

    private func configuration(for id: String, in cell: TranscriptCell) -> any UIContentConfiguration {
        let cells = cells
        let content: AnyView
        switch id {
        case ItemID.footer:
            content = AnyView(FooterHost(cells: cells))
        case ItemID.older:
            content = AnyView(
                Spinner(size: 16, color: Palette.sub)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .environment(\.self, cells.environment)
            )
        default:
            guard let box = boxes[id] else { return UIHostingConfiguration { EmptyView() }.margins(.all, 0) }
            content = AnyView(RowHost(box: box, cells: cells) { [weak self] row, previous in
                self.map { AnyView($0.row(row, previous)) } ?? AnyView(EmptyView())
            })
        }
        if sharedContent, let focusPosition, let box = boxes[id], let view {
            let gap = TranscriptSpacing.top(box.row, after: box.previous)
            return TranscriptSharedConfiguration(position: focusPosition, list: view, id: id, top: gap, box: box, cells: cells) { [weak self] row, previous in
                self.map { AnyView($0.row(row, previous)) } ?? AnyView(EmptyView())
            }
        }
        return UIHostingConfiguration {
            content.id(id)
                .onGeometryChange(for: CGSize.self) { $0.size } action: { [weak cell] size in cell?.measured(size) }
        }.margins(.all, 0)
    }

    // MARK: Content

    func apply(rows: [TranscriptRow], hasOlder: Bool, footer: Bool) {
        applyingRows = true
        if positionedThread, threadReading == nil { captureThreadReading() }
        defer {
            applyingRows = false
            if positionedThread { alignThreadReading() }
        }
        var next: [String] = []
        next.reserveCapacity(rows.count + 2)
        if hasOlder { next.append(ItemID.older) }
        var live = Set<String>()
        for index in rows.indices {
            let row = rows[index]
            let previous = index > 0 ? rows[index - 1] : nil
            live.insert(row.id)
            if let box = boxes[row.id] {
                if box.row != row { box.row = row }
                if box.previous != previous { box.previous = previous }
            } else {
                boxes[row.id] = RowBox(row: row, previous: previous)
            }
            next.append(row.id)
        }
        if sharedContent, let view {
            for cell in view.visibleCells {
                if let id = cell.accessibilityIdentifier, let box = boxes[id], let slot = (cell.contentView as? TranscriptContentSlot) ?? (cell.contentView.subviews.first as? TranscriptContentSlot) {
                    slot.top = TranscriptSpacing.top(box.row, after: box.previous)
                    if slot.held.owner === slot { slot.held.adopt(slot) }
                }
            }
        }
        if footer { next.append(ItemID.footer) }
        for id in boxes.keys where !live.contains(id) { boxes[id] = nil }
        guard next != items, let dataSource, let view else { return }
        let started = CACurrentMediaTime()
        let first = items.isEmpty
        let held = items
        // Read before the update: rows going in move the bottom away.
        let onBottom = !suspended && (scroll?.following ?? true) && (scroll?.atBottom ?? true)
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(next)
        if first {
            dataSource.applySnapshotUsingReloadData(snapshot) { self.items = next; view.setNeedsLayout() }
            view.layoutIfNeeded()
            restoreToBottom()
            warmRowsAbove()
        } else {
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false) { self.items = next; view.setNeedsLayout() }
                view.layoutIfNeeded()
            }
            // New rows at the end land below the screen; a list on the
            // bottom brings them into view.
            if onBottom && !isUserScrolling { restoreToBottom() }
        }
        // Whether an older page went in above the rows held before.
        let prepended = !first && next.count > held.count && next.last == held.last
        PerfProbe.sample(prepended ? "pageApplyMs" : "applyMs", (CACurrentMediaTime() - started) * 1000)
        if prepended { transcriptScrollLog.notice("older page in: \(next.count, privacy: .public) items, \(Int((CACurrentMediaTime() - started) * 1000), privacy: .public) ms") }
        readScroll()
    }

    /// Lays out the rows just above the screen once, off screen and one per
    /// run-loop turn, after the chat opens. Their first build (a card's
    /// views, its Markdown) then never lands in a single frame of the first
    /// scroll up, where several came on screen at once.
    private func warmRowsAbove() {
        guard !sharedContent else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, let view = self.view else { return }
            let top = view.indexPathsForVisibleItems.map(\.item).min() ?? self.items.count
            let width = view.bounds.width
            for index in stride(from: top - 1, through: max(0, top - 12), by: -1) {
                guard let id = self.items[safe: index], let box = self.boxes[id] else { continue }
                let host = UIHostingController(rootView: AnyView(RowHost(box: box, cells: self.cells) { [weak self] row, previous in
                    self.map { AnyView($0.row(row, previous)) } ?? AnyView(EmptyView())
                }))
                let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
                // Drawn once too: text and pictures are rasterized on first draw.
                host.view.frame = CGRect(origin: .zero, size: CGSize(width: width, height: max(1, size.height)))
                host.view.layoutIfNeeded()
                _ = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { context in host.view.layer.render(in: context.cgContext) }
                // The host can outlive this loop; emptied, it stops redrawing
                // off screen each time its row or the list changes.
                host.rootView = AnyView(EmptyView())
                await Task.yield()
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    private var isUserScrolling: Bool {
        guard let view else { return false }
        return view.isDragging || view.isDecelerating
    }

    /// The newest row's bottom on the bottom of the visible area, exactly.
    private func restoreToBottom() {
        guard let view, !items.isEmpty else { return }
        view.layoutIfNeeded()
        layout.restoreContentOffset(with: ChatLayoutPositionSnapshot(indexPath: IndexPath(item: items.count - 1, section: 0), edge: .bottom))
    }

    // MARK: Holding a row's top

    /// The row whose top stays put, its last height, and since when.
    private var held: (id: String, height: CGFloat, steadySince: CFTimeInterval, started: CFTimeInterval)?
    private var holdLink: CADisplayLink?
    /// How long the row's height must stay the same before the list holds
    /// its bottom again: past a spring's tail and a cell's late resize.
    private static var steadyTime: CFTimeInterval { 0.2 }
    /// The shortest a hold lasts: a fold's spring has begun by then.
    private static var minHoldTime: CFTimeInterval { 0.35 }
    /// The longest a hold lasts, whatever the row does.
    private static var maxHoldTime: CFTimeInterval { 2 }

    /// Lets a row change height with its top, and every row above it, where
    /// they are: the list otherwise keeps its bottom still, so a row that
    /// grows pushes what is above it up. It stops compensating for size
    /// changes until the row's height has settled, then holds its bottom
    /// again; resuming then moves nothing, since nothing is changing.
    func holdTop(of id: String) {
        guard items.contains(id) else { return }
        transcriptScrollLog.debug("holding a row's top while it changes height")
        layout.keepContentOffsetAtBottomOnBatchUpdates = false
        // Nothing pulls the list to its bottom while the row changes.
        scroll?.set(following: false)
        // The layout animates a cell's new size from where its bottom-held
        // offset would put it: the row jumps up, then slides back. The
        // change lands in place instead, until the row has its new height.
        UIView.setAnimationsEnabled(false)
        holdsAnimations = true
        let now = CACurrentMediaTime()
        held = (id, heightOf(id) ?? 0, now, now)
        if holdLink == nil {
            let link = CADisplayLink(target: HoldTarget { [weak self] in
                guard let self else { return false }
                self.watchHeld()
                return true
            }, selector: #selector(HoldTarget.tick))
            link.add(to: .main, forMode: .common)
            holdLink = link
        }
    }

    private func heightOf(_ id: String) -> CGFloat? {
        guard let item = items.firstIndex(of: id) else { return nil }
        return layout.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.frame.height
    }

    /// Each frame: ends the hold once the row has kept one height for a
    /// moment, or the guardian drags, or it has lasted long enough.
    private func watchHeld() {
        guard var held else { return endHold() }
        let now = CACurrentMediaTime()
        let height = heightOf(held.id) ?? held.height
        if abs(height - held.height) > 0.5 {
            held.height = height
            held.steadySince = now
            self.held = held
        } else if holdsAnimations, now - held.steadySince > 0.05, held.steadySince > held.started {
            releaseAnimations()
        }
        let settled = now - held.started >= Self.minHoldTime && now - held.steadySince >= Self.steadyTime
        if settled || now - held.started >= Self.maxHoldTime || isUserScrolling {
            endHold()
        }
    }

    /// Whether the hold has turned UIKit's animations off.
    private var holdsAnimations = false

    private func releaseAnimations() {
        guard holdsAnimations else { return }
        holdsAnimations = false
        UIView.setAnimationsEnabled(true)
    }

    func endHold() {
        releaseAnimations()
        holdLink?.invalidate()
        holdLink = nil
        guard held != nil else { return }
        held = nil
        layout.keepContentOffsetAtBottomOnBatchUpdates = initialThread == nil
        readScroll()
        // Opened below the screen, the list no longer follows the newest
        // row, as after a drag: a bar that moves next must not pull it back.
        scroll?.set(following: scroll?.atBottom ?? true)
    }

    // MARK: ChatLayoutDelegate

    func sizeForItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath) -> ItemSize {
        let width = chatLayout.layoutFrame.width
        let height = items.indices.contains(indexPath.item) ? heights[items[indexPath.item]] : nil
        return .estimated(CGSize(width: width, height: height ?? Self.estimate))
    }

    // MARK: Insets

    func set(insets: EdgeInsets) {
        // A little air between the newest row and the composer.
        let next = UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom + 14, right: 0)
        guard !suspended else { return }
        guard next != screenInsets, let view else { return }
        screenInsets = next
        if positionedThread {
            view.verticalScrollIndicatorInsets = next
            alignThreadReading()
            return
        }
        // Keep what the guardian sees above the bar that moved: the newest
        // row on the bottom, or the row nearest the bottom where it was.
        let anchor = (scroll?.following ?? true) ? nil : layout.getContentOffsetSnapshot(from: .bottom)
        view.contentInset = next
        view.verticalScrollIndicatorInsets = next
        if scroll?.following ?? true {
            restoreToBottom()
        } else if let anchor, !isUserScrolling {
            layout.restoreContentOffset(with: anchor)
        }
        // The keyboard a Reply brought up moves the rows with it, as above,
        // but never past the message replied to.
        if let keeping, CACurrentMediaTime() < keeping.until, !isUserScrolling,
           let offset = offset(keeping: keeping.id), abs(offset - view.contentOffset.y) > 0.5 {
            view.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            readScroll()
            scroll?.set(following: scroll?.atBottom ?? true)
        }
    }

    // MARK: Scrolling

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        focusPosition?.layout()
        readScroll()
    }

    private func readScroll() {
        guard let view, let scroll, !suspended, !positioningThread else { return }
        let height = view.bounds.height - screenInsets.top - screenInsets.bottom
        let distance = BackToBottom.distance(contentHeight: view.contentSize.height, offset: view.contentOffset.y, viewHeight: view.bounds.height, bottomInset: view.contentInset.bottom)
        scroll.set(atBottom: distance < 7, far: BackToBottom.shows(scroll.far, distance: distance, height: height))
        let fromTop = view.contentOffset.y + view.contentInset.top
        let mayPage = initialThread == nil || (positionedThread && isUserScrolling)
        let ahead = initialThread == nil ? height * 4 : height
        if mayPage, items.first == ItemID.older, height > 0, !scrollingToTop, fromTop < ahead { askOlder() }
        if mayPage, distance < height, let onNearBottom {
            let now = ContinuousClock.now
            if askedNewer == nil || now - askedNewer! > .seconds(1) {
                askedNewer = now
                onNearBottom()
            }
        }
        readDivider(in: view)
    }

    private func askOlder() {
        let now = ContinuousClock.now
        if let askedOlder, askedOlder.count == items.count, now - askedOlder.at < .seconds(1) { return }
        askedOlder = (items.count, now)
        onNearTop()
    }

    /// Whether the unread line is out of sight above the visible area.
    private func readDivider(in view: UICollectionView) {
        guard let index = items.firstIndex(of: TranscriptRow.unreadDivider.id) else {
            dividerAbove = nil
            return
        }
        guard let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return }
        let above = frame.maxY <= view.contentOffset.y + view.contentInset.top
        guard above != dividerAbove else { return }
        dividerAbove = above
        onDividerAbove(above)
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        focusPosition?.finishForDrag()
        threadReading = nil
        // A scroll ends select mode, but not one a selection's own drag
        // makes as it reaches the edge.
        if !SelectingTextView.dragging { selection?.end() }
        revealing = nil
        keeping = nil
        // A drag stops a status-bar scroll short of the top, and UIKit then
        // never reports it reached the top.
        scrollingToTop = false
        scroll?.set(following: false)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { cameToRest() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        cameToRest()
    }

    private func cameToRest() {
        if positionedThread { captureThreadReading() }
        scroll?.set(following: scroll?.atBottom ?? true)
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        selection?.end()
        revealing = nil
        // Already on top, the tap moves nothing and nothing reports back.
        scrollingToTop = scrollView.contentOffset.y + scrollView.adjustedContentInset.top > 1
        scroll?.set(following: false)
        return true
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        scrollingToTop = false
        readScroll()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        guard !suspended else { return }
        if scroll?.following == true {
            // Rows measured on the way down: land on the newest row exactly.
            restoreToBottom()
        } else if keeping != nil, revealing == nil {
            // Kept a replied message in view: on the bottom, the list follows again.
            readScroll()
            scroll?.set(following: scroll?.atBottom ?? true)
        } else if let revealing {
            self.revealing = nil
            // Rows near it measured as they came on screen: settle on it.
            if let offset = offset(revealing: revealing.id, atTop: revealing.atTop), abs(offset - scrollView.contentOffset.y) > 2 {
                scrollView.setContentOffset(CGPoint(x: 0, y: offset), animated: true)
            }
        }
        readScroll()
    }

    func scrollToBottom() {
        // A move the list makes itself ends select mode, as a drag does.
        selection?.end()
        guard let view else { return }
        revealing = nil
        // A fling still gliding would win over the jump: stop it first.
        if view.isDecelerating { view.setContentOffset(view.contentOffset, animated: false) }
        let end = max(-view.contentInset.top, view.contentSize.height + view.contentInset.bottom - view.bounds.height)
        if abs(end - view.contentOffset.y) < 1 {
            restoreToBottom()
        } else {
            view.setContentOffset(CGPoint(x: 0, y: end), animated: true)
        }
    }

    func reveal(_ rowId: String, atTop: Bool) {
        // A move the list makes itself ends select mode, as a drag does.
        selection?.end()
        guard let view, let offset = offset(revealing: rowId, atTop: atTop) else { return }
        if view.isDecelerating { view.setContentOffset(view.contentOffset, animated: false) }
        revealing = (rowId, atTop)
        view.setContentOffset(CGPoint(x: 0, y: offset), animated: true)
    }

    func keep(_ rowId: String) {
        // A move the list makes itself ends select mode, as a drag does.
        selection?.end()
        guard let view else { return }
        // Long enough for the keyboard to come up.
        keeping = (rowId, CACurrentMediaTime() + 1)
        guard let offset = offset(keeping: rowId), abs(offset - view.contentOffset.y) > 0.5 else { return }
        if view.isDecelerating { view.setContentOffset(view.contentOffset, animated: false) }
        revealing = nil
        scroll?.set(following: false)
        view.setContentOffset(CGPoint(x: 0, y: offset), animated: true)
    }

    /// The offset nearest the current one that shows the whole row between
    /// the header and the composer, or its top when it is taller than that.
    private func offset(keeping id: String) -> CGFloat? {
        guard let view, let index = items.firstIndex(of: id),
              let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return nil }
        let low = -view.contentInset.top
        let high = max(low, view.contentSize.height + view.contentInset.bottom - view.bounds.height)
        let target = TranscriptKeep.offset(
            current: view.contentOffset.y, row: frame,
            top: view.contentInset.top, bottom: view.contentInset.bottom, height: view.bounds.height
        )
        return min(max(target, low), high)
    }

    /// The offset that shows a row mid-screen, or at the top under the header.
    private func offset(revealing id: String, atTop: Bool) -> CGFloat? {
        guard let view, let index = items.firstIndex(of: id),
              let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return nil }
        let visible = view.bounds.height - view.contentInset.top - view.contentInset.bottom
        let target = atTop ? frame.minY - view.contentInset.top : frame.midY - view.contentInset.top - visible / 2
        let low = -view.contentInset.top
        let high = max(low, view.contentSize.height + view.contentInset.bottom - view.bounds.height)
        return min(max(target, low), high)
    }

    func windowFrame(_ id: String) -> CGRect? {
        guard let view, let index = items.firstIndex(of: id),
              let attributes = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0)) else { return nil }
        return view.convert(attributes.frame, to: nil)
    }

    func contentWindowFrame(_ id: String) -> CGRect? {
        guard var frame = windowFrame(id), let box = boxes[id] else { return nil }
        let gap = TranscriptSpacing.top(box.row, after: box.previous)
        frame.origin.y += gap
        frame.size.height = max(1, frame.height - gap)
        return frame
    }

    func positionThread(_ thread: ThreadFocus, rows: [TranscriptRow]) {
        // The first snapshot restores its bottom after laying out. Position
        // only after that whole apply, or its restore overwrites this one.
        guard !applyingRows, !positionedThread, let view, view.window != nil, view.bounds.height > 0, view.bounds.width > 0,
              let index = rows.firstIndex(where: { $0.id == thread.row }),
              let item = items.firstIndex(of: thread.row) else { return }
        positionedThread = true
        positioningThread = true
        view.alpha = 0
        scroll?.set(following: false)
        let gap = TranscriptSpacing.top(rows[index], after: index > 0 ? rows[index - 1] : nil)
        // A scroll view's local coordinates include contentOffset. Convert
        // its bounds origin to get the viewport's window origin instead.
        let originY = view.convert(view.bounds.origin, to: nil).y
        let y = thread.bubbleY.map { $0 - originY - gap } ?? screenInsets.top
        // Insets allow an anchor near either end of a short chain to keep
        // its window position without moving the mounted main list.
        view.contentInset.top = max(screenInsets.top, view.bounds.height)
        view.contentInset.bottom = max(screenInsets.bottom, view.bounds.height)
        view.layoutIfNeeded()
        layout.restoreContentOffset(with: ChatLayoutPositionSnapshot(indexPath: IndexPath(item: item, section: 0), edge: .top, offset: y - view.contentInset.top))
        view.layoutIfNeeded()
        // The restore measures self-sizing rows. Correct any residual drift
        // before the first visible frame, after those measurements.
        if let frame = layout.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.frame {
            let offset = frame.minY - y
            view.contentOffset.y = offset
        }
        threadReading = (thread.row, thread.bubbleY ?? view.convert(CGPoint(x: 0, y: view.contentOffset.y + screenInsets.top), to: nil).y)
        alignThreadReading()
        view.layoutIfNeeded()
        if let focusPosition { focusPosition.ready(view, for: thread) } else { view.alpha = 1 }
        positioningThread = false
        readScroll()
    }

    private func captureThreadReading() {
        guard let view else { return }
        let top = view.contentOffset.y + screenInsets.top
        guard let cell = view.visibleCells.sorted(by: { $0.frame.minY < $1.frame.minY }).first(where: { $0.frame.maxY > top && $0.accessibilityIdentifier.flatMap { self.boxes[$0] } != nil }),
              let id = cell.accessibilityIdentifier, let box = boxes[id] else { return }
        let gap = TranscriptSpacing.top(box.row, after: box.previous)
        threadReading = (id, view.convert(CGPoint(x: 0, y: cell.frame.minY + gap), to: nil).y)
    }

    private func alignThreadReading() {
        guard !applyingRows, !isUserScrolling, let view, let reading = threadReading,
              let index = items.firstIndex(of: reading.id), let box = boxes[reading.id],
              let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return }
        let origin = view.convert(view.bounds.origin, to: nil).y
        let gap = TranscriptSpacing.top(box.row, after: box.previous)
        let offset = frame.minY + gap - (reading.y - origin)
        let wasPositioning = positioningThread
        positioningThread = true
        UIView.performWithoutAnimation {
            let insets = UIEdgeInsets(top: max(screenInsets.top, -offset), left: 0,
                                      bottom: max(screenInsets.bottom, offset + view.bounds.height - view.contentSize.height), right: 0)
            if view.contentInset != insets { view.contentInset = insets }
            if abs(view.contentOffset.y - offset) > 0.01 {
                view.setContentOffset(CGPoint(x: view.contentOffset.x, y: offset), animated: false)
            }
        }
        positioningThread = wasPositioning
    }

    // MARK: Heights

    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        guard let id = items[safe: indexPath.item] else { return }
        heights[id] = cell.bounds.height
    }

    // MARK: Select mode

    /// A tap on the transcript outside the message in select mode ends it.
    @objc private func tappedOutsideSelection() {
        if selection?.isActive != true { onBlankTap?() }
        selection?.end()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if selection?.isActive != true {
            guard onBlankTap != nil, let view else { return false }
            if focusHitAreas?.contains(touch.location(in: view.window)) == true || focusPosition?.containsBubble(touch.location(in: view.window)) == true { return false }
            if let path = view.indexPathForItem(at: touch.location(in: view)), let id = items[safe: path.item], let row = boxes[id]?.row {
                switch row {
                case .userText, .agentText, .separator: return true
                default: return false
                }
            }
            return true
        }
        // A tap in the text itself moves the selection, and its handles and
        // links are the text view's.
        var view = touch.view
        while let current = view {
            if current is SelectingTextView { return false }
            view = current.superview
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

/// A display link's target that calls back: the link holds its target
/// strongly, so the list is never kept alive by it.
/// The hold's display link target. The action answers false once its
/// coordinator is gone: the link then stops itself, and the animations the
/// hold turned off come back on.
@MainActor
private final class HoldTarget: NSObject {
    let action: () -> Bool
    init(_ action: @escaping () -> Bool) { self.action = action }
    @objc func tick(_ link: CADisplayLink) {
        guard !action() else { return }
        link.invalidate()
        UIView.setAnimationsEnabled(true)
    }
}

#if DEBUG
/// `ROME_PERF` only: while a fling rests, how far a row mid-screen drifts on
/// screen as pages go in and rows above it grow. Ideally 0.
@MainActor
private final class HoldProbe: NSObject {
    private weak var view: UICollectionView?
    private weak var layout: CollectionViewChatLayout?
    private var index: (String) -> Int? = { _ in nil }
    private var anchor: (id: String, y: CGFloat)?
    private var drift: CGFloat = 0
    private var link: CADisplayLink?

    func begin(view: UICollectionView, layout: CollectionViewChatLayout, id: (Int) -> String?, index: @escaping (String) -> Int?) {
        end()
        let mid = view.contentOffset.y + view.bounds.height / 2
        guard let attributes = layout.layoutAttributesForElements(in: CGRect(x: 0, y: mid, width: view.bounds.width, height: 1))?.first,
              let rowId = id(attributes.indexPath.item) else { return }
        self.view = view
        self.layout = layout
        self.index = index
        anchor = (rowId, attributes.frame.minY - view.contentOffset.y)
        drift = 0
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        guard let view, let layout, let anchor, let item = index(anchor.id),
              let frame = layout.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.frame else { return }
        drift = max(drift, abs(frame.minY - view.contentOffset.y - anchor.y))
    }

    func end() {
        link?.invalidate()
        link = nil
        if anchor != nil { PerfProbe.sample("holdDriftPt", drift) }
        anchor = nil
    }
}
#endif

/// One row in its cell, at the readable width.
private struct RowHost: View {
    let box: RowBox
    let cells: CellContext
    var surfaces: WidgetSurfaces? = nil
    let build: (TranscriptRow, TranscriptRow?) -> AnyView

    var body: some View {
        build(box.row, box.previous)
            .padding(.horizontal, Metrics.pagePadding)
            .readableColumn()
            .environment(\.widgetSurfaces, (surfaces ?? cells.surfaces).row(box.row.id))
            // Inside the list's environment, which replaces the whole set.
            .environment(\.rowTopHold, cells.topHold)
            .environment(\.transcriptRowID, box.row.id)
            .environment(\.self, cells.environment)
    }
}

private struct FooterHost: View {
    let cells: CellContext

    var body: some View {
        (cells.footer ?? AnyView(EmptyView()))
            .padding(.horizontal, Metrics.pagePadding)
            .readableColumn()
            .environment(\.self, cells.environment)
    }
}

/// Sized by its content's own height at the list's width: the default
/// answer came out a line short for wrapped text in hosted cells. A row
/// that grows inside SwiftUI does not always tell its cell (a question card
/// filling in its fields), so the row reports the size it took, and an
/// overflow that outlives UIKit's own sizing pass asks for a new one.
private final class TranscriptCell: UICollectionViewCell {
    /// The height the row took when SwiftUI last laid it out.
    private var taken: CGFloat = 0

    func measured(_ size: CGSize) {
        taken = size.height
        guard size.height > bounds.height + 0.5 else { return }
        // Only an overflow that outlives UIKit's own sizing pass needs a new one.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.taken > self.bounds.height + 0.5 else { return }
            PerfProbe.count("overflowResize")
            self.invalidateIntrinsicContentSize()
        }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        taken = 0
    }

    /// A newer row draws over an older one: a bubble's mark sits half over
    /// its top edge, into the row above, and must not slip under that row.
    override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
        super.apply(layoutAttributes)
        layer.zPosition = CGFloat(layoutAttributes.zIndex) * 100_000 + CGFloat(layoutAttributes.indexPath.item)
    }

    override func preferredLayoutAttributesFitting(_ attributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        guard let fitted = attributes.copy() as? UICollectionViewLayoutAttributes else { return attributes }
        let started = CACurrentMediaTime()
        defer { PerfProbe.sample("fitMs", (CACurrentMediaTime() - started) * 1000) }
        if let slot = (contentView as? TranscriptContentSlot) ?? (contentView.subviews.first as? TranscriptContentSlot) {
            fitted.size.height = slot.fitting(width: attributes.size.width).height
            return fitted
        }
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: attributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
        )
        fitted.size.height = size.height
        return fitted
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/// Reports each touch down on its view, in the window, and recognizes
/// nothing: it fails at once, so it takes no touch from any other gesture.
private final class TouchDownRecorder: UIGestureRecognizer {
    private let onTouchDown: (CGPoint) -> Void

    init(onTouchDown: @escaping (CGPoint) -> Void) {
        self.onTouchDown = onTouchDown
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if let touch = touches.first, let window = view?.window {
            onTouchDown(touch.location(in: window))
        }
        state = .failed
    }
}


/// SwiftUI can update a representable while its bounds are still zero. The
/// first nonzero UIKit layout, not a queued main-thread block, places focus.
private final class TranscriptCollectionView: UICollectionView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}


private struct TranscriptSharedConfiguration: UIContentConfiguration {
    let position: TranscriptFocusPosition
    weak var list: UICollectionView?
    let id: String
    let top: CGFloat
    let box: RowBox
    let cells: CellContext
    let build: (TranscriptRow, TranscriptRow?) -> AnyView
    func makeContentView() -> UIView & UIContentView { TranscriptContentSlot(configuration: self) }
    func updated(for state: any UIConfigurationState) -> Self { self }
}

/// A layout placeholder; the live hosted content stays on the common surface.
@MainActor
final class TranscriptContentSlot: UIView, UIContentView {
    fileprivate var settings: TranscriptSharedConfiguration
    private(set) var held: TranscriptSharedContent
    weak var list: UICollectionView?
    var top: CGFloat { didSet { if oldValue != top { invalidateIntrinsicContentSize(); setNeedsLayout() } } }
    var configuration: any UIContentConfiguration {
        get { settings }
        set {
            guard let next = newValue as? TranscriptSharedConfiguration else { return }
            if next.id != settings.id {
                held.slots.remove(self)
                if held.owner === self { held.owner = nil }
                if held.view.superview === self { held.view.removeFromSuperview() }
                held = next.position.content(id: next.id) { next.makeSharedContent() }
                held.slots.add(self)
            }
            settings = next
            list = next.list
            top = next.top
            next.position.mount(self)
            invalidateIntrinsicContentSize()
            setNeedsLayout()
        }
    }
    fileprivate init(configuration: TranscriptSharedConfiguration) {
        settings = configuration
        held = configuration.position.content(id: configuration.id) { configuration.makeSharedContent() }
        list = configuration.list
        top = configuration.top
        super.init(frame: .zero)
        held.slots.add(self)
        configuration.position.mount(self)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    var isCurrent: Bool {
        var parent: UIView? = self
        while let view = parent {
            if let cell = view as? UICollectionViewCell {
                guard let list, let path = list.indexPath(for: cell) else { return false }
                return list.cellForItem(at: path) === cell && list.indexPathsForVisibleItems.contains(path)
            }
            parent = view.superview
        }
        return false
    }
    func fitting(width: CGFloat) -> CGSize {
        let size = held.measure(width)
        return CGSize(width: width, height: max(1, size.height) + top)
    }
    override var intrinsicContentSize: CGSize { fitting(width: max(1, list?.bounds.width ?? bounds.width)) }
    override func layoutSubviews() {
        super.layoutSubviews()
        settings.position.layout()
    }
    var zOrder: CGFloat {
        var parent: UIView? = self
        while let view = parent {
            if view is UICollectionViewCell { return view.layer.zPosition }
            parent = view.superview
        }
        return 0
    }
    func contentFrame(in surface: UIView) -> CGRect {
        convert(CGRect(x: 0, y: top, width: bounds.width, height: max(1, bounds.height - top)), to: surface)
    }
    func mount(on surface: TranscriptLiveSurface) {
        if held.owner !== self {
            held.adopt(self)
            held.owner = self
        }
        surface.keep(held)
        held.view.layer.zPosition = zOrder
        held.view.alpha = 1
        held.view.accessibilityElementsHidden = false
        let frame = contentFrame(in: surface)
        if held.view.frame != frame { held.view.frame = frame }
    }
    func measured(_ size: CGSize) {
        guard size.height > 0, abs(size.height + top - bounds.height) > 0.5 else { return }
        invalidateIntrinsicContentSize()
        var parent = superview
        while let view = parent {
            if let cell = view as? TranscriptCell { cell.measured(CGSize(width: size.width, height: size.height + top)); break }
            parent = view.superview
        }
    }
}


/// A scope change updates values in the same typed hosting root, rather than
/// replacing an AnyView root and losing a bubble's local SwiftUI state.
@MainActor
@Observable
private final class SharedTranscriptRowModel {
    let box: RowBox
    var cells: CellContext
    let surfaces: WidgetSurfaces
    var build: (TranscriptRow, TranscriptRow?) -> AnyView
    init(_ configuration: TranscriptSharedConfiguration) {
        box = RowBox(row: configuration.box.row, previous: configuration.box.previous)
        cells = configuration.cells
        surfaces = configuration.cells.surfaces
        build = configuration.build
    }
    func adopt(_ slot: TranscriptContentSlot) {
        let next = slot.settings
        if box.row != next.box.row { box.row = next.box.row }
        if box.previous != next.box.previous { box.previous = next.box.previous }
        if cells !== next.cells { cells = next.cells; build = next.build }
    }
}

private struct SharedTranscriptRowHost: View {
    let model: SharedTranscriptRowModel
    let id: String
    let position: TranscriptFocusPosition
    var body: some View {
        RowHost(box: model.box, cells: model.cells, surfaces: model.surfaces, build: model.build)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("shared-content/\(id)")
            .onGeometryChange(for: CGSize.self) { $0.size } action: { [weak position] size in position?.changed(id, size: size) }
    }
}

private extension TranscriptSharedConfiguration {
    @MainActor func makeSharedContent() -> TranscriptSharedContent {
        let model = SharedTranscriptRowModel(self)
        let view = UIHostingConfiguration { SharedTranscriptRowHost(model: model, id: id, position: position) }.margins(.all, 0).makeContentView()
        return TranscriptSharedContent(id: id, view: view, measure: { width in
            view.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        }) { slot in model.adopt(slot) }
    }
}

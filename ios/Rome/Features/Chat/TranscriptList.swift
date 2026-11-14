import ChatLayout
import os
import SwiftUI
import UIKit

/// A transcript in a `UICollectionView` laid out by ChatLayout, with each row
/// a SwiftUI view in its own cell. Only the rows near the screen are built
/// and measured. The layout keeps the rows in view where they are when older
/// pages go in above or rows above them grow, and keeps the newest row at the
/// bottom while the guardian is there.
struct TranscriptList<Row: View>: View {
    let store: TranscriptStore
    var composerFocused = false
    /// Short transcripts sit at the top instead of the bottom (task chats).
    var alignTop = false
    /// Drawn after the last row: the "Running…" line.
    var footer: AnyView? = nil
    /// Goes up when the newest rows must come into view (a tapped push).
    var latestRequest = 0
    @ViewBuilder let row: (TranscriptRow, TranscriptRow?) -> Row

    @State private var scroll = TranscriptScroll()
    /// The newest rows were on screen when the app left the foreground.
    @State private var leftAtBottom = false
    /// Until then, new rows bring the list to the bottom: the refetch after
    /// a return or a push tap lands a moment after it.
    @State private var catchUpUntil: Date?

    var body: some View {
        let rows = store.rows
        GeometryReader { proxy in
            ChatCollection(
                rows: rows,
                hasOlder: store.hasOlder,
                footer: footer,
                insets: proxy.safeAreaInsets,
                alignTop: alignTop,
                scroll: scroll,
                row: row,
                onNearTop: { Task { await store.loadOlder() } },
                onDividerAbove: { [pill = store.unreadPill] in pill.dividerAbove($0) }
            )
            .environment(\.shareTurns, store.share.isSelecting ? ShareTurns(messages: store.messages, rows: rows) : nil)
            .ignoresSafeArea()
        }
        .onChange(of: rows.last?.id) {
            if let until = catchUpUntil, Date.now < until { scroll.toBottom() }
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
            if new > old { scroll.toBottom() }
        }
        .onChange(of: store.arrivals) {
            if !scroll.following { scroll.unseen += 1 }
        }
        .onChange(of: composerFocused) { _, focused in
            if focused {
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    scroll.toBottom()
                }
            }
        }
        .overlay(alignment: .bottom) {
            if BackToBottom.visible(far: scroll.far, unseen: scroll.unseen, following: scroll.following) {
                // Outside the list's content, so a tap mid-glide reaches it.
                Button {
                    transcriptScrollLog.notice("back-to-bottom tapped")
                    scroll.toBottom()
                } label: {
                    BackToBottomGlyph(dot: scroll.unseen > 0)
                }
                .buttonStyle(PressScaleStyle(scale: 0.9))
                // About 12 pt above the composer, with the list's own inset.
                .padding(.bottom, 4)
                .accessibilityLabel(scroll.unseen > 0 ? Text("New messages. Scroll to the latest message") : Text("Scroll to the latest message"))
                .transition(.scale(scale: 0.7).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: BackToBottom.visible(far: scroll.far, unseen: scroll.unseen, following: scroll.following))
        .animation(.easeOut(duration: 0.2), value: scroll.unseen > 0)
    }

    private func catchUp() {
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
}

private struct ChatCollection<Row: View>: UIViewRepresentable {
    let rows: [TranscriptRow]
    let hasOlder: Bool
    let footer: AnyView?
    let insets: EdgeInsets
    let alignTop: Bool
    let scroll: TranscriptScroll
    let row: (TranscriptRow, TranscriptRow?) -> Row
    let onNearTop: () -> Void
    let onDividerAbove: (Bool) -> Void

    func makeCoordinator() -> TranscriptCoordinator<Row> {
        TranscriptCoordinator(row: row, alignTop: alignTop)
    }

    func makeUIView(context: Context) -> UICollectionView {
        context.coordinator.makeView()
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
        let coordinator = context.coordinator
        coordinator.row = row
        coordinator.onNearTop = onNearTop
        coordinator.onDividerAbove = onDividerAbove
        coordinator.scroll = scroll
        scroll.target = coordinator
        PerfProbe.count("listUpdate")
        coordinator.cells.environment = context.environment
        coordinator.cells.footer = footer
        coordinator.set(insets: insets)
        coordinator.apply(rows: rows, hasOlder: hasOlder, footer: footer != nil)
    }
}

/// Keeps the collection view's items, insets and scroll for `ChatCollection`.
@MainActor
private final class TranscriptCoordinator<RowView: View>: NSObject, UICollectionViewDelegate, ChatLayoutDelegate, TranscriptScrollTarget {
    var row: (TranscriptRow, TranscriptRow?) -> RowView
    var onNearTop: () -> Void = {}
    var onDividerAbove: (Bool) -> Void = { _ in }
    weak var scroll: TranscriptScroll?
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
    /// The last answer given to `onDividerAbove`.
    private var dividerAbove: Bool?
    #if DEBUG
    private let holdProbe = HoldProbe()
    #endif

    init(row: @escaping (TranscriptRow, TranscriptRow?) -> RowView, alignTop: Bool) {
        self.row = row
        self.alignTop = alignTop
    }

    func makeView() -> UICollectionView {
        layout.delegate = self
        layout.settings.estimatedItemSize = CGSize(width: 300, height: Self.estimate)
        // Updates keep what is on screen anchored to the bottom of the
        // visible area: a page above, or a row above that grows, moves
        // nothing in view, and the newest row stays at the bottom.
        layout.keepContentOffsetAtBottomOnBatchUpdates = true
        layout.keepContentAtBottomOfVisibleArea = !alignTop
        layout.supportSelfSizingInvalidation = true
        let view = UICollectionView(frame: .zero, collectionViewLayout: layout)
        view.backgroundColor = .clear
        view.contentInsetAdjustmentBehavior = .never
        view.keyboardDismissMode = .interactive
        view.alwaysBounceVertical = true
        view.selfSizingInvalidation = .enabled
        // https://openradar.appspot.com/40926834: prefetching keeps stale cells.
        view.isPrefetchingEnabled = false
        view.delegate = self
        if #available(iOS 26, *) {
            view.topEdgeEffect.style = .soft
        }
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
        return UIHostingConfiguration {
            // A row that grows past its cell without telling it reports
            // the size it took.
            content
                .onGeometryChange(for: CGSize.self) { $0.size } action: { [weak cell] size in
                    cell?.measured(size)
                }
        }
        .margins(.all, 0)
    }

    // MARK: Content

    func apply(rows: [TranscriptRow], hasOlder: Bool, footer: Bool) {
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
        if footer { next.append(ItemID.footer) }
        for id in boxes.keys where !live.contains(id) { boxes[id] = nil }
        guard next != items, let dataSource, let view else { return }
        let started = CACurrentMediaTime()
        let first = items.isEmpty
        let held = items
        // Read before the update: rows going in move the bottom away.
        let onBottom = (scroll?.following ?? true) && (scroll?.atBottom ?? true)
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(next)
        if first {
            dataSource.applySnapshotUsingReloadData(snapshot) { self.items = next }
            view.layoutIfNeeded()
            restoreToBottom()
            warmRowsAbove()
        } else {
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false) { self.items = next }
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
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, let view = self.view else { return }
            let top = view.indexPathsForVisibleItems.map(\.item).min() ?? self.items.count
            let width = view.bounds.width
            for index in stride(from: top - 1, through: max(0, top - 12), by: -1) {
                guard let id = self.items[safe: index], let box = self.boxes[id] else { continue }
                let host = UIHostingController(rootView: RowHost(box: box, cells: self.cells) { [weak self] row, previous in
                    self.map { AnyView($0.row(row, previous)) } ?? AnyView(EmptyView())
                })
                let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
                // Drawn once too: text and pictures are rasterized on first draw.
                host.view.frame = CGRect(origin: .zero, size: CGSize(width: width, height: max(1, size.height)))
                host.view.layoutIfNeeded()
                _ = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { context in host.view.layer.render(in: context.cgContext) }
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
        guard next != screenInsets, let view else { return }
        screenInsets = next
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
    }

    // MARK: Scrolling

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        readScroll()
    }

    private func readScroll() {
        guard let view, let scroll else { return }
        let height = view.bounds.height - screenInsets.top - screenInsets.bottom
        let distance = BackToBottom.distance(contentHeight: view.contentSize.height, offset: view.contentOffset.y, viewHeight: view.bounds.height, bottomInset: view.contentInset.bottom)
        scroll.set(atBottom: distance < 7, far: BackToBottom.shows(scroll.far, distance: distance, height: height))
        let fromTop = view.contentOffset.y + view.contentInset.top
        if items.first == ItemID.older, height > 0, !scrollingToTop, fromTop < height * 4 { onNearTop() }
        readDivider(in: view)
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
        revealing = nil
        scroll?.set(following: false)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { cameToRest() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        cameToRest()
    }

    private func cameToRest() {
        scroll?.set(following: scroll?.atBottom ?? true)
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        revealing = nil
        scrollingToTop = true
        scroll?.set(following: false)
        return true
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        scrollingToTop = false
        readScroll()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        if scroll?.following == true {
            // Rows measured on the way down: land on the newest row exactly.
            restoreToBottom()
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
        guard let view, let offset = offset(revealing: rowId, atTop: atTop) else { return }
        if view.isDecelerating { view.setContentOffset(view.contentOffset, animated: false) }
        revealing = (rowId, atTop)
        view.setContentOffset(CGPoint(x: 0, y: offset), animated: true)
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

    // MARK: Heights

    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        guard let id = items[safe: indexPath.item] else { return }
        heights[id] = cell.bounds.height
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
    let build: (TranscriptRow, TranscriptRow?) -> AnyView

    var body: some View {
        build(box.row, box.previous)
            .padding(.horizontal, Metrics.pagePadding)
            .readableColumn()
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

    override func preferredLayoutAttributesFitting(_ attributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        guard let fitted = attributes.copy() as? UICollectionViewLayoutAttributes else { return attributes }
        let started = CACurrentMediaTime()
        defer { PerfProbe.sample("fitMs", (CACurrentMediaTime() - started) * 1000) }
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

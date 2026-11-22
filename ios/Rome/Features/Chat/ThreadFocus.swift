import SwiftUI

/// A server-ordered window of one reply chain. The chat owns its live events;
/// this window owns no subscription, read mark or copy on disk.
@MainActor
@Observable
final class ThreadFocus {
    enum Side { case before, after }
    enum Initial { case loading, failed }
    let anchor: String
    let original: String
    private(set) var root: String
    let row: String
    let bubbleY: CGFloat?
    let hitAreas = ThreadFocusHitAreas()
    let transcript: TranscriptStore
    private(set) var hasOlder: Bool
    private(set) var hasNewer: Bool
    private(set) var loading = false
    private(set) var initial: Initial?
    @ObservationIgnored private var updates: [ChatMessage] = []
    private var fetchedThrough: String?
    private var reconcilePending = false
    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private let sessionId: String

    init(sessionId: String, anchor: String, row: String, bubbleY: CGFloat?, page: ThreadPage, backend: RomeBackend, pending: Bool = false, root: String? = nil, original: String? = nil) {
        self.sessionId = sessionId
        self.anchor = anchor
        self.original = original ?? anchor
        self.row = row
        self.bubbleY = bubbleY
        self.root = root ?? page.messages.first(where: { $0.id == anchor })?.chatThreadId ?? anchor
        initial = pending ? .loading : nil
        hasOlder = page.hasOlder
        hasNewer = page.hasNewer
        self.backend = backend
        transcript = TranscriptStore(sessionId: sessionId, kind: .concierge, backend: backend)
        transcript.holdThreadMessages(page.messages)
        fetchedThrough = page.messages.last(where: { !$0.isTrace })?.id
    }

    static func memory(_ messages: [ChatMessage], root: String, anchor: String) -> [ChatMessage] {
        let said = messages.filter { !$0.isTrace && ($0.chatThreadId == root || $0.id == root || $0.id == anchor) }
        let turns = Set(said.compactMap(\.turnId))
        let ids = Set(said.map(\.id))
        return messages.filter { $0.isTrace ? $0.turnId.map { turns.contains($0) } == true : ids.contains($0.id) }
    }

    func hydrate(_ page: ThreadPage) {
        let held = transcript.messages
        let ids = Set(page.messages.map(\.id))
        let heldIDs = Set(held.map(\.id))
        let anchor = page.messages.first { !$0.isTrace && heldIDs.contains($0.id) }
        let split = anchor.flatMap { anchor in held.firstIndex { $0.id == anchor.id } } ?? 0
        var merged = held[..<split].filter { !ids.contains($0.id) } + page.messages + held[split...].filter { !ids.contains($0.id) }
        // Live edits made after this read began win over its older snapshot.
        for message in updates {
            if let at = merged.firstIndex(where: { $0.id == message.id }) { merged[at] = message }
            else if !page.hasNewer { merged.append(message) }
        }
        root = page.messages.first(where: { $0.id == self.anchor })?.chatThreadId ?? root
        hasOlder = page.hasOlder
        hasNewer = page.hasNewer
        fetchedThrough = page.messages.last(where: { !$0.isTrace })?.id
        initial = nil
        updates.removeAll()
        if merged != held { transcript.holdThreadMessages(merged) }
        if reconcilePending {
            reconcilePending = false
            Task { await self.load(.after, reconcile: true) }
        }
    }

    func failed() { initial = .failed }
    func retry() { initial = .loading }

    var reply: ChatMessage? {
        transcript.messages.last { message in
            !message.isTrace && message.parts.contains { ($0.textContent ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
        }
    }

    func load(_ side: Side, reconcile: Bool = false) async {
        guard initial == nil else {
            if reconcile { reconcilePending = true }
            return
        }
        guard !loading else {
            if reconcile { reconcilePending = true }
            return
        }
        guard reconcile || (side == .before ? hasOlder : hasNewer) else { return }
        let said = transcript.messages.filter { !$0.isTrace }
        guard let cursor = reconcile ? fetchedThrough : (side == .before ? said.first?.id : said.last?.id) else { return }
        loading = true
        defer {
            loading = false
            if reconcilePending {
                reconcilePending = false
                if !hasNewer { Task { await self.load(.after, reconcile: true) } }
            }
        }
        guard let page = try? await backend.threadPage(sessionId: sessionId, anchor: anchor, before: side == .before ? cursor : nil, after: side == .after ? cursor : nil, limit: 20), !Task.isCancelled else { return }
        let ids = Set(page.messages.map(\.id))
        if side == .before {
            transcript.holdThreadMessages(page.messages + transcript.messages.filter { !ids.contains($0.id) })
            hasOlder = page.hasOlder
        } else {
            // Traces may occur on both pages. Their new copy takes their
            // server-specified position, as on the main transcript.
            let held = transcript.messages
            let split = held.firstIndex(where: { $0.id == cursor }).map { $0 + 1 } ?? held.count
            transcript.holdThreadMessages(held[..<split].filter { !ids.contains($0.id) } + page.messages + held[split...].filter { !ids.contains($0.id) })
            fetchedThrough = page.messages.last(where: { !$0.isTrace })?.id ?? fetchedThrough
            hasNewer = page.hasNewer
        }
    }

    func receive(_ message: ChatMessage) {
        var held = transcript.messages
        let traceOfChain = message.isTrace && message.turnId.map { turn in held.contains { $0.turnId == turn } } == true
        guard held.contains(where: { $0.id == message.id }) || message.chatThreadId == root || traceOfChain else { return }
        if initial != nil { remember(message) }
        if let index = held.firstIndex(where: { $0.id == message.id }) {
            held[index] = message
        } else {
            guard initial == nil, !hasNewer, message.chatThreadId == root || traceOfChain else { return }
            held.append(message)
        }
        transcript.holdThreadMessages(held)
    }

    private func remember(_ message: ChatMessage) {
        if let at = updates.firstIndex(where: { $0.id == message.id }) { updates[at] = message }
        else { updates.append(message) }
    }

    func handle(_ event: LiveEvent, sessionId: String) {
        switch event {
        case .reaction(let id, let messageId, let reaction) where id == sessionId:
            if var message = transcript.message(messageId) { message.reaction = reaction; receive(message) }
        case .status(let id, let messageId, let status) where id == sessionId:
            if var message = transcript.message(messageId) { message.status = status; receive(message) }
        case .cardSettled(let id, let card) where id == sessionId:
            let before = transcript.messages
            transcript.settle(card)
            if initial != nil {
                for (old, new) in zip(before, transcript.messages) where old != new { remember(new) }
            }
        default: break
        }
    }

    func updateHeld(_ messages: [ChatMessage]) {
        if initial != nil {
            for message in Self.memory(messages, root: root, anchor: anchor) where transcript.message(message.id) != message { receive(message) }
        }
        let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let held = transcript.messages.map { byID[$0.id] ?? $0 }
        if held != transcript.messages { transcript.holdThreadMessages(held) }
    }

    /// A newest-page read can include the guardian's own send, which has no
    /// live insert. Only append beyond a shared message, never across a gap.
    func catchUp(_ messages: [ChatMessage]) {
        updateHeld(messages)
        if initial != nil { reconcilePending = true; return }
        guard !hasNewer, let last = transcript.messages.last(where: { !$0.isTrace }) else { return }
        let known = Set(transcript.messages.map(\.id))
        let unknown = messages.indices.filter { messages[$0].chatThreadId == root && !known.contains(messages[$0].id) }
        let at = messages.firstIndex(where: { $0.id == last.id })
        // An old chain can be absent from the newest main-chat page. A live
        // answer can also arrive before that page brings the guardian's send.
        // Reconcile from the thread API's last confirmed cursor, not that answer.
        if !unknown.isEmpty, at == nil || unknown.contains(where: { $0 <= at! }) {
            Task { await self.load(.after, reconcile: true) }
            return
        }
        if let at { for message in messages.dropFirst(at + 1) { receive(message) } }
    }
}

/// Owns only the two transcript collections and their list-local picture.
/// The main collection never moves: closing is the same handoff in reverse.
@MainActor
final class TranscriptFocusPosition {
    var frame: (String) -> CGRect? = { _ in nil }
    var pause: () -> Void = {}
    weak var main: UICollectionView?
    weak var focused: UICollectionView?
    weak var surface: UIView?
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
    private var animator: UIViewPropertyAnimator?
    private weak var active: ThreadFocus?

    func begin(_ focus: ThreadFocus) {
        finish()
        active = focus
    }

    func ready(_ list: UICollectionView, for focus: ThreadFocus) {
        guard active === focus, focused !== list else { return }
        focused = list
        guard let main else { list.alpha = 1; return }
        swap(from: main, to: list) {}
    }

    func close(animated: Bool = true, _ completion: @escaping () -> Void) {
        active = nil
        finish()
        guard let focused, let main else {
            main?.alpha = 1
            completion()
            return
        }
        self.focused = nil
        if animated { swap(from: focused, to: main, completion: completion) }
        else { focused.alpha = 0; main.alpha = 1; completion() }
    }

    private func finish() {
        guard let animator else { return }
        animator.stopAnimation(false)
        animator.finishAnimation(at: .end)
    }

    private struct Picture {
        let id: String
        let view: UIView
        let frame: CGRect
    }

    private func pictures(_ list: UICollectionView, in surface: UIView) -> [Picture] {
        list.visibleCells.flatMap { cell -> [Picture] in
            guard let row = cell.accessibilityIdentifier else { return [] }
            func markers(_ view: UIView) -> [UIView] {
                if view is ThreadFocusBubbleMarker { return [view] }
                return view.subviews.flatMap(markers)
            }
            let bubbles = markers(cell)
            return (bubbles.isEmpty ? [cell] : bubbles).enumerated().compactMap { index, bubble in
                let bounds = bubble.convert(bubble.bounds, to: cell)
                let frame = cell.convert(bounds, to: surface)
                guard frame.intersects(surface.bounds), !bounds.isEmpty,
                      let snapshot = cell.resizableSnapshotView(from: bounds, afterScreenUpdates: true, withCapInsets: .zero) else { return nil }
                let id = "\(row)/\(index)"
                snapshot.frame = frame
                snapshot.accessibilityIdentifier = id
                return Picture(id: id, view: snapshot, frame: frame)
            }
        }
    }

    private func swap(from source: UICollectionView, to target: UICollectionView, completion: @escaping () -> Void) {
        finish()
        target.layoutIfNeeded()
        guard let surface, surface.window != nil, !surface.bounds.isEmpty else {
            target.alpha = 1
            source.alpha = 0
            completion()
            return
        }
        // Both lists have finished nonzero layout. No display frame can see
        // neither list: the old one is hidden only after the pictures exist.
        target.alpha = 1
        let old = pictures(source, in: surface)
        let new = pictures(target, in: surface)
        let destinations = Dictionary(new.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let oldIDs = Set(old.map(\.id))
        for picture in old { surface.addSubview(picture.view) }
        let reduced = reduceMotion()
        for picture in new where reduced || !oldIDs.contains(picture.id) {
            picture.view.alpha = 0
            surface.addSubview(picture.view)
        }
        guard !old.isEmpty, !new.isEmpty else {
            surface.subviews.forEach { $0.removeFromSuperview() }
            source.alpha = 0
            completion()
            return
        }
        source.alpha = 0
        target.alpha = 0
        PerfProbe.count("threadHandoff")
        PerfProbe.sample("threadMatched", Double(old.filter { destinations[$0.id] != nil }.count))
        let animator = UIViewPropertyAnimator(duration: reduced ? 0.15 : 0.25, curve: .easeInOut) {
            for picture in old {
                if let destination = destinations[picture.id], !reduced {
                    picture.view.frame = destination.frame
                } else {
                    picture.view.alpha = 0
                }
            }
            for picture in new where reduced || !oldIDs.contains(picture.id) {
                picture.view.alpha = 1
            }
        }
        self.animator = animator
        animator.addCompletion { [weak self, weak surface, weak target] _ in
            target?.alpha = 1
            surface?.subviews.forEach { $0.removeFromSuperview() }
            self?.animator = nil
            completion()
        }
        animator.startAnimation()
    }
}

private struct ThreadTransitionSurface: UIViewRepresentable {
    let position: TranscriptFocusPosition
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.clipsToBounds = true
        view.accessibilityElementsHidden = true
        position.surface = view
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
}

private struct ThreadFocusModifier: ViewModifier {
    let store: TranscriptStore
    let tasks: TaskChatsStore
    let composerFocused: Bool

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(store.threadFocus == nil)
            .accessibilityHidden(store.threadFocus != nil)
            .overlay {
                if let focus = store.threadFocus {
                    TranscriptList(store: focus.transcript, composerFocused: composerFocused, alignTop: true, thread: focus, focusPosition: store.focusPosition, onBlankTap: { store.closeThread() }) { row, previous in
                        ConciergeRow(row: row, info: focus.transcript.info(for: row), store: store, tasks: tasks, quotesInteractive: false)
                            .equatable()
                            .padding(.top, TranscriptSpacing.top(row, after: previous))
                    }
                    .environment(\.threadFocusHitAreas, focus.hitAreas)
                }
            }
            .overlay { ThreadTransitionSurface(position: store.focusPosition).ignoresSafeArea().allowsHitTesting(false) }
            .overlay(alignment: .top) {
                if let focus = store.threadFocus, focus.initial == .failed {
                    TopBanner(kind: .error, text: String(localized: "Couldn't load this chat"), actionTitle: String(localized: "Retry")) { store.retryThread() }
                        .padding(.top, 70)
                }
            }

    }
}

extension View {
    func threadFocus(store: TranscriptStore, tasks: TaskChatsStore, composerFocused: Bool) -> some View {
        modifier(ThreadFocusModifier(store: store, tasks: tasks, composerFocused: composerFocused))
    }
}

@MainActor
final class ThreadFocusHitAreas {
    private let views = NSHashTable<UIView>.weakObjects()
    func add(_ view: UIView) { views.add(view) }
    func contains(_ point: CGPoint) -> Bool {
        views.allObjects.contains { $0.window != nil && $0.convert($0.bounds, to: nil).contains(point) }
    }
}

extension EnvironmentValues {
    @Entry var threadFocusHitAreas: ThreadFocusHitAreas? = nil
}

private struct ThreadFocusHitArea: ViewModifier {
    @Environment(\.threadFocusHitAreas) private var areas
    func body(content: Content) -> some View {
        content.background { ThreadFocusMarker(areas: areas) }
    }
}

private final class ThreadFocusBubbleMarker: UIView {}

private struct ThreadFocusMarker: UIViewRepresentable {
    let areas: ThreadFocusHitAreas?
    func makeUIView(context: Context) -> UIView {
        let view = ThreadFocusBubbleMarker()
        view.isUserInteractionEnabled = false
        areas?.add(view)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
}

extension View {
    func threadFocusHitArea() -> some View { modifier(ThreadFocusHitArea()) }
}

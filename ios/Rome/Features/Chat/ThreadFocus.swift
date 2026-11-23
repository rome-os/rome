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

/// One live hosted content view per stable message/part id. The collections
/// own layout slots, not competing renderings of the same message.
@MainActor
final class TranscriptSharedContent {
    let id: String
    let view: UIView
    let measure: (CGFloat) -> CGSize
    let adopt: (TranscriptContentSlot) -> Void
    weak var owner: TranscriptContentSlot?
    let slots = NSHashTable<TranscriptContentSlot>.weakObjects()
    init(id: String, view: UIView, measure: @escaping (CGFloat) -> CGSize, adopt: @escaping (TranscriptContentSlot) -> Void) {
        self.id = id; self.view = view; self.measure = measure; self.adopt = adopt
    }
}

@MainActor
private final class WeakTranscriptContent {
    weak var value: TranscriptSharedContent?
    init(_ value: TranscriptSharedContent) { self.value = value }
}

@MainActor
final class TranscriptFocusPosition {
    var frame: (String) -> CGRect? = { _ in nil }
    var pause: () -> Void = {}
    var mainGeometry: (String) -> CGRect? = { _ in nil }
    var focusedGeometry: (String) -> CGRect? = { _ in nil }
    weak var main: UICollectionView?
    weak var focused: UICollectionView?
    weak var surface: TranscriptLiveSurface?
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
    private var animator: UIViewPropertyAnimator?
    private weak var active: ThreadFocus?
    private var contents: [String: WeakTranscriptContent] = [:]
    private var presentations: [TranscriptSharedContent] { contents.values.compactMap(\.value) }
    private var travelling: [TranscriptSharedContent] = []
    private(set) var handoffs = 0
    private var closing = false
    private var layingOut = false
    private var mainInput: [UIGestureRecognizer] = []
    private var focusInput: [UIGestureRecognizer] = []
    private weak var focusInputList: UICollectionView?
    var transitioning: Bool { animator != nil || !travelling.isEmpty }
    private var activeList: UICollectionView? { closing ? main : (focused ?? main) }

    func content(id: String, make: () -> TranscriptSharedContent) -> TranscriptSharedContent {
        prune()
        if let held = contents[id]?.value { return held }
        let held = make()
        held.view.accessibilityIdentifier = "shared-content/\(id)"
        contents[id] = WeakTranscriptContent(held)
        return held
    }

    func mount(_ slot: TranscriptContentSlot) {
        guard !transitioning, slot.isCurrent, slot.list === activeList, let surface else { return }
        slot.mount(on: surface)
    }

    func layout() {
        guard !layingOut, !transitioning, let list = activeList, list.window != nil, let surface else { return }
        layingOut = true
        defer { layingOut = false }
        installInput(on: list)
        UIView.performWithoutAnimation {
            for held in presentations {
                if let slot = held.slots.allObjects.first(where: { $0.list === list && $0.isCurrent }) {
                    slot.mount(on: surface)
                } else {
                    held.view.alpha = 0
                    held.view.accessibilityElementsHidden = true
                }
            }
        }
        surface.accessibilityElements = presentations.filter { $0.owner?.list === list && $0.view.alpha > 0 }.sorted { $0.view.frame.minY < $1.view.frame.minY }.map(\.view)
        surface.accessibilityIdentifier = list === main ? "main-transcript-content" : "reply-chain-content"
        surface.prune()
    }

    func registerInput(_ view: UICollectionView, gestures: [UIGestureRecognizer]) {
        if view === main { mainInput = gestures }
        else { focusInputList = view; focusInput = gestures }
        if let list = activeList { installInput(on: list) }
    }

    private func restoreInput(_ gestures: [UIGestureRecognizer], to list: UICollectionView?) {
        guard let list else { return }
        for gesture in gestures where gesture.view === surface { list.addGestureRecognizer(gesture) }
    }

    // UIKit owns the existing scroll physics; only the recognizer's touch
    // scope moves to the stable content layer (WWDC14, session235).
    private func installInput(on list: UICollectionView) {
        guard let surface else { return }
        if list !== main { restoreInput(mainInput, to: main) }
        if list !== focusInputList { restoreInput(focusInput, to: focusInputList) }
        let input = list === main ? mainInput : focusInput
        for gesture in input where gesture.view !== surface { surface.addGestureRecognizer(gesture) }
    }

    func scrollAccessible(_ direction: UIAccessibilityScrollDirection) -> Bool { activeList?.accessibilityScroll(direction) ?? false }

    func finishForDrag() {
        guard let animator else { return }
        animator.stopAnimation(false)
        animator.finishAnimation(at: .end)
    }

    func removeSurface() {
        interrupt()
        travelling.removeAll()
        restoreInput(mainInput, to: main)
        restoreInput(focusInput, to: focusInputList)
        surface?.clear()
        surface?.removeFromSuperview()
        surface = nil
    }

    func changed(_ id: String, size: CGSize) {
        guard let held = contents[id]?.value else { return }
        for slot in held.slots.allObjects { slot.measured(size) }
    }

    private func prune() {
        guard travelling.isEmpty else { return }
        contents = contents.filter { $0.value.value != nil }
    }

    func detach(_ list: UICollectionView) {
        if list === main { restoreInput(mainInput, to: list); mainInput.removeAll() }
        if list === focusInputList { restoreInput(focusInput, to: list); focusInput.removeAll(); focusInputList = nil }
        if main === list || focused === list {
            interrupt()
            travelling.removeAll()
        }
        for held in presentations {
            for slot in held.slots.allObjects where slot.list === list {
                held.slots.remove(slot)
                if held.owner === slot {
                    held.view.removeFromSuperview()
                    held.owner = nil
                }
            }
        }
        if main === list { main = nil }
        if focused === list { focused = nil }
        surface?.prune()
        prune()
    }

    func begin(_ focus: ThreadFocus) { active = focus; closing = false }

    func ready(_ list: UICollectionView, for focus: ThreadFocus) {
        guard active === focus, focused !== list else { return }
        focused = list
        guard let main else { list.alpha = 1; return }
        move(from: main, to: list) {}
    }

    func close(animated: Bool = true, _ completion: @escaping () -> Void) {
        guard !closing || !animated else { return }
        active = nil
        guard let focused, let main else { main?.alpha = 1; completion(); return }
        closing = true
        move(from: focused, to: main, animated: animated) { [weak self] in
            self?.focused = nil
            self?.closing = false
            completion()
        }
    }

    private func interrupt() {
        guard let animator else { return }
        let frames = travelling.map { ($0.view, $0.view.layer.presentation()?.frame ?? $0.view.frame, $0.view.layer.presentation()?.opacity ?? Float($0.view.alpha)) }
        animator.stopAnimation(true)
        self.animator = nil
        for (view, frame, opacity) in frames { view.frame = frame; view.alpha = CGFloat(opacity) }
    }

    private func move(from source: UICollectionView, to target: UICollectionView, animated: Bool = true, completion: @escaping () -> Void) {
        interrupt()
        target.layoutIfNeeded()
        guard let surface, surface.window != nil, !surface.bounds.isEmpty else {
            target.alpha = 1; source.alpha = 0
            for held in presentations {
                held.slots.allObjects.first { $0.list === target }.map { if let surface = self.surface { $0.mount(on: surface) } }
            }
            completion(); return
        }
        target.alpha = 1
        installInput(on: target)
        surface.accessibilityIdentifier = target === main ? "main-transcript-content" : "reply-chain-content"
        let wasTravelling = Set(travelling.map(\.id))
        let rows = presentations.filter { held in
            wasTravelling.contains(held.id) || held.slots.allObjects.contains { slot in
                (slot.list === source || slot.list === target) && slot.isCurrent && slot.window != nil && slot.convert(slot.bounds, to: surface).intersects(surface.bounds)
            }
        }
        travelling = Array(rows)
        let foreground = (rows.map { $0.view.layer.zPosition }.max() ?? 0) + 1
        struct Move { let held: TranscriptSharedContent; let destination: TranscriptContentSlot?; let frame: CGRect; let belongs: Bool }
        let moves: [Move] = rows.map { held in
            let destination = held.slots.allObjects.first { $0.list === target && $0.isCurrent && $0.window != nil }
            let oldSlot = held.slots.allObjects.first { $0.list === source && $0.isCurrent && $0.window != nil }
            let view = held.view
            let oldFrame = view.superview === surface ? view.frame : view.convert(view.bounds, to: surface)
            let isOld = wasTravelling.contains(held.id) || (oldSlot != nil && view.superview === surface && view.alpha > 0.01 && view.frame.intersects(surface.bounds))
            let geometry = target === main ? mainGeometry(held.id) : focusedGeometry(held.id)
            let targetFrame = destination?.contentFrame(in: surface) ?? geometry.map { surface.convert($0, from: nil) }
            let end = targetFrame ?? oldFrame
            if view.superview !== surface { surface.keep(held) }
            if !isOld {
                UIView.performWithoutAnimation { view.frame = end; view.alpha = 0 }
            }
            UIView.performWithoutAnimation {
                view.layer.zPosition = targetFrame == nil ? view.layer.zPosition : foreground + (destination?.zOrder ?? 0)
            }
            view.accessibilityElementsHidden = false
            return Move(held: held, destination: destination, frame: end, belongs: targetFrame != nil)
        }
        // The same live views stay on the common list-local surface.
        // Both collections keep their geometry; no screenshot or replacement
        // rendering is made at either end of the handoff.
        source.alpha = 1
        target.alpha = 1
        // Commit prepared geometry before UIKit reads the animation start.
        handoffs += 1
        PerfProbe.count("threadHandoff")
        PerfProbe.sample("threadMatched", Double(moves.filter { move in move.destination != nil && move.held.slots.allObjects.contains { $0.list === source } }.count))
        let reduced = reduceMotion()
        if reduced { for move in moves { move.held.view.frame = move.frame } }
        CATransaction.flush()
        let changes = {
            for move in moves {
                if !reduced { move.held.view.frame = move.frame }
                move.held.view.alpha = move.belongs ? 1 : 0
            }
        }
        let finish = { [weak self] in
            guard let self else { return }
            source.alpha = 0
            target.alpha = 1
            self.animator = nil
            self.travelling.removeAll()
            self.layout()
            completion()
            self.prune()
        }
        if !animated { changes(); finish(); return }
        let animator = UIViewPropertyAnimator(duration: reduced ? 0.15 : 0.25, curve: .easeInOut, animations: changes)
        self.animator = animator
        animator.addCompletion { _ in finish() }
        animator.startAnimation()
    }

    func containsBubble(_ point: CGPoint) -> Bool {
        func contains(_ view: UIView) -> Bool {
            if view is ThreadFocusBubbleMarker { return view.convert(view.bounds, to: nil).contains(point) }
            return view.subviews.contains(where: contains)
        }
        return presentations.contains { held in
            (held.owner?.list === (focused ?? main) || travelling.contains { $0 === held }) && held.view.window != nil && held.view.alpha > 0 && contains(held.view)
        }
    }
}

@MainActor
final class TranscriptLiveSurface: UIView {
    private var held: [String: TranscriptSharedContent] = [:]
    func keep(_ content: TranscriptSharedContent) {
        held[content.id] = content
        if content.view.superview !== self { addSubview(content.view) }
    }
    func prune() {
        for (id, content) in held where !content.slots.allObjects.contains(where: \.isCurrent) {
            content.view.removeFromSuperview()
            held[id] = nil
        }
    }
    func clear() {
        subviews.forEach { $0.removeFromSuperview() }
        held.removeAll()
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard self.point(inside: point, with: event) else { return nil }
        for view in subviews.sorted(by: { $0.layer.zPosition > $1.layer.zPosition }) {
            if let hit = view.hitTest(convert(point, to: view), with: event) { return hit }
        }
        return self
    }
    weak var position: TranscriptFocusPosition?
    override func layoutSubviews() { super.layoutSubviews(); position?.layout() }
    override func didMoveToWindow() { super.didMoveToWindow(); if window != nil { position?.layout() } }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool { position?.scrollAccessible(direction) ?? false }
}

private struct ThreadTransitionSurface: UIViewRepresentable {
    let position: TranscriptFocusPosition
    func makeUIView(context: Context) -> UIView {
        let view = TranscriptLiveSurface()
        view.clipsToBounds = true
        view.position = position
        view.accessibilityContainerType = .list
        position.surface = view
        return view
    }
    func updateUIView(_ view: UIView, context: Context) { position.layout() }
    static func dismantleUIView(_ view: UIView, coordinator: ()) { (view as? TranscriptLiveSurface)?.position?.removeSurface() }
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
                    TranscriptList(store: focus.transcript, sharedContent: true, showsBackToBottom: false, composerFocused: composerFocused, alignTop: true, thread: focus, focusPosition: store.focusPosition, onBlankTap: { store.closeThread() }) { row, previous in
                        SharedConciergeRow(row: row, info: store.sharedInfo(for: row, fallback: focus.transcript), store: store, tasks: tasks, top: TranscriptSpacing.top(row, after: previous), quotesInteractive: false)
                    }
                    .environment(\.threadFocusHitAreas, focus.hitAreas)
                }
            }
            .overlay { ThreadTransitionSurface(position: store.focusPosition).ignoresSafeArea() }
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

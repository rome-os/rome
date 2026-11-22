import SwiftUI

/// A server-ordered window of one reply chain. The chat owns its live events;
/// this window owns no subscription, read mark or copy on disk.
@MainActor
@Observable
final class ThreadFocus {
    enum Side { case before, after }
    let anchor: String
    let root: String
    let row: String
    let bubbleY: CGFloat?
    let hitAreas = ThreadFocusHitAreas()
    let transcript: TranscriptStore
    private(set) var hasOlder: Bool
    private(set) var hasNewer: Bool
    private(set) var loading = false
    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private let sessionId: String

    init(sessionId: String, anchor: String, row: String, bubbleY: CGFloat?, page: ThreadPage, backend: RomeBackend) {
        self.sessionId = sessionId
        self.anchor = anchor
        self.row = row
        self.bubbleY = bubbleY
        root = page.messages.first(where: { $0.id == anchor })?.chatThreadId ?? anchor
        hasOlder = page.hasOlder
        hasNewer = page.hasNewer
        self.backend = backend
        transcript = TranscriptStore(sessionId: sessionId, kind: .concierge, backend: backend)
        transcript.holdThreadMessages(page.messages)
    }

    var reply: ChatMessage? {
        transcript.messages.last { message in
            !message.isTrace && message.parts.contains { ($0.textContent ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
        }
    }

    func load(_ side: Side) async {
        guard !loading, side == .before ? hasOlder : hasNewer else { return }
        let said = transcript.messages.filter { !$0.isTrace }
        guard let cursor = side == .before ? said.first?.id : said.last?.id else { return }
        loading = true
        defer { loading = false }
        guard let page = try? await backend.threadPage(sessionId: sessionId, anchor: anchor, before: side == .before ? cursor : nil, after: side == .after ? cursor : nil, limit: 20), !Task.isCancelled else { return }
        let ids = Set(page.messages.map(\.id))
        if side == .before {
            transcript.holdThreadMessages(page.messages + transcript.messages.filter { !ids.contains($0.id) })
            hasOlder = page.hasOlder
        } else {
            // Traces may occur on both pages. Their new copy takes their
            // server-specified position, as on the main transcript.
            transcript.holdThreadMessages(transcript.messages.filter { !ids.contains($0.id) } + page.messages)
            hasNewer = page.hasNewer
        }
    }

    func receive(_ message: ChatMessage) {
        var held = transcript.messages
        if let index = held.firstIndex(where: { $0.id == message.id }) {
            held[index] = message
        } else {
            let traceOfChain = message.isTrace && message.turnId.map { turn in held.contains { $0.turnId == turn } } == true
            guard !hasNewer, message.chatThreadId == root || traceOfChain else { return }
            held.append(message)
        }
        transcript.holdThreadMessages(held)
    }

    func handle(_ event: LiveEvent, sessionId: String) {
        switch event {
        case .reaction(let id, let messageId, let reaction) where id == sessionId:
            if var message = transcript.message(messageId) { message.reaction = reaction; receive(message) }
        case .status(let id, let messageId, let status) where id == sessionId:
            if var message = transcript.message(messageId) { message.status = status; receive(message) }
        case .cardSettled(let id, let card) where id == sessionId:
            transcript.settle(card)
        default: break
        }
    }

    func updateHeld(_ messages: [ChatMessage]) {
        let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let held = transcript.messages.map { byID[$0.id] ?? $0 }
        if held != transcript.messages { transcript.holdThreadMessages(held) }
    }

    /// A newest-page read can include the guardian's own send, which has no
    /// live insert. Only append beyond a shared message, never across a gap.
    func catchUp(_ messages: [ChatMessage]) {
        updateHeld(messages)
        guard !hasNewer, let last = transcript.messages.last(where: { !$0.isTrace }),
              let index = messages.firstIndex(where: { $0.id == last.id }) else { return }
        for message in messages.dropFirst(index + 1) { receive(message) }
    }
}

/// Window coordinates come from UIKit: each cell hosts an independent
/// SwiftUI tree, so a coordinate space outside the list cannot measure it.
@MainActor
final class TranscriptFocusPosition {
    var frame: (String) -> CGRect? = { _ in nil }
}

private struct ThreadFocusModifier: ViewModifier {
    let store: TranscriptStore
    let tasks: TaskChatsStore
    let composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(store.threadFocus == nil ? 1 : 0)
            .allowsHitTesting(store.threadFocus == nil)
            .accessibilityHidden(store.threadFocus != nil)
            .overlay {
                if let focus = store.threadFocus {
                    ZStack(alignment: .topTrailing) {
                        Rectangle().fill(.ultraThinMaterial).overlay(Palette.bg.opacity(0.85))
                        TranscriptList(store: focus.transcript, composerFocused: composerFocused, alignTop: true, thread: focus, onBlankTap: { store.closeThread() }) { row, previous in
                            ConciergeRow(row: row, info: focus.transcript.info(for: row), store: store, tasks: tasks, quotesInteractive: false)
                                .equatable()
                                .padding(.top, TranscriptSpacing.top(row, after: previous))
                        }
                        .environment(\.threadFocusHitAreas, focus.hitAreas)
                    }
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: reduceMotion ? 0.15 : 0.25), value: store.threadFocus != nil)
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
        content.background { if let areas { ThreadFocusMarker(areas: areas) } }
    }
}

private struct ThreadFocusMarker: UIViewRepresentable {
    let areas: ThreadFocusHitAreas
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        areas.add(view)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
}

extension View {
    func threadFocusHitArea() -> some View { modifier(ThreadFocusHitArea()) }
}

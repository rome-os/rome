import Foundation
import Observation

/// One chat thread of a Concierge chat, open over it. Its live messages are
/// the chat's own, filtered by thread, so everything the chat receives (a
/// live insert, an answer a reload brings, a placement) shows here as well.
/// The `?thread=` read only adds older messages of the thread that the
/// chat's pages do not hold yet; it never replaces a message the chat has.
/// An instance without chat threads shows just the message it opened from.
@MainActor
@Observable
final class ThreadStore {
    /// The message the guardian opened the thread from.
    let anchor: ChatMessage
    /// The thread's first message, as the server names it; the anchor's own
    /// id while it is alone, so a reply placed under it is recognised.
    private(set) var root: String
    /// Messages of the thread the chat does not hold, from the read.
    private(set) var older: [ChatMessage]
    private(set) var loaded = false

    @ObservationIgnored private weak var chat: TranscriptStore?
    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private var tokens: [UUID] = []
    @ObservationIgnored private var loads = 0

    init(anchor: ChatMessage, chat: TranscriptStore, backend: RomeBackend, older: [ChatMessage] = []) {
        self.anchor = anchor
        self.chat = chat
        self.backend = backend
        root = older.first?.chatThreadId ?? anchor.threadRoot
        self.older = older
    }

    /// The thread's messages, oldest first: the chat's own copies, then any
    /// older ones the read brought.
    var messages: [ChatMessage] {
        let held = chat?.messages(inThread: root) ?? []
        let heldIDs = Set(held.map(\.id))
        let anchorCopy = chat?.message(anchor.id) ?? anchor
        let extra = (older + [anchorCopy]).filter { !heldIDs.contains($0.id) }
        let all = Self.ordered(held + extra)
        // A message sent again shows once, as in the chat.
        let hidden = TranscriptBuilder.resent(in: all).union(chat.map { Array($0.replaced.values) } ?? [])
        return hidden.isEmpty ? all : all.filter { !hidden.contains($0.id) }
    }

    /// The title of the task the thread is, as its messages carry it.
    var title: String? {
        (chat?.message(anchor.id) ?? anchor).chatThreadTitle
            ?? messages.lazy.compactMap(\.chatThreadTitle).first
    }

    private var knowsThreads: Bool { (chat?.instanceKnowsThreads ?? false) || anchor.knowsThreads }

    var sessionId: String { anchor.sessionId }

    func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.chat(sessionId)) { [weak self] event in
            self?.handle(event)
        })
        Task { await load() }
    }

    func stop() {
        for token in tokens { backend.events.unsubscribe(token) }
        tokens = []
    }

    /// Reads the whole thread when the instance has chat threads, for the
    /// messages older than the chat's pages. A failed read keeps what is shown.
    func load() async {
        guard knowsThreads else {
            loaded = true
            return
        }
        loads += 1
        let mine = loads
        do {
            let thread = try await backend.thread(sessionId: sessionId, messageId: anchor.id)
            guard mine == loads else { return }
            if let first = thread.first?.chatThreadId { root = first }
            older = thread
        } catch {
            // The thread stays as it is shown.
        }
        loaded = true
    }

    func handle(_ event: LiveEvent) {
        switch event {
        case .messageThread(let id, let messageId, let thread, _) where id == sessionId:
            if thread == root {
                // Placed here, and neither the chat nor the read holds it: read again.
                if chat?.message(messageId) == nil, !older.contains(where: { $0.id == messageId }) {
                    Task { await load() }
                }
            } else if messageId != anchor.id {
                // Moved to another thread: it leaves this one.
                older.removeAll { $0.id == messageId }
            }
        case .reconnected:
            Task { await load() }
        default:
            break
        }
    }

    /// Puts a settled card in place in the messages the read brought.
    func settle(_ card: JSONValue) {
        for index in older.indices {
            if let content = TaskAskCard.settling(content: older[index].content, with: card) {
                older[index].content = content
            }
        }
    }

    /// Oldest first; messages written in the same second keep the order they came in.
    static func ordered(_ messages: [ChatMessage]) -> [ChatMessage] {
        var seen = Set<String>()
        let unique = messages.filter { !$0.isTrace && seen.insert($0.id).inserted }
        return unique.enumerated()
            .sorted { $0.element.date != $1.element.date ? $0.element.date < $1.element.date : $0.offset < $1.offset }
            .map(\.element)
    }

    /// The rows the thread shows: the chat's bubbles and cards, without
    /// thread labels. Answers come from the chat and from the thread's own
    /// older messages, so a card answered before the chat's pages shows done.
    func rows(answers: [String: JSONValue]) -> [TranscriptRow] {
        var all = TranscriptBuilder.answers(in: older)
        all.merge(answers) { _, chat in chat }
        return TranscriptBuilder.rows(messages: messages, pending: [], answers: all, options: .init())
    }
}

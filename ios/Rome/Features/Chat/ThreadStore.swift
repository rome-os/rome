import Foundation
import Observation

/// One chat thread of a Concierge chat, open over it: its messages, oldest
/// first, kept live. An instance without chat threads, or a message that is
/// alone, shows just that message.
@MainActor
@Observable
final class ThreadStore {
    /// The message the guardian opened the thread from.
    let anchor: ChatMessage
    private(set) var messages: [ChatMessage]
    /// The thread's first message, as the server names it; the anchor's own
    /// id while it is alone, so a reply placed under it is recognised.
    private(set) var root: String
    private(set) var loaded = false

    @ObservationIgnored private weak var chat: TranscriptStore?
    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private var tokens: [UUID] = []
    @ObservationIgnored private var loads = 0

    init(anchor: ChatMessage, chat: TranscriptStore, backend: RomeBackend) {
        self.anchor = anchor
        self.chat = chat
        self.backend = backend
        root = anchor.threadRoot
        // What the chat holds already shows at once; the read fills the rest.
        messages = Self.ordered(chat.messages(inThread: anchor.threadRoot) + [anchor])
    }

    /// Where a send from this thread goes.
    var target: ThreadTarget { ThreadTarget(messageId: anchor.id, instanceKnowsThreads: anchor.knowsThreads) }

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

    /// Reads the whole thread when the instance has chat threads. An older
    /// instance, or a failed read, keeps what the chat holds.
    func load() async {
        guard anchor.knowsThreads else {
            loaded = true
            return
        }
        loads += 1
        let mine = loads
        do {
            let thread = try await backend.thread(sessionId: sessionId, messageId: anchor.id)
            guard mine == loads else { return }
            if let first = thread.first?.chatThreadId { root = first }
            messages = Self.ordered(thread.isEmpty ? [anchor] : thread)
        } catch {
            // The thread stays as the chat holds it.
        }
        loaded = true
    }

    func handle(_ event: LiveEvent) {
        switch event {
        case .messageInsert(let message) where message.sessionId == sessionId:
            if message.chatThreadId == root || messages.contains(where: { $0.id == message.id }) {
                merge(message)
            }
        case .messageThread(let id, let messageId, let thread) where id == sessionId:
            let held = messages.contains { $0.id == messageId }
            if thread == root, !held {
                // Placed here: the event names it, the read brings it.
                Task { await load() }
            } else if held, thread != root, messageId != anchor.id {
                messages.removeAll { $0.id == messageId }
            }
        case .reconnected:
            Task { await load() }
        default:
            break
        }
    }

    private func merge(_ message: ChatMessage) {
        var all = messages.filter { $0.id != message.id }
        all.append(message)
        messages = Self.ordered(all)
    }

    /// Oldest first; messages written in the same second keep the order they came in.
    static func ordered(_ messages: [ChatMessage]) -> [ChatMessage] {
        var seen = Set<String>()
        let unique = messages.filter { !$0.isTrace && seen.insert($0.id).inserted }
        return unique.enumerated()
            .sorted { $0.element.date != $1.element.date ? $0.element.date < $1.element.date : $0.offset < $1.offset }
            .map(\.element)
    }

    /// The rows the thread shows: the chat's bubbles and cards, without replies counts.
    func rows(answers: [String: JSONValue]) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: answers, options: .init())
    }
}

import Foundation
import Observation

/// The guardian's Concierge topic chats, for the drawer. It refetches when the
/// drawer opens, after a chat is started here, when events may have been
/// missed, and when a chat it does not hold starts a turn. Names follow each
/// chat's `session_name` events, so an untitled chat shows its name once the
/// server picks one.
@MainActor
@Observable
final class TopicChatsStore {
    private let backend: RomeBackend
    private(set) var chats: [ConciergeChat] = []
    private(set) var loaded = false
    private var statusToken: UUID?
    private var chatTokens: [String: UUID] = [:]
    private var refreshWork: Task<Void, Never>?
    private var refreshAgain = false

    init(backend: RomeBackend) {
        self.backend = backend
    }

    func start() {
        guard statusToken == nil else { return }
        statusToken = backend.events.subscribe(LiveTopic.chatStatus) { [weak self] event in
            self?.handle(event)
        }
        refresh()
    }

    func stop() {
        if let statusToken { backend.events.unsubscribe(statusToken) }
        statusToken = nil
        for token in chatTokens.values { backend.events.unsubscribe(token) }
        chatTokens = [:]
    }

    /// Refetches the list. Requests that come while one runs share one more.
    func refresh() {
        guard refreshWork == nil else {
            refreshAgain = true
            return
        }
        refreshWork = Task {
            await Task.yield()
            repeat {
                refreshAgain = false
                // Off or unreachable: keep what is held.
                if let all = try? await backend.conciergeChats() {
                    mainChatId = all.first { $0.main }?.id
                    apply(Self.topics(in: all))
                }
            } while refreshAgain
            refreshWork = nil
        }
    }

    /// A chat this app just started: listed now, ahead of the next refetch.
    func add(_ chat: ConciergeChat) {
        guard !chat.main, !chats.contains(where: { $0.id == chat.id }) else { return }
        apply(chats + [chat])
        refresh()
    }

    /// A rename this app made: shown now, ahead of its `session_name` event.
    func rename(_ id: String, to name: String) {
        if let index = chats.firstIndex(where: { $0.id == id }) { chats[index].name = name }
    }

    /// An archived chat leaves the list.
    func remove(_ id: String) {
        apply(chats.filter { $0.id != id })
    }

    func chat(_ id: String) -> ConciergeChat? {
        chats.first { $0.id == id }
    }

    /// What a topic chat is called in the drawer and its header.
    static func title(_ chat: ConciergeChat?) -> String {
        guard let name = chat?.name.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return String(localized: "New chat")
        }
        return name
    }

    /// The topic chats of a `GET /concierge/chats` list, in its order.
    nonisolated static func topics(in all: [ConciergeChat]) -> [ConciergeChat] {
        all.filter { !$0.main && $0.id != conciergeChatID }
    }

    /// This person's main chat on the server: a visitor's is not `concierge`.
    private var mainChatId: String?

    /// The server holds 32 subscriptions per socket. The drawer hears renames
    /// live only for the newest chats, the ones still getting their names,
    /// which leaves room for the chat status, the task list, the main chat
    /// and the chat on screen; older ones pick up a new name when the list is
    /// read again.
    nonisolated static let liveNameLimit = 20

    /// The chats whose renames the drawer hears live: the list is oldest first.
    nonisolated static func liveIDs(_ list: [ConciergeChat]) -> Set<String> {
        Set(list.suffix(liveNameLimit).map(\.id))
    }

    private func apply(_ list: [ConciergeChat]) {
        chats = list
        loaded = true
        let ids = Self.liveIDs(list)
        for (id, token) in chatTokens where !ids.contains(id) {
            backend.events.unsubscribe(token)
            chatTokens[id] = nil
        }
        for id in ids where chatTokens[id] == nil {
            chatTokens[id] = backend.events.subscribe(LiveTopic.chat(id)) { [weak self] event in
                self?.handle(event)
            }
        }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .sessionName(let id, let name):
            if let index = chats.firstIndex(where: { $0.id == id }) { chats[index].name = name }
        case .sessionRunning(let id, let running):
            // A turn starting in a chat this list does not hold may be a new
            // topic chat; a turn ending in one it holds changes the unread count.
            let held = chat(id) != nil
            let main = id == conciergeChatID || id == mainChatId
            if (running && !held && !main) || (!running && held) { refresh() }
        case .reconnected:
            refresh()
        default:
            break
        }
    }
}

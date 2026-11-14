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
    private var activityToken: UUID?
    /// What the Concierge is doing in each chat, the main chat included, by
    /// chat id. A chat missing here shows no status line.
    private(set) var activities: [String: ConciergeActivity] = [:]
    /// The newest event per chat: its server time, to drop one that arrives
    /// out of order, and when it arrived, so a list fetched before it does
    /// not undo it.
    private var activityAt: [String: Double] = [:]
    private var activityHeard: [String: Date] = [:]
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
        // The server answers a subscription with each chat's current state.
        activityToken = backend.events.subscribe(LiveTopic.conciergeActivity) { [weak self] event in
            if case .conciergeActivity(let chatId, let activity, let at) = event { self?.heardActivity(activity, for: chatId, at: at) }
        }
        refresh()
    }

    func stop() {
        if let statusToken { backend.events.unsubscribe(statusToken) }
        statusToken = nil
        if let activityToken { backend.events.unsubscribe(activityToken) }
        activityToken = nil
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
                let asked = Date.now
                // Off or unreachable: keep what is held.
                if let all = try? await backend.conciergeChats() {
                    mainChatId = all.first { $0.main }?.id
                    // A chat whose event came after the list was asked for keeps the event.
                    for chat in all where chat.activity != nil && (activityHeard[chat.id] ?? .distantPast) < asked {
                        setActivity(chat.activity, for: chat.id)
                    }
                    apply(Self.topics(in: all))
                }
            } while refreshAgain
            refreshWork = nil
        }
    }

    /// The chat was read: its badge clears now, not at the next refetch. A
    /// pinned drawer (iPad) shows the list beside the chat being read.
    func markRead(_ chatId: String) {
        guard let index = chats.firstIndex(where: { $0.id == chatId }), (chats[index].unread ?? 0) > 0 else { return }
        chats[index].unread = 0
    }

    /// What the Concierge is doing in a chat; nil when it shows no status line.
    func activity(for chatId: String?) -> ConciergeActivity? {
        guard let chatId, let activity = activities[chatId], activity != .idle else { return nil }
        return activity
    }

    func setActivity(_ activity: ConciergeActivity?, for chatId: String) {
        if activities[chatId] != activity { activities[chatId] = activity }
    }

    /// A live event: applied unless an event the server stamped later is held already.
    func heardActivity(_ activity: ConciergeActivity?, for chatId: String, at: Double?) {
        if let at {
            if let held = activityAt[chatId], at < held { return }
            activityAt[chatId] = at
        }
        activityHeard[chatId] = .now
        setActivity(activity, for: chatId)
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

    /// The composer's placeholder in a topic chat: "Message in <name>" once
    /// the chat has a name, as on the web. A chat with no name yet keeps
    /// "Message", and a reply to a message reads "Reply".
    static func composerPlaceholder(_ chat: ConciergeChat?, replying: Bool) -> String {
        if replying { return String(localized: "Reply") }
        guard let name = chat?.name.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return String(localized: "Message")
        }
        return String(localized: "Message in \(name)")
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

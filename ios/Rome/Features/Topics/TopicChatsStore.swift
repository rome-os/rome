import Foundation
import Observation

/// The guardian's Concierge topic chats, for the drawer: the pinned ones
/// first, the latest pinned on top, then the rest, latest activity first.
/// It refetches when the drawer opens, after a chat is started here,
/// when events may have been missed, and when a turn starts or ends in a
/// topic chat. Names follow each chat's
/// `session_name` events, so an untitled chat shows its name once the server
/// picks one.
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
    /// Each chat's last activity, from the chat list (`GET /chat/sessions`).
    /// Only the server's time moves a chat, so a replayed status never does.
    /// A chat missing here counts as newest.
    private(set) var lastActive: [String: Date] = [:]
    /// When each pinned chat was pinned, from the same chat list. A chat
    /// missing here is not pinned.
    private(set) var pinnedAt: [String: Date] = [:]
    /// The chat whose pin just changed, for the second its row takes to
    /// slide to its new place: the drawer draws it above the rows it passes.
    private(set) var moving: String?
    @ObservationIgnored private var movingWork: Task<Void, Never>?
    private var refreshWork: Task<Void, Never>?
    private var refreshAgain = false
    /// Whether the drawer folds the list away, kept on this phone per instance.
    private(set) var folded: Bool
    private(set) var olderExpanded: Bool
    private(set) var archivedExpanded: Bool
    /// The open chat, if it was outside Older when it opened: it stays
    /// there while it is open, even once it is read.
    private(set) var heldCurrent: String?
    /// The chat `heldCurrent` was decided for.
    @ObservationIgnored private var heldFor: String?
    @ObservationIgnored private let fold: TopicChatsFold?

    /// Without a `fold`, the folded state lasts only as long as the store.
    init(backend: RomeBackend, fold: TopicChatsFold? = nil) {
        self.backend = backend
        self.fold = fold
        folded = fold?.load() ?? false
        olderExpanded = fold?.loadOlderExpanded() ?? false
        archivedExpanded = fold?.loadArchivedExpanded() ?? false
    }

    func setFolded(_ folded: Bool) {
        self.folded = folded
        fold?.save(folded)
    }

    func setOlderExpanded(_ expanded: Bool) {
        olderExpanded = expanded
        fold?.saveOlderExpanded(expanded)
    }

    func setArchivedExpanded(_ expanded: Bool) {
        archivedExpanded = expanded
        fold?.saveArchivedExpanded(expanded)
    }

    /// The drawer's open chat, or none. Its group is decided once, when it
    /// is first found in the list: a chat outside Older then stays outside
    /// while it is open, so reading it never drops it into Older under the
    /// guardian's finger. An older chat stays in Older.
    func noteOpen(_ id: String?, now: Date = .now) {
        guard id != heldFor else { return }
        guard let id, let chat = chat(id) else {
            heldFor = nil
            if heldCurrent != nil { heldCurrent = nil }
            return
        }
        heldFor = id
        let older = Self.isOlder(chat, lastActive: lastActive, pinnedAt: pinnedAt, now: now)
        let held = older ? nil : id
        if heldCurrent != held { heldCurrent = held }
    }

    /// Replies waiting unread across every topic chat, for the folded header.
    var unreadCount: Int {
        chats.reduce(0) { $0 + max($1.unread ?? 0, 0) }
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
                async let listed = try? backend.sessions()
                // Off or unreachable: keep what is held.
                let all = try? await backend.conciergeChats()
                if let sessions = await listed {
                    var pins: [String: Date] = [:]
                    for session in sessions {
                        if let at = RomeDate.parse(session.activityAt) { lastActive[session.id] = at }
                        if let at = session.pinnedAt.flatMap(RomeDate.parse) { pins[session.id] = at }
                    }
                    pinnedAt = pins
                }
                if let all {
                    mainChatId = all.first { $0.main }?.id
                    // A chat whose event came after the list was asked for keeps the event.
                    for chat in all where chat.activity != nil && (activityHeard[chat.id] ?? .distantPast) < asked {
                        setActivity(chat.activity, for: chat.id)
                    }
                    apply(Self.ordered(Self.topics(in: all), lastActive: lastActive, pinnedAt: pinnedAt))
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
        apply([chat] + chats)
        refresh()
    }

    /// Whether the chat is pinned atop the list.
    func isPinned(_ id: String) -> Bool {
        pinnedAt[id] != nil
    }

    /// A pin this app made or took off: the list moves now, and is read
    /// again once the row has settled, for the server's time.
    func setPinned(_ id: String, _ pinned: Bool) {
        pinnedAt[id] = pinned ? .now : nil
        moving = id
        apply(chats)
        movingWork?.cancel()
        // The server's list is read once the row has settled: a list that
        // lands while the row slides would redraw the rows under it.
        movingWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.moving = nil
            self.refresh()
        }
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
    /// "Message".
    static func composerPlaceholder(_ chat: ConciergeChat?) -> String {
        composerName(chat).map(messageIn) ?? String(localized: "Message")
    }

    /// The name the composer's placeholder shows: nil for a chat with no name yet.
    static func composerName(_ chat: ConciergeChat?) -> String? {
        guard let name = chat?.name.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }

    nonisolated static func messageIn(_ name: String) -> String {
        String(localized: "Message in \(name)")
    }

    /// The topic chats as the web lists them: the pinned ones first, the
    /// latest pinned on top, then the rest, latest activity first. The
    /// Concierge lists them oldest first; walking it backwards leaves the
    /// newest first among those with no time yet, which count as newest.
    nonisolated static func ordered(_ oldestFirst: [ConciergeChat], lastActive: [String: Date], pinnedAt: [String: Date] = [:]) -> [ConciergeChat] {
        resorted(oldestFirst.reversed(), lastActive: lastActive, pinnedAt: pinnedAt)
    }

    /// A list already in order, sorted again after a time or a pin changed;
    /// chats with the same times keep their places.
    nonisolated static func resorted(_ list: [ConciergeChat], lastActive: [String: Date], pinnedAt: [String: Date] = [:]) -> [ConciergeChat] {
        let pins = list.map { pinnedAt[$0.id] ?? Date.distantPast }
        let times = list.map { lastActive[$0.id] ?? Date.distantFuture }
        let order = list.indices.sorted { a, b in
            if pins[a] != pins[b] { return pins[a] > pins[b] }
            return times[a] != times[b] ? times[a] > times[b] : a < b
        }
        return order.map { list[$0] }
    }

    /// How many topic chats the drawer shows at first, and how many more each
    /// scroll near the end adds, as on the web.
    nonisolated static let pageSize = 30

    /// A group's page, including an open row beyond its end.
    nonisolated static func shownCount(_ count: Int, limit: Int, openIndex: Int?) -> Int {
        min(count, max(limit, (openIndex ?? -1) + 1))
    }

    /// Whether a chat belongs in Older: no new message for seven days, not
    /// pinned and nothing unread. An unknown activity time stays outside.
    nonisolated static func isOlder(_ chat: ConciergeChat, lastActive: [String: Date], pinnedAt: [String: Date], now: Date = .now) -> Bool {
        let cutoff = now.addingTimeInterval(-7 * 24 * 60 * 60)
        guard let at = lastActive[chat.id] else { return false }
        return at <= cutoff && pinnedAt[chat.id] == nil && (chat.unread ?? 0) == 0
    }

    /// Preserves the drawer's order. The open chat stays in its group, with
    /// only its selected state: `held` is a chat kept outside Older
    /// (`noteOpen`).
    nonisolated static func groups(_ chats: [ConciergeChat], lastActive: [String: Date], pinnedAt: [String: Date], held: String? = nil, now: Date = .now) -> (current: [ConciergeChat], older: [ConciergeChat]) {
        var current: [ConciergeChat] = []
        var older: [ConciergeChat] = []
        for chat in chats {
            if chat.id != held && isOlder(chat, lastActive: lastActive, pinnedAt: pinnedAt, now: now) {
                older.append(chat)
            } else {
                current.append(chat)
            }
        }
        return (current, older)
    }

    /// Exceptions past the page stay visible without revealing the intervening rows.
    nonisolated static func page(_ chats: [ConciergeChat], limit: Int, pinnedAt: [String: Date], openId: String?) -> [ConciergeChat] {
        chats.enumerated().compactMap { index, chat in
            index < limit || pinnedAt[chat.id] != nil || (chat.unread ?? 0) > 0 || chat.id == openId ? chat : nil
        }
    }

    /// The rows a folded list keeps: only the open chat, so it stays
    /// reachable, whichever group it is in.
    nonisolated static func foldedRows(_ chats: [ConciergeChat], openId: String?) -> [ConciergeChat] {
        chats.filter { $0.id == openId }
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

    /// The chats whose renames the drawer hears live: the first ones of the list.
    nonisolated static func liveIDs(_ list: [ConciergeChat]) -> Set<String> {
        Set(list.prefix(liveNameLimit).map(\.id))
    }

    /// Takes a list in the drawer's order, or close to it.
    private func apply(_ list: [ConciergeChat]) {
        let list = Self.resorted(list, lastActive: lastActive, pinnedAt: pinnedAt)
        if list != chats { chats = list }
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
            // A turn starting may be in a new topic chat, or moves one up; a
            // turn ending changes its unread count. The refetch brings the
            // server's activity time, so a status replayed on a reconnect or
            // a resync, with nothing new, leaves the order as it is.
            let held = chat(id) != nil
            let main = id == conciergeChatID || id == mainChatId
            if (running && !main) || (!running && held) { refresh() }
        case .reconnected:
            refresh()
        default:
            break
        }
    }
}

/// The topic list, Older and Archived choices, per instance. The whole
/// list starts open, and Older and Archived start closed.
struct TopicChatsFold {
    static let prefix = "topicChatsFolded."
    private static let olderPrefix = "olderTopicChatsExpanded."
    private static let archivedPrefix = "archivedTopicChatsExpanded."

    let host: String
    var defaults: UserDefaults = .standard

    private var key: String { Self.prefix + host }

    func load() -> Bool { defaults.bool(forKey: key) }

    func save(_ folded: Bool) {
        if folded { defaults.set(true, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    func loadOlderExpanded() -> Bool { defaults.bool(forKey: Self.olderPrefix + host) }

    func saveOlderExpanded(_ expanded: Bool) {
        if expanded { defaults.set(true, forKey: Self.olderPrefix + host) }
        else { defaults.removeObject(forKey: Self.olderPrefix + host) }
    }

    func loadArchivedExpanded() -> Bool { defaults.bool(forKey: Self.archivedPrefix + host) }

    func saveArchivedExpanded(_ expanded: Bool) {
        if expanded { defaults.set(true, forKey: Self.archivedPrefix + host) }
        else { defaults.removeObject(forKey: Self.archivedPrefix + host) }
    }

    /// Sign-out, or another account: every instance's choice.
    static func removeAll(defaults: UserDefaults = .standard) {
        defaults.removeKeys(prefix: prefix)
        defaults.removeKeys(prefix: olderPrefix)
        defaults.removeKeys(prefix: archivedPrefix)
    }
}

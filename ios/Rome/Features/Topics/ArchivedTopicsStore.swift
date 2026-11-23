import Foundation
import Observation

/// The guardian's archived topic chats, for the drawer's Archived button
/// and the sheet it opens: latest activity first. It reads the list when the
/// workspace starts, when the drawer or the sheet opens, and after a chat is
/// archived here; a restore or a delete here takes the chat out at once.
@MainActor
@Observable
final class ArchivedTopicsStore {
    private let backend: RomeBackend
    private(set) var chats: [ConciergeChat] = []
    /// Each chat's last activity, from the list (`activityAt`). A chat
    /// missing here has none known.
    private(set) var lastActive: [String: Date] = [:]
    private(set) var loaded = false
    private var refreshWork: Task<Void, Never>?
    private var refreshAgain = false
    /// Chats restored or deleted here, and when: a list asked for before
    /// that would bring them back. A list asked for after it drops the
    /// entry, so a chat archived again elsewhere shows again.
    @ObservationIgnored private var gone: [String: Date] = [:]

    init(backend: RomeBackend) {
        self.backend = backend
    }

    /// How many archived topic chats there are.
    var count: Int { chats.count }

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
                // Unreachable, or an instance without the Concierge: keep what is held.
                if let sessions = try? await backend.archivedTopicChats() {
                    gone = Self.pending(gone, askedAt: asked)
                    let listed = Self.ordered(sessions).filter { gone[$0.id] == nil }
                    if listed != chats { chats = listed }
                    let times = Self.activity(sessions)
                    if times != lastActive { lastActive = times }
                    loaded = true
                }
            } while refreshAgain
            refreshWork = nil
        }
    }

    func chat(_ id: String) -> ConciergeChat? {
        chats.first { $0.id == id }
    }

    func contains(_ id: String) -> Bool {
        chats.contains { $0.id == id }
    }

    /// A chat archived here: listed first now, ahead of the refetch, with
    /// the last activity the drawer knew for it.
    func add(_ chat: ConciergeChat, lastActive at: Date? = nil) {
        gone[chat.id] = nil
        guard !contains(chat.id) else { return }
        chats.insert(chat, at: 0)
        if let at { lastActive[chat.id] = at }
        refresh()
    }

    /// An archived chat found elsewhere, such as a search hit: known from
    /// now on, so it opens read only, until the list is read again.
    /// Returns whether the chat is held as archived now. A hit read before
    /// the chat was unarchived or deleted here is not taken.
    @discardableResult
    func note(_ session: ChatSession) -> Bool {
        guard session.isArchivedTopicChat, gone[session.id] == nil else { return false }
        // Last: its place comes with the next read of the list.
        if !contains(session.id) { chats.append(ConciergeChat(id: session.id, name: session.name, main: false)) }
        return true
    }

    /// A rename this app made: shown now.
    func rename(_ id: String, to name: String) {
        if let index = chats.firstIndex(where: { $0.id == id }) { chats[index].name = name }
    }

    /// A chat restored or deleted here leaves the list.
    func remove(_ id: String) {
        gone[id] = .now
        chats.removeAll { $0.id == id }
    }

    /// The changes made here that a list asked for at `askedAt` may not
    /// know yet: those made at or after it. Older ones the list already reflects.
    nonisolated static func pending(_ gone: [String: Date], askedAt: Date) -> [String: Date] {
        gone.filter { $0.value >= askedAt }
    }

    /// The topic chats of the archived list, latest activity first; chats
    /// with no time keep the server's order, after the rest.
    nonisolated static func ordered(_ sessions: [ChatSession]) -> [ConciergeChat] {
        let times = sessions.map { $0.activityAt.flatMap(RomeDate.parse) ?? .distantPast }
        let order = sessions.indices.sorted { a, b in times[a] != times[b] ? times[a] > times[b] : a < b }
        return order.map { ConciergeChat(id: sessions[$0].id, name: sessions[$0].name, main: false) }
    }

    /// Each listed chat's last activity, where the list gives one.
    nonisolated static func activity(_ sessions: [ChatSession]) -> [String: Date] {
        var times: [String: Date] = [:]
        for session in sessions {
            if let at = session.activityAt.flatMap(RomeDate.parse) { times[session.id] = at }
        }
        return times
    }

    /// The sheet's groups, in the list's order: this week, earlier this
    /// month, then one per month, newest first. Chats with no activity
    /// known come last, in a group of their own.
    nonisolated static func groups(_ chats: [ConciergeChat], lastActive: [String: Date], now: Date = .now, calendar: Calendar = .current) -> [ArchivedTopicGroup] {
        var groups: [ArchivedTopicGroup] = []
        for chat in chats {
            let period = ArchivedTopicGroup.Period(lastActive[chat.id], now: now, calendar: calendar)
            if let index = groups.firstIndex(where: { $0.period == period }) {
                groups[index].chats.append(chat)
            } else {
                groups.append(ArchivedTopicGroup(period: period, chats: [chat]))
            }
        }
        return groups.sorted { $0.period < $1.period }
    }
}

/// One group of the Archived sheet: the chats last active in one period.
struct ArchivedTopicGroup: Identifiable, Equatable, Sendable {
    enum Period: Hashable, Comparable, Sendable {
        case thisWeek
        case earlierThisMonth
        /// A month before this one, as its first day.
        case month(Date)
        case undated

        /// Where a chat last active at `date` goes. A time ahead of `now`, a
        /// clock off on either side, counts as this week.
        init(_ date: Date?, now: Date, calendar: Calendar) {
            guard let date else {
                self = .undated
                return
            }
            if date >= now || calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) {
                self = .thisWeek
            } else if calendar.isDate(date, equalTo: now, toGranularity: .month) {
                self = .earlierThisMonth
            } else {
                self = .month(calendar.dateInterval(of: .month, for: date)?.start ?? date)
            }
        }

        /// Newest first.
        static func < (a: Period, b: Period) -> Bool {
            switch (a, b) {
            case (.month(let x), .month(let y)): return x > y
            default: return a.rank < b.rank
            }
        }

        private var rank: Int {
            switch self {
            case .thisWeek: 0
            case .earlierThisMonth: 1
            case .month: 2
            case .undated: 3
            }
        }
    }

    let period: Period
    var chats: [ConciergeChat]

    var id: Period { period }
}

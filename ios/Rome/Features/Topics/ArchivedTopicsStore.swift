import Foundation
import Observation

/// The guardian's archived topic chats, for the drawer's "Archived · N" row
/// and the sheet it opens: latest activity first. It reads the list when the
/// workspace starts, when the drawer or the sheet opens, and after a chat is
/// archived here; a restore or a delete here takes the chat out at once.
@MainActor
@Observable
final class ArchivedTopicsStore {
    private let backend: RomeBackend
    private(set) var chats: [ConciergeChat] = []
    private(set) var loaded = false
    private var refreshWork: Task<Void, Never>?
    private var refreshAgain = false
    /// Chats restored or deleted here: a list asked for before the server
    /// took the change would bring them back.
    @ObservationIgnored private var gone: Set<String> = []

    init(backend: RomeBackend) {
        self.backend = backend
    }

    /// How many archived topic chats there are.
    var count: Int { chats.count }

    /// Whether the drawer shows its Archived row: some are archived, the
    /// topic chats are not folded, and every one of them shows, so the row
    /// is their last.
    nonisolated static func showsEntry(archived: Int, folded: Bool, shownTopics: Int, topics: Int) -> Bool {
        archived > 0 && !folded && shownTopics >= topics
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
                // Unreachable, or an instance without the Concierge: keep what is held.
                if let sessions = try? await backend.archivedTopicChats() {
                    let listed = Self.ordered(sessions).filter { !gone.contains($0.id) }
                    if listed != chats { chats = listed }
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

    /// A chat archived here: listed first now, ahead of the refetch.
    func add(_ chat: ConciergeChat) {
        gone.remove(chat.id)
        guard !contains(chat.id) else { return }
        chats.insert(chat, at: 0)
        refresh()
    }

    /// An archived chat found elsewhere, such as a search hit: known from
    /// now on, so it opens read only, until the list is read again.
    func note(_ session: ChatSession) {
        guard session.isArchivedTopicChat, !contains(session.id), !gone.contains(session.id) else { return }
        // Last: its place comes with the next read of the list.
        chats.append(ConciergeChat(id: session.id, name: session.name, main: false))
    }

    /// A rename this app made: shown now.
    func rename(_ id: String, to name: String) {
        if let index = chats.firstIndex(where: { $0.id == id }) { chats[index].name = name }
    }

    /// A chat restored or deleted here leaves the list.
    func remove(_ id: String) {
        gone.insert(id)
        chats.removeAll { $0.id == id }
    }

    /// The topic chats of the archived list, latest activity first; chats
    /// with no time keep the server's order, after the rest.
    nonisolated static func ordered(_ sessions: [ChatSession]) -> [ConciergeChat] {
        let times = sessions.map { $0.activityAt.flatMap(RomeDate.parse) ?? .distantPast }
        let order = sessions.indices.sorted { a, b in times[a] != times[b] ? times[a] > times[b] : a < b }
        return order.map { ConciergeChat(id: sessions[$0].id, name: sessions[$0].name, main: false) }
    }
}

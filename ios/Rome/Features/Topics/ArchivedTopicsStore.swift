import Foundation
import Observation

/// The guardian's archived topic chats, for the drawer's Archived group:
/// the latest archived first. It reads the list when the workspace starts,
/// when the drawer opens, and after a chat is archived here; a restore or a
/// delete here takes the chat out at once.
@MainActor
@Observable
final class ArchivedTopicsStore {
    private let backend: RomeBackend
    private(set) var chats: [ConciergeChat] = []
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
        gone[chat.id] = nil
        guard !contains(chat.id) else { return }
        chats.insert(chat, at: 0)
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

    /// The topic chats of the archived list, the latest archived first;
    /// chats archived at the same time, or with no time, keep the server's
    /// order, after the rest.
    nonisolated static func ordered(_ sessions: [ChatSession]) -> [ConciergeChat] {
        let times = sessions.map { $0.archivedAt.flatMap(RomeDate.parse) ?? .distantPast }
        let order = sessions.indices.sorted { a, b in times[a] != times[b] ? times[a] > times[b] : a < b }
        return order.map { ConciergeChat(id: sessions[$0].id, name: sessions[$0].name, main: false) }
    }
}

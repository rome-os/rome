import Foundation
import Observation

/// The task chats' statuses, from the chat list (`GET /chat/sessions`) and
/// `session_running` on the status stream. It feeds the task cards in a
/// Concierge chat and a task chat's title. The Concierge's task list is never
/// read here: a card's question or approval says itself whether it waits, and
/// every other task state is the Tasks tab's (`TaskListStore`).
@MainActor
@Observable
final class TaskChatsStore {
    private let backend: RomeBackend
    private(set) var chats: [String: ChatSession] = [:]
    private var tokens: [UUID] = []
    private var resyncWork: Task<Void, Never>?
    private var resyncAgain = false
    /// Task chats archived or deleted from this app. A refetch of a list that
    /// still holds them must not bring their cards back.
    private var goneChats: Set<String> = []

    init(backend: RomeBackend) {
        self.backend = backend
    }

    func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.chatStatus) { [weak self] event in
            self?.handle(event)
        })
        Task { await refresh() }
    }

    func stop() {
        for token in tokens { backend.events.unsubscribe(token) }
        tokens = []
    }

    func refresh() async {
        if let list = try? await backend.sessions() { setChats(list) }
    }

    /// Refreshes after events may have been missed. A burst of requests (one
    /// per topic and a resume) shares one refresh, plus one more for requests
    /// that came while it ran.
    func resync() {
        guard resyncWork == nil else {
            resyncAgain = true
            return
        }
        resyncWork = Task {
            await Task.yield()
            repeat {
                resyncAgain = false
                await refresh()
            } while resyncAgain
            resyncWork = nil
        }
    }

    /// Written only when it changes: every task card in a chat reads the
    /// store, and a write that changes nothing would still draw them all.
    private func setChats(_ list: [ChatSession]) {
        let byID = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if byID != chats { chats = byID }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .sessionRunning(let id, let running):
            if var chat = chats[id], chat.running != running {
                chat.running = running
                chats[id] = chat
            }
            // A turn that ends, or a task that ends with no turn, changes
            // whether the chat waits on the guardian: the list says it.
            if !running || chats[id] == nil { resync() }
        case .reconnected:
            resync()
        default:
            break
        }
    }

    /// A task chat archived or deleted here: its cards leave.
    func forget(chat chatId: String) {
        goneChats.insert(chatId)
    }

    /// Whether task chat `chatId` was archived or deleted here.
    func isGone(chat chatId: String) -> Bool { goneChats.contains(chatId) }

    // MARK: Task chat status

    /// Whether a task chat runs a turn now.
    func isRunning(chat chatId: String) -> Bool { chats[chatId]?.running == true }

    func title(forChat chatId: String, fallback: String) -> String {
        chats[chatId]?.name ?? fallback
    }

    /// What a task card says after "Task chat": Working while its chat runs,
    /// Needs you while it waits on the guardian, and nothing in any other
    /// state, as the web card does (`TaskChatCard.tsx`). Every other state is
    /// the Tasks tab's to show.
    func cardState(forChat chatId: String) -> TaskCardState {
        let chat = chats[chatId]
        if chat?.running == true { return TaskCardState(word: String(localized: "Working")) }
        if chat?.awaitingGuardian == true { return TaskCardState(word: String(localized: "Needs you")) }
        return TaskCardState(word: nil)
    }
}

/// How a task card reads: "Task chat · <word>", or "Task chat" alone.
struct TaskCardState: Equatable {
    var word: String?
}

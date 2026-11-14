import Foundation
import Observation

/// The Concierge's task list and the statuses of the chats it started. It feeds
/// the header badge and the task cards in the chat.
@MainActor
@Observable
final class TasksStore {
    private let backend: RomeBackend
    /// Written only when it changes: every task card in a chat reads the
    /// store, and a write that changes nothing would still draw them all.
    private(set) var tasks: [ConciergeTask] = [] { didSet { indexByChat() } }
    private(set) var chats: [String: ChatSession] = [:]
    /// The first task of each chat, and the first one not archived: what a
    /// card or a header looks up, without a scan of the list.
    private(set) var taskByChat: [String: ConciergeTask] = [:]
    private var openTaskByChat: [String: ConciergeTask] = [:]

    private func indexByChat() {
        var first: [String: ConciergeTask] = [:]
        var open: [String: ConciergeTask] = [:]
        for task in tasks {
            guard let chat = task.chat?.id else { continue }
            if first[chat] == nil { first[chat] = task }
            if open[chat] == nil, task.archivedAt == nil { open[chat] = task }
        }
        if first != taskByChat { taskByChat = first }
        if open != openTaskByChat { openTaskByChat = open }
    }
    private(set) var loaded = false
    /// The task list arrived at least once: a task missing from it is gone,
    /// not just unread yet.
    private(set) var listed = false
    private var tokens: [UUID] = []
    private var refreshingChats = false
    private var resyncWork: Task<Void, Never>?
    private var resyncAgain = false
    /// Task chats archived or deleted from this app. Their rows stay on the
    /// server, so a refetch would bring them back; they stay out of the list.
    private var goneChats: Set<String> = []

    init(backend: RomeBackend) {
        self.backend = backend
    }

    func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.conciergeTasks) { [weak self] event in
            self?.handle(event)
        })
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
        async let taskList = try? backend.tasks()
        async let sessionList = try? backend.sessions()
        if let list = await taskList {
            let kept = list.filter { !isGone($0) }
            if kept != tasks { tasks = kept }
            if !listed { listed = true }
        }
        if let list = await sessionList { setChats(list) }
        if !loaded { loaded = true }
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

    private func refreshChats() async {
        guard !refreshingChats else { return }
        refreshingChats = true
        defer { refreshingChats = false }
        if let list = try? await backend.sessions() { setChats(list) }
    }

    private func setChats(_ list: [ChatSession]) {
        let byID = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if byID != chats { chats = byID }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .taskUpsert(let task):
            apply(task)
        case .sessionRunning(let id, let running):
            if var chat = chats[id], chat.running != running {
                chat.running = running
                chats[id] = chat
            }
            // Stopping changes whether the chat waits on the guardian or failed.
            if !running || chats[id] == nil { Task { await refreshChats() } }
        case .reconnected:
            resync()
        default:
            break
        }
    }

    /// Applies one row write. An older write than the one held is ignored, and an
    /// archived row leaves the list.
    func apply(_ task: ConciergeTask) {
        if let held = tasks.first(where: { $0.id == task.id }), held.updatedAt > task.updatedAt { return }
        var next = tasks
        next.removeAll { $0.id == task.id }
        if task.archivedAt == nil, !isGone(task) { next.append(task) }
        if next != tasks { tasks = next }
    }

    /// A task chat archived or deleted here: its row and its cards leave.
    func forget(chat chatId: String) {
        goneChats.insert(chatId)
        if tasks.contains(where: { $0.chat?.id == chatId }) { tasks.removeAll { $0.chat?.id == chatId } }
    }

    /// Whether task chat `chatId` was archived or deleted here.
    func isGone(chat chatId: String) -> Bool { goneChats.contains(chatId) }

    private func isGone(_ task: ConciergeTask) -> Bool {
        task.chat.map { goneChats.contains($0.id) } ?? false
    }

    // MARK: Task chat status

    /// The status of a task chat, as its card and header show it.
    func tone(forChat chatId: String) -> TaskTone {
        if let task = openTaskByChat[chatId] {
            switch task.state {
            case .needsUser: return .needsYou
            case .doing: return chats[chatId]?.lastTurnFailed == true && chats[chatId]?.running != true ? .failed : .running
            case .done, .dropped: return .done
            case .next, .watching: break
            }
        }
        guard let chat = chats[chatId] else { return .neutral }
        if chat.running == true { return .running }
        if chat.awaitingGuardian == true { return .needsYou }
        if chat.lastTurnFailed == true { return .failed }
        return .done
    }

    func title(forChat chatId: String, fallback: String) -> String {
        chats[chatId]?.name ?? taskByChat[chatId]?.title ?? fallback
    }

    func task(forChat chatId: String) -> ConciergeTask? {
        taskByChat[chatId]
    }

    // MARK: Task cards

    /// Tasks being stopped from a card, by id.
    private(set) var stopping: Set<String> = []

    /// What a task card says: the word after "Task chat ·", and whether Stop
    /// shows. The task's own status when the list has it, else the chat's
    /// flags, as the web card does (`TaskChatCard.tsx`).
    func cardState(forChat chatId: String) -> TaskCardState {
        let session = chats[chatId]
        if let task = task(forChat: chatId) {
            let open = task.status != "ended"
            let word: String
            switch (task.status, task.endReason) {
            case ("ended", "failed"?): word = String(localized: "Didn't finish")
            case ("ended", "stopped"?): word = String(localized: "Stopped")
            case ("ended", "no_response"?): word = String(localized: "No response")
            case ("ended", _): word = String(localized: "Done")
            case ("needs_you", _): word = String(localized: "Needs you")
            case ("active", _): word = String(localized: "Working")
            case ("later", _): word = String(localized: "Later")
            default: word = Self.chatWord(session)
            }
            return TaskCardState(word: word, stoppable: task.status != nil && open, taskId: task.id)
        }
        // An archived task chat's task was stopped with it, and the list holds no row for it.
        if session?.archivedAt != nil { return TaskCardState(word: String(localized: "Stopped"), stoppable: false, taskId: nil) }
        return TaskCardState(word: Self.chatWord(session), stoppable: false, taskId: nil)
    }

    private static func chatWord(_ session: ChatSession?) -> String {
        if session?.running == true { return String(localized: "Working") }
        if session?.awaitingGuardian == true { return String(localized: "Needs you") }
        if session?.lastTurnFailed == true { return String(localized: "Stopped with an error") }
        return String(localized: "Done")
    }

    /// Stops the task of a card. The task's next row from the instance settles the card.
    /// `onFailure` runs when the instance did not take the stop.
    func stopTask(id: String, onFailure: @escaping () -> Void = {}) {
        guard !stopping.contains(id) else { return }
        stopping.insert(id)
        Task {
            do { try await backend.stopTask(id: id) } catch { onFailure() }
            stopping.remove(id)
        }
    }
}

/// How a task card reads: "Task chat · <word>", and Stop while the task is open.
struct TaskCardState: Equatable {
    var word: String
    var stoppable: Bool
    var taskId: String?
}

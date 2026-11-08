import Foundation
import Observation

/// The groups of the Tasks sheet, in the order it shows them. Progress is
/// not reported accurately enough to show finer states, so there are two.
enum TaskGroupKey: String, CaseIterable, Identifiable, Sendable {
    case inProgress, done

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inProgress: return String(localized: "In progress")
        case .done: return String(localized: "Done")
        }
    }

    static func of(_ state: TaskState) -> TaskGroupKey {
        switch state {
        case .needsUser, .doing, .next, .watching: return .inProgress
        case .done, .dropped: return .done
        }
    }
}

/// What a task row says about itself, beyond its title.
enum TaskRowStatus: Equatable, Sendable {
    /// Waiting on an approval or an answer from the guardian.
    case waiting
    /// Its chat's last turn failed and nothing runs now.
    case failed
    case plain
}

struct TaskGroup: Identifiable, Sendable {
    let key: TaskGroupKey
    let tasks: [ConciergeTask]
    let hidden: Int

    var id: String { key.rawValue }
}

/// The Concierge's task list and the statuses of the chats it started. It feeds
/// the header badge, the Tasks sheet, and the task cards in the chat.
@MainActor
@Observable
final class TasksStore {
    private let backend: RomeBackend
    private(set) var tasks: [ConciergeTask] = []
    private(set) var chats: [String: ChatSession] = [:]
    private(set) var loaded = false
    private var tokens: [UUID] = []
    private var refreshingChats = false
    private var resyncWork: Task<Void, Never>?
    private var resyncAgain = false

    init(backend: RomeBackend) {
        self.backend = backend
    }

    /// Whether a row came from Concierge chat `chatId`. A row from an older
    /// server names no chat; it belongs to the main one.
    nonisolated static func belongs(_ task: ConciergeTask, toChat chatId: String) -> Bool {
        let source = task.conciergeChat.map { $0.main ? conciergeChatID : $0.id } ?? conciergeChatID
        return source == chatId
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
        if let list = await taskList { tasks = list }
        if let list = await sessionList {
            chats = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
        loaded = true
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
        if let list = try? await backend.sessions() {
            chats = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .taskUpsert(let task):
            apply(task)
        case .sessionRunning(let id, let running):
            if var chat = chats[id] {
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
        tasks.removeAll { $0.id == task.id }
        if task.archivedAt == nil { tasks.append(task) }
    }

    /// The groups, in order, without empty ones. Finished rows older than seven
    /// days are counted in `hidden` unless `showAllDone`.
    func groups(inChat chatId: String, showAllDone: Bool, now: Date = .now) -> [TaskGroup] {
        TasksStore.group(tasks.filter { Self.belongs($0, toChat: chatId) }, showAllDone: showAllDone, now: now)
    }

    nonisolated static func group(_ tasks: [ConciergeTask], showAllDone: Bool, now: Date) -> [TaskGroup] {
        let since = now.timeIntervalSince1970 * 1000 - 7 * 86_400_000
        var byKey: [TaskGroupKey: [ConciergeTask]] = [:]
        for task in tasks where task.archivedAt == nil {
            byKey[TaskGroupKey.of(task.state), default: []].append(task)
        }
        return TaskGroupKey.allCases.compactMap { key in
            guard var list = byKey[key], !list.isEmpty else { return nil }
            list.sort(by: sorter(key))
            if key == .done, !showAllDone {
                let recent = list.filter { ($0.completedAt ?? $0.updatedAt) >= since }
                return TaskGroup(key: key, tasks: recent, hidden: list.count - recent.count)
            }
            return TaskGroup(key: key, tasks: list, hidden: 0)
        }
    }

    nonisolated private static func sorter(_ key: TaskGroupKey) -> (ConciergeTask, ConciergeTask) -> Bool {
        switch key {
        case .inProgress:
            // What waits on the guardian comes first, then the latest update.
            return { a, b in
                let waitingA = a.state == .needsUser, waitingB = b.state == .needsUser
                if waitingA != waitingB { return waitingA }
                return a.updatedAt > b.updatedAt
            }
        case .done:
            return { ($0.completedAt ?? $0.updatedAt) > ($1.completedAt ?? $1.updatedAt) }
        }
    }

    // MARK: Rows

    func rowStatus(_ task: ConciergeTask) -> TaskRowStatus {
        Self.rowStatus(task, chat: task.chat.flatMap { chats[$0.id] })
    }

    nonisolated static func rowStatus(_ task: ConciergeTask, chat: ChatSession?) -> TaskRowStatus {
        switch task.state {
        case .needsUser: return .waiting
        case .doing, .next, .watching:
            return chat?.lastTurnFailed == true && chat?.running != true ? .failed : .plain
        case .done, .dropped: return .plain
        }
    }

    /// The one muted line under a row's title: "Waiting on you", "Didn't
    /// finish", or when it last changed.
    nonisolated static func rowLine(_ task: ConciergeTask, status: TaskRowStatus, now: Date) -> String {
        switch status {
        case .waiting: return String(localized: "Waiting on you")
        case .failed: return String(localized: "Didn't finish")
        case .plain:
            let changed = TaskGroupKey.of(task.state) == .done ? (task.completedAt ?? task.updatedAt) : task.updatedAt
            return RomeDate.fromMillis(changed).map { RelativeTime.ago($0, now: now) } ?? ""
        }
    }

    // MARK: Task chat status

    /// The status of a task chat, as its card and header show it.
    func tone(forChat chatId: String) -> TaskTone {
        if let task = tasks.first(where: { $0.chat?.id == chatId && $0.archivedAt == nil }) {
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
        chats[chatId]?.name ?? tasks.first { $0.chat?.id == chatId }?.title ?? fallback
    }

    func task(forChat chatId: String) -> ConciergeTask? {
        tasks.first { $0.chat?.id == chatId }
    }
}

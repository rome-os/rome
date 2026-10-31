import Foundation
import Observation

/// The groups of the Tasks sheet, in the order it shows them.
enum TaskGroupKey: String, CaseIterable, Identifiable, Sendable {
    case needsYou, doing, next, watching, done

    var id: String { rawValue }

    var title: String {
        switch self {
        case .needsYou: return "等你处理"
        case .doing: return "进行中"
        case .next: return "接下来"
        case .watching: return "盯着"
        case .done: return "已完成"
        }
    }

    var tone: TaskTone {
        switch self {
        case .needsYou: return .needsYou
        case .doing: return .running
        case .next, .watching: return .neutral
        case .done: return .done
        }
    }

    static func of(_ state: TaskState) -> TaskGroupKey {
        switch state {
        case .needsUser: return .needsYou
        case .doing: return .doing
        case .next: return .next
        case .watching: return .watching
        case .done, .dropped: return .done
        }
    }
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

    init(backend: RomeBackend) {
        self.backend = backend
    }

    var needsYouCount: Int {
        tasks.filter { $0.state == .needsUser && $0.archivedAt == nil }.count
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
            Task { await refresh() }
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
    func groups(showAllDone: Bool, now: Date = .now) -> [TaskGroup] {
        TasksStore.group(tasks, showAllDone: showAllDone, now: now)
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
        func ascending(_ a: Double?, _ b: Double?) -> Bool? {
            switch (a, b) {
            case let (a?, b?) where a != b: return a < b
            case (nil, _?): return false
            case (_?, nil): return true
            default: return nil
            }
        }
        switch key {
        case .needsYou, .doing:
            return { $0.updatedAt > $1.updatedAt }
        case .next:
            return { ascending($0.rank, $1.rank) ?? ($0.createdAt < $1.createdAt) }
        case .watching:
            return { ascending($0.dueAt, $1.dueAt) ?? ($0.updatedAt > $1.updatedAt) }
        case .done:
            return { ($0.completedAt ?? $0.updatedAt) > ($1.completedAt ?? $1.updatedAt) }
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

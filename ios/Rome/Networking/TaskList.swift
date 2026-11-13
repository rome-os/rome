import Foundation

// A Concierge chat's task list, the Agent page's Tasks tab: everything that
// runs for the chat, grouped by the server (`GET /chats/:chatId/tasks`).
// docs/domains/chats.md#task-list

/// `GET /chats/:chatId/tasks`: the groups that have rows, in order.
/// Read leniently: a group or a row this build cannot read is left out and
/// logged, never the whole list.
struct TaskListResponse: Decodable, Hashable, Sendable {
    var chatId: String
    var groups: [TaskListGroup]

    private enum CodingKeys: String, CodingKey { case chatId, groups }

    init(chatId: String, groups: [TaskListGroup]) {
        self.chatId = chatId
        self.groups = groups
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = (try? c.decode(String.self, forKey: .chatId)) ?? ""
        groups = ((try? c.decode([Lenient<TaskListGroup>].self, forKey: .groups)) ?? []).compactMap(\.value)
    }
}

struct TaskListGroup: Decodable, Hashable, Sendable, Identifiable {
    enum Key: String, Decodable, Sendable, CaseIterable {
        case needsYou = "needs_you", active, later, onItsOwn = "on_its_own", ended

        /// The fixed order of the groups, Ended always last.
        var order: Int { Self.allCases.firstIndex(of: self) ?? 0 }
    }

    /// The groups in their fixed order, whatever order they came in.
    static func ordered(_ groups: [TaskListGroup]) -> [TaskListGroup] {
        groups.sorted { $0.key.order < $1.key.order }
    }

    var key: Key
    var items: [TaskListItem]

    var id: Key { key }

    private enum CodingKeys: String, CodingKey { case key, items }

    init(key: Key, items: [TaskListItem]) {
        self.key = key
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(Key.self, forKey: .key)
        // A row this build cannot read is left out, not the group.
        items = ((try? c.decode([Lenient<TaskListItem>].self, forKey: .items)) ?? []).compactMap(\.value)
    }
}

/// Decodes to nil where the value has a shape this build cannot read, and
/// logs why.
private struct Lenient<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws {
        do {
            value = try Value(from: decoder)
        } catch {
            taskListLog.error("left out a \(String(describing: Value.self), privacy: .public): \(String(describing: error), privacy: .public)")
            value = nil
        }
    }
}

/// One row: a task, a check no task has, a follow, or a routine.
enum TaskListItem: Decodable, Hashable, Sendable, Identifiable {
    case task(Task)
    case check(Check)
    case follow(Follow)
    case routine(Routine)

    /// A task with its schedule and soonest check.
    struct Task: Decodable, Hashable, Sendable {
        var task: ConciergeTask
        var schedule: Schedule?
        var check: TaskCheck?
        /// While it needs its owner: the message of this chat that shows the
        /// card it waits on. Nil where no message of this chat shows it.
        var cardMessageId: String?
    }

    /// `HH:mm` in its owner's zone, on `days` (`mon` … `sun`) or every day.
    struct Schedule: Decodable, Hashable, Sendable {
        var at: String
        var days: [String]?
    }

    struct TaskCheck: Decodable, Hashable, Sendable {
        var id: String
        /// Epoch ms; nil for an event wait with no deadline.
        var at: Double?
        /// The schedule's next run, not a wake-up.
        var recurring: Bool
    }

    /// A one-off wake-up of the chat that no task has.
    struct Check: Decodable, Hashable, Sendable {
        struct Body: Decodable, Hashable, Sendable {
            var id: String
            var name: String
            var at: Double?
            var waitingFor: String?
            /// Epoch ms; an instance that does not send it gives the menu no title.
            var createdAt: Double?
        }
        var check: Body
    }

    /// A followed target whose alerts and digest come to this chat.
    struct Follow: Decodable, Hashable, Sendable {
        var source: String
        var label: String
        var target: String
        /// `active`, `off` or `unavailable`.
        var state: String
        /// `HH:mm`, sorted.
        var digestTimes: [String]
        var createdAt: Double?
    }

    /// A routine that works for this chat.
    struct Routine: Decodable, Hashable, Sendable {
        struct Trigger: Decodable, Hashable, Sendable {
            /// `schedule`, `event-bus` or `manual`.
            var type: String
            var localTime: String?
            var rrule: String?
            var date: String?
            var eventName: String?
        }
        struct LastRun: Decodable, Hashable, Sendable {
            var status: String
            var firedAt: Double
        }
        var id: String
        var name: String
        var trigger: Trigger
        var enabled: Bool
        var nextRunAt: Double?
        var lastRun: LastRun?
        var createdAt: Double?
    }

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
        switch kind {
        case "task": self = .task(try Task(from: decoder))
        case "check": self = .check(try Check(from: decoder))
        case "follow": self = .follow(try Follow(from: decoder))
        case "routine": self = .routine(try Routine(from: decoder))
        default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "kind \(kind)"))
        }
    }

    /// When the row's work was made, for its menu's title; nil where the
    /// instance does not say.
    var createdAt: Date? {
        let ms: Double?
        switch self {
        case .task(let item): ms = item.task.createdAt
        case .check(let item): ms = item.check.createdAt
        case .follow(let item): ms = item.createdAt
        case .routine(let item): ms = item.createdAt
        }
        return RomeDate.fromMillis(ms)
    }

    var id: String {
        switch self {
        case .task(let item): return "task:\(item.task.id)"
        case .check(let item): return "check:\(item.check.id)"
        case .follow(let item): return "follow:\(item.source):\(item.target)"
        case .routine(let item): return "routine:\(item.id)"
        }
    }
}

// MARK: - Lenient reading
//
// Each row reads what it can: a missing or odd optional field degrades the
// row, and only a row with no id or title of its own is left out.

private extension KeyedDecodingContainer {
    /// The value, or nil when it is missing, null or of another shape.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

extension TaskListItem.Task {
    private enum CodingKeys: String, CodingKey { case task, schedule, check, cardMessageId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = try c.decode(ConciergeTask.self, forKey: .task)
        schedule = c.lenient(TaskListItem.Schedule.self, .schedule)
        check = c.lenient(TaskListItem.TaskCheck.self, .check)
        cardMessageId = c.lenient(String.self, .cardMessageId)
    }
}

extension TaskListItem.TaskCheck {
    private enum CodingKeys: String, CodingKey { case id, at, recurring }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = c.lenient(Double.self, .at)
        recurring = c.lenient(Bool.self, .recurring) ?? false
    }
}

extension TaskListItem.Check.Body {
    private enum CodingKeys: String, CodingKey { case id, name, at, waitingFor, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        at = c.lenient(Double.self, .at)
        waitingFor = c.lenient(String.self, .waitingFor)
        createdAt = c.lenient(Double.self, .createdAt)
    }
}

extension TaskListItem.Follow {
    private enum CodingKeys: String, CodingKey { case source, label, target, state, digestTimes, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(String.self, forKey: .target)
        source = c.lenient(String.self, .source) ?? ""
        label = c.lenient(String.self, .label) ?? source
        state = c.lenient(String.self, .state) ?? "active"
        digestTimes = c.lenient([String].self, .digestTimes) ?? []
        createdAt = c.lenient(Double.self, .createdAt)
    }
}

extension TaskListItem.Routine {
    private enum CodingKeys: String, CodingKey { case id, name, trigger, enabled, nextRunAt, lastRun, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        // A trigger this build cannot read says "On a schedule".
        trigger = c.lenient(Trigger.self, .trigger) ?? Trigger(type: "other")
        enabled = c.lenient(Bool.self, .enabled) ?? true
        nextRunAt = c.lenient(Double.self, .nextRunAt)
        lastRun = c.lenient(LastRun.self, .lastRun)
        createdAt = c.lenient(Double.self, .createdAt)
    }
}

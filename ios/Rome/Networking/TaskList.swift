import Foundation

// A Concierge chat's task list, the Agent page's Tasks tab: everything that
// runs for the chat, grouped by the server (`GET /chats/:chatId/tasks`).
// docs/domains/chats.md#task-list

/// `GET /chats/:chatId/tasks`: the groups that have rows, in order.
struct TaskListResponse: Decodable, Hashable, Sendable {
    var chatId: String
    var groups: [TaskListGroup]
}

struct TaskListGroup: Decodable, Hashable, Sendable, Identifiable {
    enum Key: String, Decodable, Sendable {
        case needsYou = "needs_you", active, later, onItsOwn = "on_its_own", ended
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
        // A row of a kind this build does not know is left out, not the list.
        items = try c.decode([Lenient<TaskListItem>].self, forKey: .items).compactMap(\.value)
    }
}

/// Decodes to nil where the value has a shape this build cannot read.
private struct Lenient<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
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

    var id: String {
        switch self {
        case .task(let item): return "task:\(item.task.id)"
        case .check(let item): return "check:\(item.check.id)"
        case .follow(let item): return "follow:\(item.source):\(item.target)"
        case .routine(let item): return "routine:\(item.id)"
        }
    }
}

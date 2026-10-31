import Foundation

// Wire types of the Rome dashboard API the app reads. They mirror
// `@rome/api-types` (chat.ts, concierge.ts) and packages/web/src/lib/chat-types.ts.
// Every field the server may leave out is optional, so a newer server that adds
// fields never breaks an older app.

/// The Concierge chat's fixed id.
let conciergeChatID = "concierge"

/// One row of `GET /chat/sessions`.
struct ChatSession: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var agentName: String?
    var triggerKind: String?
    var archivedAt: String?
    var activityAt: String?
    var unread: Bool?
    var running: Bool?
    var lastTurnFailed: Bool?
    var awaitingGuardian: Bool?
    var largeModelSelection: String?
}

/// One stored message. `content` is a JSON array of parts, or plain text on old rows.
struct ChatMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var sessionId: String
    var turnId: String?
    var role: String
    var content: String
    var createdAt: String
    var traceSummary: TraceSummary?

    var date: Date { RomeDate.parse(createdAt) ?? .distantPast }

    var parts: [MessagePart] { MessagePart.parse(content) }

    var isUser: Bool { role == "user" }
    var isTrace: Bool { role == "trace" }
}

struct TraceSummary: Codable, Hashable, Sendable {
    var totalSteps: Int?
    var turnStatus: String?
    var stoppedByUser: Bool?
    var terminalError: String?
}

/// `GET /chat/sessions/:id/messages?limit=&before=`.
struct MessagePage: Codable, Sendable {
    var messages: [ChatMessage]
    var nextCursor: String?
}

/// `GET /concierge/session`.
struct ConciergeSessionInfo: Codable, Sendable {
    var id: String
    var unread: Int
}

/// `POST /chat/sessions/:id/turns`.
struct CreatedTurn: Codable, Sendable {
    var turnId: String?
    var inputId: String?
    var disposition: String?
}

/// One in-flight turn from `GET /chat/sessions/:id/turns`.
struct ActiveTurn: Codable, Hashable, Sendable {
    var turnId: String
    var status: String?
    var quiet: Bool?
}

/// How a sent input treats a turn that is already running.
enum InputPriority: String, Sendable {
    /// End the running turn and start a new one with this input (Concierge).
    case now
    /// Join the running turn or wait for it (task chats).
    case next
}

// MARK: - Concierge tasks

/// The state the Concierge gave a task row. The system never derives it.
enum TaskState: String, Codable, Sendable, CaseIterable {
    case next, doing, watching, needsUser = "needs_user", done, dropped
}

/// One row of the Concierge's own todo list (`GET /concierge/tasks`). Times are epoch ms.
struct ConciergeTask: Codable, Identifiable, Hashable, Sendable {
    struct LinkedChat: Codable, Hashable, Sendable {
        var id: String
        var name: String
    }

    let id: String
    var title: String
    var state: TaskState
    var summary: String?
    var waitingOn: String?
    var dueAt: Double?
    var rank: Double?
    var chat: LinkedChat?
    var sourceMessageId: String?
    var createdAt: Double
    var updatedAt: Double
    var completedAt: Double?
    var archivedAt: Double?
    var notSynced: Bool?
}

struct ConciergeTasksResponse: Codable, Sendable {
    var tasks: [ConciergeTask]
}

struct TaskUpsertEvent: Codable, Sendable {
    var task: ConciergeTask
}

// MARK: - Approvals

/// `GET /approvals/:id`.
struct ApprovalRecord: Codable, Hashable, Sendable {
    var id: String
    var status: String
    var executionState: String?
    var executionError: String?
    var resolvedAt: String?
    var updatedAt: String?
}

/// What an approval card shows, derived from the stored part and the server's record.
enum ApprovalStatus: String, Sendable {
    case pending, approved, executing, executed, rejected, failed

    var isResolved: Bool { self != .pending }

    static func derive(stored: String?, record: ApprovalRecord?) -> ApprovalStatus {
        guard let record else { return ApprovalStatus(rawValue: stored ?? "") ?? .pending }
        switch record.status {
        case "rejected": return .rejected
        case "approved", "auto_approved":
            switch record.executionState {
            case "succeeded": return .executed
            case "failed": return .failed
            case "running": return .executing
            default: return .approved
            }
        default: return .pending
        }
    }
}

// MARK: - AI tools

/// `GET /ai-tools/status`: the two subscriptions Rome can run on.
struct AIToolsStatus: Codable, Sendable {
    struct Window: Codable, Sendable {
        var usedPercent: Double?
        var resetsAt: String?
    }

    struct Usage: Codable, Sendable {
        var fiveHour: Window?
        var sevenDay: Window?
    }

    struct Provider: Codable, Sendable {
        var loggedIn: Bool?
        var usage: Usage?
        var quotaExhausted: Bool?
    }

    var claude: Provider?
    var codex: Provider?
}

// MARK: - Routines

/// One row of `GET /routines`.
struct Routine: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var enabled: Bool
    var trigger: JSONValue?
    var nextRunAt: String?
    var managedBy: String?
    var actionName: String?
}

// MARK: - Trace

/// `GET /chat/messages/:id/content`: a turn's trace, used to list its tool calls.
struct TraceContent: Codable, Sendable {
    struct Trace: Codable, Sendable {
        var segments: [JSONValue]
    }

    var trace: Trace?
}

/// One tool call, as the expanded tool summary lists it.
struct ToolCall: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let detail: String
    let input: JSONValue
}

// MARK: - Dates

enum RomeDate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        return fractional.date(from: text) ?? plain.date(from: text)
    }

    static func string(_ date: Date) -> String {
        fractional.string(from: date)
    }

    static func fromMillis(_ value: Double?) -> Date? {
        value.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}

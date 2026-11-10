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
    /// The first message of the chat thread this one is in; nil when it is
    /// alone, or on an instance without chat threads.
    var chatThreadId: String? = nil
    /// The instance sent `chatThreadId`, null included: it has chat threads.
    /// An older instance leaves the field out.
    var knowsThreads = false

    var date: Date { RomeDate.parse(createdAt) ?? .distantPast }

    var parts: [MessagePart] { MessagePart.parse(content) }

    var isUser: Bool { role == "user" }
    var isTrace: Bool { role == "trace" }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, turnId, role, content, createdAt, traceSummary, chatThreadId
    }
}

extension ChatMessage {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        traceSummary = try container.decodeIfPresent(TraceSummary.self, forKey: .traceSummary)
        chatThreadId = try container.decodeIfPresent(String.self, forKey: .chatThreadId)
        knowsThreads = container.contains(.chatThreadId)
    }

    /// Writes `chatThreadId` as null when the instance sent it as null, so a
    /// kept copy reads back the same.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encodeIfPresent(turnId, forKey: .turnId)
        try container.encode(role, forKey: .role)
        try container.encode(content, forKey: .content)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(traceSummary, forKey: .traceSummary)
        if knowsThreads { try container.encode(chatThreadId, forKey: .chatThreadId) }
    }

    /// The chat thread it is in, by its first message: its own id when alone.
    var threadRoot: String { chatThreadId ?? id }
}

/// Where a message sent from a chat thread goes. An instance with chat
/// threads takes `chatThread`; an older one places a reply by
/// `replyToMessageId` (every supported release has it).
struct ThreadTarget: Codable, Hashable, Sendable {
    /// A message of the open thread.
    let messageId: String
    let instanceKnowsThreads: Bool

    var body: [String: JSONValue] {
        instanceKnowsThreads ? ["chatThread": .string(messageId)] : ["replyToMessageId": .string(messageId)]
    }
}

struct TraceSummary: Codable, Hashable, Sendable {
    var totalSteps: Int?
    var turnStatus: String?
    var stoppedByUser: Bool?
    var terminalError: String?
}

/// `GET /system/upgrade/check`: the instance's release and the latest one,
/// relayed from Rome Cloud.
struct UpgradeCheck: Codable, Hashable, Sendable {
    struct Release: Codable, Hashable, Sendable {
        var version: String?
        var sha: String?
    }

    var current: Release?
    var latest: Release?
    var upgradeAvailable: Bool?
}

/// `POST /system/upgrade`: Rome Cloud accepted an upgrade to `target`.
struct UpgradeStarted: Codable, Hashable, Sendable {
    var status: String?
    var target: String?
}

/// `GET /build-info`: the release the running instance was built from.
struct BuildInfo: Codable, Hashable, Sendable {
    var version: String?
    var sha: String?
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

// MARK: - Concierge chats

/// A Concierge chat: the main chat, or a topic chat the guardian started.
/// An untitled topic chat has an empty name until its first message names it.
struct ConciergeChat: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var main: Bool
    /// Agent messages since the guardian last read it.
    var unread: Int?
}

/// `GET /concierge/chats`: the main chat first, then the topic chats, oldest first.
struct ConciergeChatsResponse: Codable, Sendable {
    var chats: [ConciergeChat]
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
    /// The Concierge chat the row came from. Older servers leave it out.
    var conciergeChat: ConciergeChat?
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

// MARK: - Routines

/// One routine of `GET /routines`, with only what a routine card reads. A
/// routine is on unless `enabled` is `false`, as the dashboard reads it.
struct RoutineRef: Decodable, Hashable, Sendable {
    var id: String
    var name: String?
    var key: String?
    var enabled: Bool?
}

/// A routine card's state line.
enum RoutineStatus: Hashable, Sendable {
    /// No routine was made from the card yet.
    case notOn
    case on(routineId: String)
    case paused(routineId: String)

    /// The routine a card made, as the dashboard's card finds it: by the
    /// card's key, else, for a card written before keys, by its name among
    /// routines without a key.
    static func find(_ part: MessagePart.RoutineDraftPart, in routines: [RoutineRef]) -> RoutineStatus {
        let match = part.routineKey.map { key in routines.first { $0.key == key } }
            ?? routines.first { $0.key == nil && $0.name == part.name }
        guard let match else { return .notOn }
        return match.enabled == false ? .paused(routineId: match.id) : .on(routineId: match.id)
    }

    var routineId: String? {
        switch self {
        case .notOn: return nil
        case .on(let id), .paused(let id): return id
        }
    }
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

// MARK: - Apps

/// One app on the instance, as `GET /api/apps` lists it. Every field but the
/// id is read as optional, so an older server keeps decoding.
struct InstalledApp: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var displayName: String?
    var description: String?
    /// `/api/apps/<id>/icon` when the app has one.
    var iconUrl: String?
    /// The installed version: a new one may bring a new icon.
    var version: String?
    /// `/full/apps/<id>`, set only when the app is running and has a page.
    var fullHref: String?
    /// `local` (made here), `appstore` (installed) or `builtin` (ships with Rome).
    var origin: String?
    var hideInLauncher: Bool?
    var status: String?

    var name: String { displayName ?? id }
}

struct AppList: Codable, Sendable {
    var apps: [InstalledApp]
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

// MARK: - Identity

/// Who is signed in, as `GET /auth/me` names them, read the way the web
/// dashboard's profile menu reads it: the guardian's display name, else
/// "Guardian"; a visitor's email; the Rome Cloud picture when there is one.
struct AccountIdentity: Equatable, Sendable {
    let name: String
    let avatarURL: URL?
    /// The instance's guardian, not an allow-listed visitor.
    let isGuardian: Bool

    init(name: String, avatarURL: URL? = nil, isGuardian: Bool = true) {
        self.name = name
        self.avatarURL = avatarURL
        self.isGuardian = isGuardian
    }

    init?(json body: JSONValue) {
        let picture = body["avatarUrl"]?.string.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        switch body["kind"]?.string {
        case "guardian":
            let display = body["displayName"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            name = display.isEmpty ? String(localized: "Guardian") : display
        case "visitor":
            guard let email = body["email"]?.string, !email.isEmpty else { return nil }
            name = email
        default:
            return nil
        }
        avatarURL = picture
        isGuardian = body["kind"]?.string == "guardian"
    }
}

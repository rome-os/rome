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
    /// The title of the task whose chat thread the message is in. The server
    /// sends a thread only when a task has it, so a message with a thread and
    /// no title is from an instance before task threads.
    var chatThreadTitle: String? = nil
    /// Who said a guardian-side message, when it was not simply the guardian.
    var sender: MessageSender? = nil
    /// Where a guardian message stands with the agent: `failed` and `unknown`
    /// mean it was not (or may not have been) handed over. Nil from older instances.
    var inputState: String? = nil
    /// Rome's mark on a guardian message in a Chat: `working` or `failed`.
    var statusReaction: String? = nil

    var date: Date { RomeDate.parse(createdAt) ?? .distantPast }

    var parts: [MessagePart] { MessagePart.parse(content) }

    var isUser: Bool { role == "user" }
    var isTrace: Bool { role == "trace" }

    /// Said in a task chat by the agent that started it, the Concierge: an
    /// agent on no one's behalf, on the guardian's side of the chat.
    var saidByAgent: Bool {
        isUser && sender?.kind == "automated" && sender?.sourceType == "agent" && sender?.onBehalfOf == nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, turnId, role, content, createdAt, traceSummary, chatThreadId, chatThreadTitle, sender, inputState, statusReaction
    }
}

/// The sender the instance resolves for a message (`ChatMessageSender` on
/// the wire). Only the fields the app reads; all optional.
struct MessageSender: Codable, Hashable, Sendable {
    struct OnBehalfOf: Codable, Hashable, Sendable {
        var kind: String?
        var name: String?
    }

    /// `automated`, `guardian` or `visitor`.
    var kind: String?
    /// For `automated`: `agent`, `app`, `routine` or null.
    var sourceType: String?
    var name: String?
    var onBehalfOf: OnBehalfOf?
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
        chatThreadTitle = try container.decodeIfPresent(String.self, forKey: .chatThreadTitle)
        // An unknown shape never costs the message itself.
        sender = try? container.decodeIfPresent(MessageSender.self, forKey: .sender)
        inputState = (try? container.decodeIfPresent(String.self, forKey: .inputState)) ?? nil
        statusReaction = (try? container.decodeIfPresent(String.self, forKey: .statusReaction)) ?? nil
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
        try container.encodeIfPresent(chatThreadTitle, forKey: .chatThreadTitle)
        try container.encodeIfPresent(sender, forKey: .sender)
        try container.encodeIfPresent(inputState, forKey: .inputState)
        try container.encodeIfPresent(statusReaction, forKey: .statusReaction)
    }

    /// The chat thread it is in, by its first message: its own id when alone.
    var threadRoot: String { chatThreadId ?? id }
}

/// What a message the guardian sends replies to: the quoted message, and
/// the thread view it was sent from, if one was open. The server places the
/// reply in a task's thread when either is in one
/// (docs/domains/chats.md#chat-thread).
struct ThreadTarget: Codable, Hashable, Sendable {
    /// The message replied to, quoted in the reply bar.
    let messageId: String
    let instanceKnowsThreads: Bool
    /// Written by a build where Reply quoted; absent from drafts written
    /// when Reply opened the thread view.
    var quote: Bool? = nil
    /// A message of the thread view the reply was sent from.
    var thread: String? = nil
    /// Aimed at the thread only: opened from its label, with no message
    /// replied to, so there is no reply bar and the send names no message.
    var bare: Bool? = nil

    var isQuote: Bool { quote == true }

    /// The message whose thread view the reply was written in. A draft from
    /// before quotes was always written in one, at `messageId`.
    var threadMessage: String? { isQuote ? thread : messageId }

    var body: [String: JSONValue] {
        var body: [String: JSONValue] = [:]
        if bare != true { body["replyToMessageId"] = .string(messageId) }
        if let thread { body["chatThread"] = .string(thread) }
        return body
    }
}

struct TraceSummary: Codable, Hashable, Sendable {
    var totalSteps: Int?
    var turnStatus: String?
    var stoppedByUser: Bool?
    var terminalError: String?
    /// Why the turn failed, as structured fields; set only with `terminalError`,
    /// and absent from instances before them.
    var terminalErrorCode: String?
    var terminalErrorProvider: String?
    var terminalErrorReason: String?
    /// The turn is the first of a session that replaced the chat's earlier one.
    var sessionRenewal: SessionRenewal? = nil
    /// The turn ran on what a routine, an app or another agent sent into a
    /// Concierge chat, which shows a faint line naming it.
    var automatedInput: InputSource? = nil

    /// Why a chat's agent session was renewed (`setup`, `idle`, `daily`,
    /// `working_dir`, `context`, or a newer one), and the session it started.
    struct SessionRenewal: Codable, Hashable, Sendable {
        var reason: String?
        var sessionId: String?
    }

    /// Who sent the input a turn ran on (`SystemInputSource` on the wire).
    struct InputSource: Codable, Hashable, Sendable {
        /// `routine`, `app`, `agent` or `automation`.
        var type: String?
        var name: String?
    }

    private enum CodingKeys: String, CodingKey {
        case totalSteps, turnStatus, stoppedByUser, terminalError, terminalErrorCode, terminalErrorProvider, terminalErrorReason, sessionRenewal, automatedInput
    }

    init(totalSteps: Int? = nil, turnStatus: String? = nil, stoppedByUser: Bool? = nil, terminalError: String? = nil, terminalErrorCode: String? = nil, terminalErrorProvider: String? = nil, terminalErrorReason: String? = nil, sessionRenewal: SessionRenewal? = nil, automatedInput: InputSource? = nil) {
        self.totalSteps = totalSteps
        self.turnStatus = turnStatus
        self.stoppedByUser = stoppedByUser
        self.terminalError = terminalError
        self.terminalErrorCode = terminalErrorCode
        self.terminalErrorProvider = terminalErrorProvider
        self.terminalErrorReason = terminalErrorReason
        self.sessionRenewal = sessionRenewal
        self.automatedInput = automatedInput
    }

    /// A shape this build does not know drops only its own field, never the message.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        totalSteps = try? container.decodeIfPresent(Int.self, forKey: .totalSteps)
        turnStatus = try? container.decodeIfPresent(String.self, forKey: .turnStatus)
        stoppedByUser = try? container.decodeIfPresent(Bool.self, forKey: .stoppedByUser)
        terminalError = try? container.decodeIfPresent(String.self, forKey: .terminalError)
        terminalErrorCode = try? container.decodeIfPresent(String.self, forKey: .terminalErrorCode)
        terminalErrorProvider = try? container.decodeIfPresent(String.self, forKey: .terminalErrorProvider)
        terminalErrorReason = try? container.decodeIfPresent(String.self, forKey: .terminalErrorReason)
        sessionRenewal = try? container.decodeIfPresent(SessionRenewal.self, forKey: .sessionRenewal)
        automatedInput = try? container.decodeIfPresent(InputSource.self, forKey: .automatedInput)
    }
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
    /// The agent's own id for a backend turn, which its saved messages carry.
    var agentTurnId: String?
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
    /// What the Concierge is doing in this chat now. Absent on older
    /// instances, and for a state this build does not know: no status line.
    var activity: ConciergeActivity? = nil

    private enum CodingKeys: String, CodingKey { case id, name, main, unread, activity }

    init(id: String, name: String, main: Bool, unread: Int? = nil, activity: ConciergeActivity? = nil) {
        self.id = id
        self.name = name
        self.main = main
        self.unread = unread
        self.activity = activity
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        main = try container.decode(Bool.self, forKey: .main)
        unread = try container.decodeIfPresent(Int.self, forKey: .unread)
        activity = (try? container.decodeIfPresent(JSONValue.self, forKey: .activity)).flatMap { $0 }.flatMap(ConciergeActivity.init(json:))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(main, forKey: .main)
        try container.encodeIfPresent(unread, forKey: .unread)
        try container.encodeIfPresent(activity?.json, forKey: .activity)
    }
}

/// What the Concierge is doing in one of its chats, as the server works it
/// out (`ConciergeActivity`). The app only draws it.
enum ConciergeActivity: Hashable, Sendable {
    case idle
    /// A card or approval waits on the guardian.
    case needsYou
    /// The chat's turn is running, in no named tool.
    case working
    /// The chat's turn is in a named tool.
    case tool(Tool)
    /// Task chats it started are running: the newest's title, and how many more.
    case tasks(title: String, more: Int)

    enum Tool: String, Sendable, CaseIterable {
        case startingTask, messagingTask, readingChat, stoppingTask, updatingTasks
        case startingTopic, checkingFollows, searchingWeb, readingPage
        /// A handoff is being written for the chat's next session.
        case tidyingUp
    }

    /// Lenient, as the contract asks: an unknown kind is nil (no line), an
    /// unknown tool reads as working.
    init?(json: JSONValue) {
        switch json["kind"]?.string {
        case "idle": self = .idle
        case "needsYou": self = .needsYou
        case "working": self = .working
        case "tool": self = json["tool"]?.string.flatMap(Tool.init(rawValue:)).map(Self.tool) ?? .working
        case "tasks":
            let title = json["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let more = json["more"]?.number.map(Int.init) ?? 0
            self = title.isEmpty ? .working : .tasks(title: title, more: max(0, more))
        default: return nil
        }
    }

    var json: JSONValue {
        switch self {
        case .idle: return .object(["kind": .string("idle")])
        case .needsYou: return .object(["kind": .string("needsYou")])
        case .working: return .object(["kind": .string("working")])
        case .tool(let tool): return .object(["kind": .string("tool"), "tool": .string(tool.rawValue)])
        case .tasks(let title, let more): return .object(["kind": .string("tasks"), "title": .string(title), "more": .number(Double(more))])
        }
    }

    /// The header's second line; nil leaves the name alone.
    var statusLine: String? {
        switch self {
        case .idle: return nil
        // Its own key, so its Chinese reads as the header's status.
        case .needsYou: return String(localized: "status.needsYou", defaultValue: "Waiting for your answer")
        case .working: return String(localized: "Working on it")
        case .tasks(let title, let more): return more > 0 ? "\(title) +\(more)" : title
        case .tool(let tool):
            switch tool {
            case .startingTask: return String(localized: "Starting a task")
            case .messagingTask: return String(localized: "Writing to a task chat")
            case .readingChat: return String(localized: "Reading a chat")
            case .stoppingTask: return String(localized: "Stopping a task")
            case .updatingTasks: return String(localized: "Updating tasks")
            case .startingTopic: return String(localized: "Starting a topic chat")
            case .checkingFollows: return String(localized: "Checking what you follow")
            case .searchingWeb: return String(localized: "Searching the web")
            case .readingPage: return String(localized: "Reading a page")
            case .tidyingUp: return String(localized: "Tidying up context…")
            }
        }
    }

    /// Working, in a tool, or running tasks: the line shimmers and the mascot is alive.
    var isBusy: Bool {
        switch self {
        case .working, .tool, .tasks: return true
        case .idle, .needsYou: return false
        }
    }
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
    /// The first message of the task's chat thread in its Concierge chat.
    var threadRoot: String?
    /// How the task stands, derived by the server: `needs_you`, `active`,
    /// `later` or `ended`.
    var status: String?
    /// Why an ended task ended: `done`, `failed`, `stopped` or `no_response`.
    var endReason: String?
    /// What the task chat waits on its owner for, as the server sends it:
    /// a card (`{kind:"card", id, messageId, render, since}`) or an approval
    /// (`{kind:"approval", id, since}`). Null when nothing waits.
    var openWait: JSONValue?
    /// While it needs its owner: since when, epoch ms.
    var waitingSince: Double?
    /// A later task with no check: when it is due, epoch ms.
    var laterAt: Double?

    private enum CodingKeys: String, CodingKey {
        case id, title, state, summary, waitingOn, dueAt, rank, chat, conciergeChat, sourceMessageId
        case createdAt, updatedAt, completedAt, archivedAt, notSynced, threadRoot, status, endReason, openWait
        case waitingSince, laterAt
    }

    init(id: String, title: String, state: TaskState, summary: String? = nil, waitingOn: String? = nil, dueAt: Double? = nil, rank: Double? = nil, chat: LinkedChat? = nil, conciergeChat: ConciergeChat? = nil, sourceMessageId: String? = nil, createdAt: Double, updatedAt: Double, completedAt: Double? = nil, archivedAt: Double? = nil, notSynced: Bool? = nil, threadRoot: String? = nil, status: String? = nil, endReason: String? = nil, openWait: JSONValue? = nil) {
        self.id = id
        self.title = title
        self.state = state
        self.summary = summary
        self.waitingOn = waitingOn
        self.dueAt = dueAt
        self.rank = rank
        self.chat = chat
        self.conciergeChat = conciergeChat
        self.sourceMessageId = sourceMessageId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.archivedAt = archivedAt
        self.notSynced = notSynced
        self.threadRoot = threadRoot
        self.status = status
        self.endReason = endReason
        self.openWait = openWait
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        // A state this build does not know reads from the derived status.
        let derived = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
        state = (try? c.decode(TaskState.self, forKey: .state)) ?? {
            switch derived {
            case "needs_you": return .needsUser
            case "later": return .next
            case "ended": return .done
            default: return .doing
            }
        }()
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        waitingOn = try c.decodeIfPresent(String.self, forKey: .waitingOn)
        dueAt = try c.decodeIfPresent(Double.self, forKey: .dueAt)
        rank = try c.decodeIfPresent(Double.self, forKey: .rank)
        chat = try c.decodeIfPresent(LinkedChat.self, forKey: .chat)
        conciergeChat = try c.decodeIfPresent(ConciergeChat.self, forKey: .conciergeChat)
        sourceMessageId = try c.decodeIfPresent(String.self, forKey: .sourceMessageId)
        createdAt = try c.decode(Double.self, forKey: .createdAt)
        updatedAt = try c.decode(Double.self, forKey: .updatedAt)
        completedAt = try c.decodeIfPresent(Double.self, forKey: .completedAt)
        archivedAt = try c.decodeIfPresent(Double.self, forKey: .archivedAt)
        notSynced = try c.decodeIfPresent(Bool.self, forKey: .notSynced)
        threadRoot = try c.decodeIfPresent(String.self, forKey: .threadRoot)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        endReason = try c.decodeIfPresent(String.self, forKey: .endReason)
        // A shape this build cannot read drops only the wait, never the task.
        openWait = (try? c.decodeIfPresent(JSONValue.self, forKey: .openWait)) ?? nil
        waitingSince = try? c.decodeIfPresent(Double.self, forKey: .waitingSince)
        laterAt = try? c.decodeIfPresent(Double.self, forKey: .laterAt)
    }
}

extension ConciergeTask {
    /// The id of the card or approval the task waits on: the card it shows
    /// takes an answer only while this names it.
    var waitId: String? { openWait?["id"]?.string }
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
    /// Who decided it; `rome:task-ended` and `rome:task-stopped` are Rome
    /// turning it down as its task's wait ran out or its task stopped.
    var resolvedBy: String?
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

/// A pending approval and the chat that asked for it, from `GET /approvals?status=pending`.
struct PendingApproval: Hashable, Sendable {
    let id: String
    /// The chat the action ran in (`payload.channelContext.threadId`).
    let chatId: String?
    let part: MessagePart.ApprovalPart
    let createdAt: Date

    /// Reads one row; a row with no id is skipped. A preview the app cannot
    /// read keeps the approval's controls, titled by the row's description.
    init?(json row: JSONValue) {
        guard let id = row["id"]?.string, row["status"]?.string ?? "pending" == "pending" else { return nil }
        self.id = id
        let payload = row["payload"]
        chatId = payload?["channelContext"]?["threadId"]?.string
        var fields: [String: JSONValue] = ["status": .string("pending")]
        if let action = payload?["actionName"]?.string { fields["actionName"] = .string(action) }
        if let preview = payload?["preview"] { fields["preview"] = preview }
        var part = MessagePart.approval(.object(fields), id: id)
        if part.title == nil, let description = row["description"]?.string, !description.isEmpty {
            part = .init(approvalId: id, actionName: part.actionName, title: description, summary: part.summary, fields: part.fields, storedStatus: part.storedStatus)
        }
        self.part = part
        createdAt = row["createdAt"]?.string.flatMap(RomeDate.parse) ?? .distantPast
    }

    init(id: String, chatId: String?, part: MessagePart.ApprovalPart, createdAt: Date) {
        self.id = id
        self.chatId = chatId
        self.part = part
        self.createdAt = createdAt
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

/// Remembers what a pure parse made of a string. A chat's rows are rebuilt from
/// its messages on every update of the chat, and parsing each message's date and
/// parts again each time (an ISO 8601 formatter, a JSON decode) made a sheet or
/// the sidebar stutter on a long chat.
final class ParseCache<Value>: @unchecked Sendable {
    private final class Box {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    /// Bounded, so one-off strings (timestamps of health samples, audit
    /// entries, another account's messages) do not pile up.
    private let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 4000
        return cache
    }()

    func value(for key: String, _ make: (String) -> Value) -> Value {
        if let hit = cache.object(forKey: key as NSString) { return hit.value }
        let value = make(key)
        cache.setObject(Box(value), forKey: key as NSString)
        return value
    }
}

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

    private static let parsed = ParseCache<Date?>()

    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        return parsed.value(for: text) { fractional.date(from: $0) ?? plain.date(from: $0) }
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

/// A read-only public link to some turns of a chat: one row of
/// `GET /chat/sessions/:id/shares`, or the answer of
/// `POST /chat/sessions/:id/share`. `url` is a path on the instance,
/// `/share/<token>`.
struct ChatShareLink: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var url: String
    var title: String?
    var createdAt: String?

    var date: Date? { createdAt.flatMap(RomeDate.parse) }
}

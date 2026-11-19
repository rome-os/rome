import Foundation

/// One search hit from `GET /chat/sessions/search`.
struct SearchHit: Codable, Identifiable, Hashable, Sendable {
    struct Snippet: Codable, Hashable, Sendable {
        var id: String
        var role: String
        var snippet: String
        var createdAt: String
    }

    var session: ChatSession
    var message: Snippet

    var id: String { message.id }
}

/// Everything the screens ask of a Rome instance. `LiveBackend` talks to a real
/// instance; `DemoBackend` serves built-in data for design review and previews.
@MainActor
protocol RomeBackend: AnyObject, Sendable {
    var displayOrigin: String { get }
    var events: LiveEventSource { get }
    /// The Rome Cloud account this connection belongs to: what it fetched is
    /// kept on this phone only while that account is signed in.
    var account: AccountStamp { get }

    func conciergeSession() async throws -> ConciergeSessionInfo
    /// The main chat first, then the topic chats, oldest first.
    func conciergeChats() async throws -> [ConciergeChat]
    /// Starts an untitled topic chat, which its first message names.
    func startTopicChat() async throws -> ConciergeChat
    func renameChat(_ id: String, to name: String) async throws
    /// Archives a chat; a Concierge topic chat retires with it.
    func archiveChat(_ id: String) async throws
    /// Archives a topic chat. `stoppingWork` ends its follows and open tasks
    /// instead of moving them to the main chat.
    func archiveChat(_ id: String, stoppingWork: Bool) async throws
    /// Deletes a chat for good; a Concierge topic chat retires with it.
    func deleteChat(_ id: String) async throws
    /// Deletes a topic chat for good. `stoppingWork` ends its follows and open
    /// tasks instead of moving them to the main chat.
    func deleteChat(_ id: String, stoppingWork: Bool) async throws
    /// The follows and open tasks that archiving or deleting topic chat `chatId` would move.
    func chatWork(chatId: String) async throws -> ConciergeChatWork
    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage
    /// The newest page, reaching down to `through` and two turns past it.
    func messages(sessionId: String, through: String, limit: Int) async throws -> MessagePage
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn
    /// A send that replies to a message (`replyToMessageId`).
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, reply: ReplyTarget?) async throws -> CreatedTurn
    /// A file in the chats' project folder, by its `/projects/…` path without the slash.
    func asset(path: String) async throws -> Data
    /// The same file shrunk to `width` (600 or 900) by an instance that can, and
    /// as it is by one that cannot. nil is the original.
    func asset(path: String, width: Int?) async throws -> Data
    /// An instance URL a reply points at: the path after `/api`, and its query
    /// still percent-encoded, sent as written.
    func apiFile(path: String, query: String?) async throws -> Data
    /// The instance's origin, when there is a real one.
    var origin: URL? { get }
    /// An event a widget fired, sent to core by the widget's id. Core decides
    /// what it means: its owner handles it, an app's widget by calling the app,
    /// and the question card by answering the agent.
    func answerWidget(widgetId: String, name: String, context: JSONValue) async throws -> WidgetEventReply
    func markRead(sessionId: String) async
    /// The owner has seen these messages of the chat, and every message said
    /// before the latest of them (`POST /chat/sessions/:id/messages/read`). It
    /// never throws: it says whether the instance took the mark. An instance
    /// before the route (a 404) or a network that fails leaves the messages as
    /// they were: the next time they are seen they are marked again.
    @discardableResult
    func markMessagesRead(sessionId: String, ids: [String]) async -> Bool
    /// The chat's read mark, `lastSeenActivityAt`: an ISO time, or nil when
    /// the chat has none or it cannot be read.
    func readMark(sessionId: String) async -> String?
    func sessions() async throws -> [ChatSession]
    func activeTurns(sessionId: String) async throws -> [ActiveTurn]
    func interrupt(turnId: String) async throws
    /// `GET /chats/:chatId/tasks`: the Concierge chat's task list, by the
    /// chat's server id.
    func taskList(chatId: String) async throws -> TaskListResponse
    /// The Ended group's next page alone, from `endedBefore` (its `nextCursor`).
    func endedTasks(chatId: String, endedBefore: String) async throws -> TaskListResponse
    /// Stops a task from its chat's task list; a scheduled one loses its schedule.
    func stopListedTask(chatId: String, taskId: String) async throws
    /// `GET /chat/sessions/:id/outputs`: the files chat `chatId`'s agent
    /// wrote or showed, a Concierge chat's task chats' included, newest first.
    func chatOutputs(chatId: String) async throws -> ChatOutputsResponse
    /// An output's bytes, from its `contentUrl` (the path after `/api`).
    func chatOutputFile(path: String) async throws -> Data
    func approval(id: String) async throws -> ApprovalRecord
    /// Every pending approval; the guardian's only (a visitor gets an error).
    func pendingApprovals() async throws -> [PendingApproval]
    func resolveApproval(id: String, approve: Bool) async throws
    func toolCalls(traceMessageId: String) async throws -> [ToolCall]
    func aiTools() async throws -> AIToolsStatus
    func setConciergeEnabled(_ enabled: Bool) async throws
    func search(_ query: String) async throws -> [SearchHit]
    /// The guardian's display name on this instance.
    func me() async throws -> AccountIdentity?
    /// The Concierge's own name, as the dashboard shows it (`agentName` in
    /// `GET /settings`); nil when none is set or it cannot be read.
    func agentName() async -> String?
    /// Whether this session is the instance's guardian, not a visitor.
    func isGuardian() async -> Bool
    /// The instance's apps, every origin; `AppLinks.mine` picks the guardian's.
    func apps() async throws -> [InstalledApp]
    /// The session cookie for a web view on the instance; nil without one.
    func webSessionCookie() -> HTTPCookie?
    /// The language the server writes in for the guardian: "en" or "zh-CN".
    func setGuardianLanguage(_ code: String) async throws
    /// Whether the instance offers voice input; nil when it cannot say.
    func voiceInputInfo() async throws -> VoiceInputInfo?
    /// The instance's dictation socket, signed in; nil without a real instance.
    func voiceInputSocket() -> URLRequest?
    func sendFeedback(_ text: String) async throws
    func upgradeCheck() async throws -> UpgradeCheck
    func startUpgrade(target: String) async throws -> UpgradeStarted
    func buildInfo() async throws -> BuildInfo
    /// A connect card's call on this Rome, with its session: `apiPath` is an
    /// `/api/…` path on the instance. Any status answers; only a dropped
    /// connection or a lost session throws.
    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply
    /// A widget's read of its own app: `path` is relative to
    /// `/api/apps/<appId>/`. Any status answers; only a dropped connection or
    /// a lost session throws.
    func appCall(appId: String, method: String, path: String, body: JSONValue?) async throws -> ConnectReply
    /// `GET /api/concierge/connectors`: every service Chat can use, and its state.
    func connectors() async throws -> [ConnectorState]
    /// `GET /api/routines`: the guardian's routines. A visitor gets an error.
    func routines() async throws -> [RoutineRef]
    /// Tells Chat in `chatId` that `service` is connected, so it goes on.
    func notifyServiceConnected(chatId: String, service: String) async
    /// `PUT /api/device-connections`: this phone's connections, in full.
    func reportDeviceConnections(_ report: DeviceConnectionReport) async throws
    /// Makes a public link to these turns of the chat, showing the Agent as
    /// `agentName` (nil: the page says Rome). No title: the instance names
    /// the share after the first turn.
    func shareChat(sessionId: String, turnIds: [String], agentName: String?) async throws -> ChatShareLink
    /// The chat's live share links, newest first.
    func chatShares(sessionId: String) async throws -> [ChatShareLink]
    /// Revokes a share link: it stops opening.
    func revokeShare(id: String) async throws
}

@MainActor
final class LiveBackend: RomeBackend {
    let client: APIClient
    let events: LiveEventSource
    let account: AccountStamp

    var displayOrigin: String { client.origin.host() ?? client.origin.absoluteString }

    init(client: APIClient, account: AccountStamp = .unchecked) {
        self.client = client
        self.account = account
        events = LiveEventsSocket(client: client)
    }

    func conciergeSession() async throws -> ConciergeSessionInfo {
        try await client.get("/concierge/session")
    }

    func conciergeChats() async throws -> [ConciergeChat] {
        let response: ConciergeChatsResponse = try await client.get("/concierge/chats")
        return response.chats
    }

    func startTopicChat() async throws -> ConciergeChat {
        try await client.post("/concierge/chats", json: .object([:]), as: ConciergeChat.self)
    }

    func renameChat(_ id: String, to name: String) async throws {
        try await client.patch("/chat/sessions/\(escape(id))/name", json: .object(["name": .string(name)]))
    }

    func archiveChat(_ id: String) async throws {
        try await client.patch("/chat/sessions/\(escape(id))/archive", json: .object(["archived": .bool(true)]))
    }

    func archiveChat(_ id: String, stoppingWork: Bool) async throws {
        // Without the option, the server moves them, as it always has.
        var body: [String: JSONValue] = ["archived": .bool(true)]
        if stoppingWork { body["followsAndTasks"] = .string("stop") }
        try await client.patch("/chat/sessions/\(escape(id))/archive", json: .object(body))
    }

    func deleteChat(_ id: String) async throws {
        try await client.delete("/chat/sessions/\(escape(id))")
    }

    func deleteChat(_ id: String, stoppingWork: Bool) async throws {
        // Without the option, the server moves them, as it always has.
        let query = stoppingWork ? [URLQueryItem(name: "followsAndTasks", value: "stop")] : []
        try await client.delete("/chat/sessions/\(escape(id))", query: query)
    }

    func chatWork(chatId: String) async throws -> ConciergeChatWork {
        // Optional, and bounded by the delete's wait: a 401 fails at once
        // instead of waiting on a session renewal that a cancel cannot end.
        try await client.get("/concierge/chats/\(escape(chatId))/follows-and-tasks", reportsUnauthorized: false)
    }


    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await client.get("/chat/sessions/\(escape(sessionId))/messages", query: query)
    }

    func messages(sessionId: String, through: String, limit: Int) async throws -> MessagePage {
        let query = [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "through", value: through)]
        return try await client.get("/chat/sessions/\(escape(sessionId))/messages", query: query)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority, reply: nil)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, reply: ReplyTarget?) async throws -> CreatedTurn {
        var body: [String: JSONValue] = ["text": .string(text), "inputId": .string(inputId), "priority": .string(priority.rawValue)]
        if let reply { body.merge(reply.body) { _, new in new } }
        if !files.isEmpty {
            body["files"] = .array(files.map { .object(["name": .string($0.name), "mimeType": .string($0.mimeType), "dataBase64": .string($0.dataBase64)]) })
        }
        return try await client.post("/chat/sessions/\(escape(sessionId))/turns", json: .object(body), as: CreatedTurn.self)
    }

    var origin: URL? { client.origin }

    func apiFile(path: String, query: String?) async throws -> Data {
        try await client.getFile(apiPath: path, percentEncodedQuery: query)
    }

    /// `projects/…` from the projects route, `memory/…` from memory's.
    func asset(path: String) async throws -> Data {
        try await asset(path: path, width: nil)
    }

    func asset(path: String, width: Int?) async throws -> Data {
        let route = path.hasPrefix("memory/") ? "/memory/asset" : "/projects/asset"
        var query = [URLQueryItem(name: "path", value: path)]
        if let width { query.append(URLQueryItem(name: "w", value: String(width))) }
        return try await client.getData(route, query: query, limit: APIClient.imageLimit)
    }

    func answerWidget(widgetId: String, name: String, context: JSONValue) async throws -> WidgetEventReply {
        let data = try await client.post(
            "/chat/widgets/\(escape(widgetId))/events",
            json: .object(["name": .string(name), "context": context])
        )
        return WidgetEventReply(json: (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .object([:]))
    }

    func markRead(sessionId: String) async {
        _ = try? await client.post("/chat/sessions/\(escape(sessionId))/read")
    }

    @discardableResult
    func markMessagesRead(sessionId: String, ids: [String]) async -> Bool {
        guard !ids.isEmpty else { return true }
        return (try? await client.post("/chat/sessions/\(escape(sessionId))/messages/read", json: .object(["ids": .array(ids.map { .string($0) })]))) != nil
    }

    func readMark(sessionId: String) async -> String? {
        let session: SessionReadMark? = try? await client.get("/chat/sessions/\(escape(sessionId))")
        return session?.lastSeenActivityAt
    }

    func sessions() async throws -> [ChatSession] {
        try await client.get("/chat/sessions")
    }

    func activeTurns(sessionId: String) async throws -> [ActiveTurn] {
        try await client.get("/chat/sessions/\(escape(sessionId))/turns")
    }

    func interrupt(turnId: String) async throws {
        try await client.post("/chat/turns/\(escape(turnId))/interrupt")
    }

    func taskList(chatId: String) async throws -> TaskListResponse {
        try await client.get("/chats/\(escape(chatId))/tasks")
    }

    func endedTasks(chatId: String, endedBefore: String) async throws -> TaskListResponse {
        try await client.get("/chats/\(escape(chatId))/tasks", query: [URLQueryItem(name: "endedBefore", value: endedBefore)])
    }

    func stopListedTask(chatId: String, taskId: String) async throws {
        try await client.post("/chats/\(escape(chatId))/tasks/\(escape(taskId))/stop")
    }

    func chatOutputs(chatId: String) async throws -> ChatOutputsResponse {
        try await client.get("/chat/sessions/\(escape(chatId))/outputs")
    }

    func chatOutputFile(path: String) async throws -> Data {
        // Sent as written: the server already encoded the ids in it.
        try await client.getFile(apiPath: path, percentEncodedQuery: nil, limit: APIClient.outputLimit, accept: "*/*")
    }

    func pendingApprovals() async throws -> [PendingApproval] {
        let rows: JSONValue = try await client.get("/approvals", query: [URLQueryItem(name: "status", value: "pending")], reportsUnauthorized: false)
        return (rows.array ?? []).compactMap(PendingApproval.init(json:))
    }

    func approval(id: String) async throws -> ApprovalRecord {
        try await client.get("/approvals/\(escape(id))")
    }

    func resolveApproval(id: String, approve: Bool) async throws {
        try await client.post("/approvals/\(escape(id))/\(approve ? "approve" : "reject")")
    }

    func toolCalls(traceMessageId: String) async throws -> [ToolCall] {
        let content: TraceContent = try await client.get("/chat/messages/\(escape(traceMessageId))/content")
        return ToolCallExtractor.calls(in: content.trace?.segments ?? [])
    }

    func aiTools() async throws -> AIToolsStatus {
        try await client.get("/ai-tools/status")
    }

    func setConciergeEnabled(_ enabled: Bool) async throws {
        try await client.put("/settings", json: .object(["experimentalConcierge": .bool(enabled)]))
    }

    func search(_ query: String) async throws -> [SearchHit] {
        try await client.get("/chat/sessions/search", query: [URLQueryItem(name: "q", value: query)])
    }

    func agentName() async -> String? {
        guard let settings: JSONValue = try? await client.get("/settings", reportsUnauthorized: false) else { return nil }
        return AgentName.display(settings["agentName"]?.string)
    }

    func me() async throws -> AccountIdentity? {
        let body: JSONValue = try await client.get("/auth/me")
        return AccountIdentity(json: body)
    }

    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply {
        try await client.exchange(method: method, apiPath: apiPath, json: body)
    }

    func appCall(appId: String, method: String, path: String, body: JSONValue?) async throws -> ConnectReply {
        guard let apiPath = WidgetPaths.appAPIPath(appId: appId, path: path) else { throw APIError.notFound }
        return try await client.exchange(method: method, apiPath: apiPath, json: body)
    }

    func connectors() async throws -> [ConnectorState] {
        let body: JSONValue = try await client.get("/concierge/connectors")
        return (body["connectors"]?.array ?? []).compactMap(ConnectorState.init(json:))
    }

    func routines() async throws -> [RoutineRef] {
        // A visitor's 403 only leaves the card's status out; it is no lost session.
        try await client.get("/routines", reportsUnauthorized: false)
    }

    func notifyServiceConnected(chatId: String, service: String) async {
        _ = try? await client.post("/concierge/chats/\(escape(chatId))/service-connected", json: .object(["service": .string(service)]))
    }

    func reportDeviceConnections(_ report: DeviceConnectionReport) async throws {
        let body = try JSONEncoder().encode(report)
        let reply = try await client.raw("PUT", "/device-connections", json: body)
        guard (200..<300).contains(reply.status) else { throw APIError.server(status: reply.status, message: reply.errorCode) }
    }

    func isGuardian() async -> Bool {
        let body: JSONValue? = try? await client.get("/auth/me")
        return body?["kind"]?.string == "guardian"
    }

    func setGuardianLanguage(_ code: String) async throws {
        try await client.put("/settings", json: .object(["guardianLanguage": .string(code)]))
    }

    func voiceInputInfo() async throws -> VoiceInputInfo? {
        try await client.get("/voice-input")
    }

    func voiceInputSocket() -> URLRequest? {
        client.socketRequest(VoiceInputWire.socketPath)
    }

    func apps() async throws -> [InstalledApp] {
        let list: AppList = try await client.get("/apps")
        return list.apps
    }

    func webSessionCookie() -> HTTPCookie? { client.sessionCookie() }

    func sendFeedback(_ text: String) async throws {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        try await client.post("/feedback", json: .object([
            "body": .string(text),
            "client": .object(["app": .string("ios"), "version": .string(version)]),
        ]))
    }

    func upgradeCheck() async throws -> UpgradeCheck {
        try await client.get("/system/upgrade/check")
    }

    func startUpgrade(target: String) async throws -> UpgradeStarted {
        try await client.post("/system/upgrade", json: .object(["target": .string(target)]), as: UpgradeStarted.self)
    }

    /// Polled while the instance restarts after an upgrade; a 401 then is not
    /// an expired session.
    func buildInfo() async throws -> BuildInfo {
        try await client.get("/build-info", reportsUnauthorized: false)
    }

    func shareChat(sessionId: String, turnIds: [String], agentName: String?) async throws -> ChatShareLink {
        try await client.post("/chat/sessions/\(escape(sessionId))/share", json: Self.shareBody(turnIds: turnIds, agentName: agentName), as: ChatShareLink.self)
    }

    /// `layout` is always empty: the app shares turns only, so a chat's
    /// saved tiles (a project's files) never ride along, as they would by
    /// default.
    static func shareBody(turnIds: [String], agentName: String?) -> JSONValue {
        var body: [String: JSONValue] = ["turnIds": .array(turnIds.map(JSONValue.string)), "layout": .array([])]
        if let agentName { body["agentName"] = .string(agentName) }
        return .object(body)
    }

    func chatShares(sessionId: String) async throws -> [ChatShareLink] {
        try await client.get("/chat/sessions/\(escape(sessionId))/shares")
    }

    func revokeShare(id: String) async throws {
        try await client.delete("/chat/shares/\(escape(id))")
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

/// Reads tool calls out of a trace's segments, in order.
enum ToolCallExtractor {
    static func calls(in segments: [JSONValue]) -> [ToolCall] {
        var blocks: [JSONValue] = []
        for segment in segments {
            if segment["kind"]?.string == "run" {
                blocks.append(contentsOf: segment["blocks"]?.array ?? [])
            } else if let block = segment["block"] {
                blocks.append(block)
            }
        }
        return blocks.enumerated().compactMap { index, block in
            guard block["type"]?.string == "tool_use", let name = block["tool"]?.string else { return nil }
            let input = block["input"] ?? .null
            return ToolCall(
                id: block["id"]?.string ?? "\(index)",
                name: shortName(name),
                detail: describe(input),
                input: input
            )
        }
    }

    /// `mcp__app__web_fetch` → `web_fetch`.
    static func shortName(_ name: String) -> String {
        name.components(separatedBy: "__").last.flatMap { $0.isEmpty ? nil : $0 } ?? name
    }

    /// One line that says what a call worked on: its url, query, path or command.
    static func describe(_ input: JSONValue) -> String {
        let keys = ["description", "url", "query", "path", "file_path", "command", "pattern", "prompt", "text", "name"]
        for key in keys {
            if let value = input[key]?.string, !value.isEmpty {
                return value.replacingOccurrences(of: "\n", with: " ")
            }
        }
        if let first = input.object?.values.compactMap(\.string).first {
            return first.replacingOccurrences(of: "\n", with: " ")
        }
        return ""
    }
}

extension RomeBackend {
    /// Demo data and test doubles move a chat's work, as an older instance does.
    func archiveChat(_ id: String, stoppingWork: Bool) async throws { try await archiveChat(id) }
    func deleteChat(_ id: String, stoppingWork: Bool) async throws { try await deleteChat(id) }
    func chatWork(chatId: String) async throws -> ConciergeChatWork { throw APIError.notFound }
    /// Demo data and test doubles hold every message in the newest page.
    func messages(sessionId: String, through: String, limit: Int) async throws -> MessagePage {
        try await messages(sessionId: sessionId, before: nil, limit: limit)
    }
    func taskList(chatId: String) async throws -> TaskListResponse { TaskListResponse(chatId: chatId, groups: []) }
    func endedTasks(chatId: String, endedBefore: String) async throws -> TaskListResponse { TaskListResponse(chatId: chatId, groups: []) }
    func stopListedTask(chatId: String, taskId: String) async throws { throw APIError.notFound }
    func chatOutputs(chatId: String) async throws -> ChatOutputsResponse { ChatOutputsResponse(outputs: []) }
    func chatOutputFile(path: String) async throws -> Data { throw APIError.notFound }
    /// Demo data and test doubles hold the file as it is.
    func asset(path: String, width: Int?) async throws -> Data { try await asset(path: path) }
    /// Demo data and test doubles belong to no account.
    var account: AccountStamp { .unchecked }

    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply { throw APIError.notFound }
    func appCall(appId: String, method: String, path: String, body: JSONValue?) async throws -> ConnectReply { throw APIError.notFound }
    func connectors() async throws -> [ConnectorState] { [] }
    func agentName() async -> String? { nil }
    func pendingApprovals() async throws -> [PendingApproval] { [] }
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, reply: ReplyTarget?) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority)
    }
    func routines() async throws -> [RoutineRef] { throw APIError.notFound }
    func notifyServiceConnected(chatId: String, service: String) async {}
    func reportDeviceConnections(_ report: DeviceConnectionReport) async throws {}
    /// Demo data and test doubles keep no read marks of messages.
    func markMessagesRead(sessionId: String, ids: [String]) async -> Bool { true }
    /// Demo data and test doubles have no read mark: no unread line.
    func readMark(sessionId: String) async -> String? { nil }
    /// Stand-ins (demo, tests) are no guardian of a real instance.
    func isGuardian() async -> Bool { false }
    func setGuardianLanguage(_ code: String) async throws {}
    /// Stand-ins have no voice input.
    func voiceInputInfo() async throws -> VoiceInputInfo? { nil }
    func voiceInputSocket() -> URLRequest? { nil }
    func apps() async throws -> [InstalledApp] { [] }
    func webSessionCookie() -> HTTPCookie? { nil }
    func shareChat(sessionId: String, turnIds: [String], agentName: String?) async throws -> ChatShareLink { throw APIError.notFound }
    func chatShares(sessionId: String) async throws -> [ChatShareLink] { [] }
    func revokeShare(id: String) async throws {}
}

/// The Concierge's name as the dashboard shows it: trimmed, and nil when
/// blank, so the caller's fallback shows.
enum AgentName {
    static func display(_ configured: String?) -> String? {
        let name = configured?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? nil : name
    }

    /// What the Agent is called on screen: its own name, or Rome when none is
    /// set. Never "Chat" or "Concierge", which name the screen and the code.
    static let fallback = "Rome"

    static func shown(_ configured: String?) -> String {
        display(configured) ?? fallback
    }
}

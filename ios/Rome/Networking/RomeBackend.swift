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
    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn
    /// A send from a chat thread: it lands in that thread.
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, thread: ThreadTarget?) async throws -> CreatedTurn
    /// Every message of the chat thread `messageId` is in, oldest first.
    /// Only an instance with chat threads answers it.
    func thread(sessionId: String, messageId: String) async throws -> [ChatMessage]
    /// A file in the chats' project folder, by its `/projects/…` path without the slash.
    func asset(path: String) async throws -> Data
    /// An instance URL a reply points at: the path after `/api`, and its query
    /// still percent-encoded, sent as written.
    func apiFile(path: String, query: String?) async throws -> Data
    /// The instance's origin, when there is a real one.
    var origin: URL? { get }
    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws
    func markRead(sessionId: String) async
    func sessions() async throws -> [ChatSession]
    func activeTurns(sessionId: String) async throws -> [ActiveTurn]
    func interrupt(turnId: String) async throws
    func tasks() async throws -> [ConciergeTask]
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
    func sendFeedback(_ text: String) async throws
    func upgradeCheck() async throws -> UpgradeCheck
    func startUpgrade(target: String) async throws -> UpgradeStarted
    func buildInfo() async throws -> BuildInfo
    /// A connect card's call on this Rome, with its session: `apiPath` is an
    /// `/api/…` path on the instance. Any status answers; only a dropped
    /// connection or a lost session throws.
    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply
    /// `GET /api/concierge/connectors`: every service Chat can use, and its state.
    func connectors() async throws -> [ConnectorState]
    /// `GET /api/routines`: the guardian's routines. A visitor gets an error.
    func routines() async throws -> [RoutineRef]
    /// Tells Chat in `chatId` that `service` is connected, so it goes on.
    func notifyServiceConnected(chatId: String, service: String) async
    /// Makes a public link to these turns of the chat. An older instance
    /// answers 404 for a chat it cannot share, a Concierge chat among them.
    func shareChat(sessionId: String, turnIds: [String]) async throws -> ChatShareLink
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

    func thread(sessionId: String, messageId: String) async throws -> [ChatMessage] {
        let page: MessagePage = try await client.get("/chat/sessions/\(escape(sessionId))/messages", query: [URLQueryItem(name: "thread", value: messageId)])
        return page.messages
    }

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await client.get("/chat/sessions/\(escape(sessionId))/messages", query: query)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority, thread: nil)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, thread: ThreadTarget?) async throws -> CreatedTurn {
        var body: [String: JSONValue] = ["text": .string(text), "inputId": .string(inputId), "priority": .string(priority.rawValue)]
        if let thread { body.merge(thread.body) { _, new in new } }
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
        let route = path.hasPrefix("memory/") ? "/memory/asset" : "/projects/asset"
        return try await client.getData(route, query: [URLQueryItem(name: "path", value: path)], limit: APIClient.imageLimit)
    }

    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws {
        let part: JSONValue = .object([
            "type": .string("interaction_result"),
            "toolUseId": .string(toolUseId),
            "output": output,
        ])
        try await client.post("/chat/sessions/\(escape(sessionId))/turns", json: .object(["parts": .array([part])]))
    }

    func markRead(sessionId: String) async {
        _ = try? await client.post("/chat/sessions/\(escape(sessionId))/read")
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

    func tasks() async throws -> [ConciergeTask] {
        let response: ConciergeTasksResponse = try await client.get(
            "/concierge/tasks",
            query: [URLQueryItem(name: "doneDays", value: "30")]
        )
        return response.tasks
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

    func isGuardian() async -> Bool {
        let body: JSONValue? = try? await client.get("/auth/me")
        return body?["kind"]?.string == "guardian"
    }

    func setGuardianLanguage(_ code: String) async throws {
        try await client.put("/settings", json: .object(["guardianLanguage": .string(code)]))
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

    func shareChat(sessionId: String, turnIds: [String]) async throws -> ChatShareLink {
        try await client.post("/chat/sessions/\(escape(sessionId))/share", json: .object(["turnIds": .array(turnIds.map(JSONValue.string))]), as: ChatShareLink.self)
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
    /// Demo data and test doubles belong to no account.
    var account: AccountStamp { .unchecked }

    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply { throw APIError.notFound }
    func connectors() async throws -> [ConnectorState] { [] }
    func agentName() async -> String? { nil }
    func pendingApprovals() async throws -> [PendingApproval] { [] }
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, thread: ThreadTarget?) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority)
    }
    func thread(sessionId: String, messageId: String) async throws -> [ChatMessage] { throw APIError.notFound }
    func routines() async throws -> [RoutineRef] { throw APIError.notFound }
    func notifyServiceConnected(chatId: String, service: String) async {}
    /// Stand-ins (demo, tests) are no guardian of a real instance.
    func isGuardian() async -> Bool { false }
    func setGuardianLanguage(_ code: String) async throws {}
    func apps() async throws -> [InstalledApp] { [] }
    func webSessionCookie() -> HTTPCookie? { nil }
    func shareChat(sessionId: String, turnIds: [String]) async throws -> ChatShareLink { throw APIError.notFound }
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
}

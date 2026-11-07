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
    func resolveApproval(id: String, approve: Bool) async throws
    func toolCalls(traceMessageId: String) async throws -> [ToolCall]
    func aiTools() async throws -> AIToolsStatus
    func setConciergeEnabled(_ enabled: Bool) async throws
    func search(_ query: String) async throws -> [SearchHit]
    /// The guardian's display name on this instance.
    func me() async throws -> String?
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
}

@MainActor
final class LiveBackend: RomeBackend {
    let client: APIClient
    let events: LiveEventSource

    var displayOrigin: String { client.origin.host() ?? client.origin.absoluteString }

    init(client: APIClient) {
        self.client = client
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

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await client.get("/chat/sessions/\(escape(sessionId))/messages", query: query)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        var body: [String: JSONValue] = ["text": .string(text), "inputId": .string(inputId), "priority": .string(priority.rawValue)]
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

    func me() async throws -> String? {
        let body: JSONValue = try await client.get("/auth/me")
        return body["displayName"]?.string ?? body["email"]?.string ?? body["userId"]?.string
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
    /// Stand-ins (demo, tests) are no guardian of a real instance.
    func isGuardian() async -> Bool { false }
    func setGuardianLanguage(_ code: String) async throws {}
    func apps() async throws -> [InstalledApp] { [] }
    func webSessionCookie() -> HTTPCookie? { nil }
}

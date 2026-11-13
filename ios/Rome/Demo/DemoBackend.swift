#if DEBUG
import Foundation
import UIKit

/// Delivers events inside the app, for the demo backend.
@MainActor
final class LocalEventBus: LiveEventSource {
    private var handlers: [UUID: (topic: String, handler: @MainActor (LiveEvent) -> Void)] = [:]

    func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID {
        let token = UUID()
        handlers[token] = (topic, handler)
        return token
    }

    func unsubscribe(_ token: UUID) { handlers[token] = nil }
    func pause() {}
    func resume() {}

    func emit(_ topic: String, _ event: LiveEvent) {
        for entry in handlers.values where entry.topic == topic { entry.handler(event) }
    }
}

/// A Rome that lives in memory, seeded with the design's sample data. Debug
/// builds open it with the `ROME_DEMO=1` environment variable or from the
/// sign-in screen, so every state can be reviewed without a server.
@MainActor
final class DemoBackend: RomeBackend {
    /// Named in the app's language, so an English screen shows no Chinese names.
    static var instances: [CloudInstance] {
        let chinese = Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true
        return [
            CloudInstance(id: "demo-1", name: chinese ? "我的 Rome" : "My Rome", slug: "me", origin: "https://me.romeos.cc", status: "running"),
            CloudInstance(id: "demo-2", name: chinese ? "团队 Rome" : "Team Rome", slug: "team", origin: "https://team.romeos.cc", status: "running", role: "visitor", ownerName: "Dev User"),
            CloudInstance(id: "demo-3", name: chinese ? "测试实例" : "Staging", slug: "staging", origin: "https://staging.romeos.cc", status: "stopped"),
            // A long name and host, to check what a row cuts.
            CloudInstance(id: "demo-4", name: chinese ? "设计工作室的共享 Rome（全体成员）" : "Design studio's shared Rome for everyone", slug: "studio", origin: "https://design-studio-shared-workspace.romeos.cc", status: "running", role: "visitor", ownerName: "Studio Owner"),
        ]
    }

    let displayOrigin = "me.romeos.cc"
    private let bus = LocalEventBus()
    var events: LiveEventSource { bus }

    private var messages: [String: [ChatMessage]] = [:]
    private var chats: [String: ChatSession] = [:]
    private var tasks: [ConciergeTask] = []
    private var topicChats: [ConciergeChat] = []
    /// Files sent with messages, by their asset path.
    private var assets: [String: Data] = [:]
    private var approvals: [String: ApprovalRecord] = [:]
    private var running: [String: String] = [:]
    private var counter = 0
    /// Share links, by chat.
    private var shares: [String: [ChatShareLink]] = [:]

    /// `updateRequired`: the full data on a Rome below the app's minimum, so the
    /// update page shows; "Update now" brings it up to date after a few seconds.
    /// `manyApps`: the full data with a screenful of apps.
    /// `visitor`: the full demo, seen by a dashboard visitor of the shared Rome.
    /// `updateOffered`: a Rome behind its latest release but new enough for
    /// the app, which offers the update instead of requiring it.
    /// `longChat`: the full data with a main chat long enough to page, ending
    /// in a long digest that folds: what a cold launch from kept rows meets.
    enum Variant { case full, empty, conciergeOff, updateRequired, updateOffered, manyApps, visitor, longChat }
    private let variant: Variant

    init(variant: Variant = .full) {
        self.variant = variant
        seed()
        if variant == .empty || variant == .conciergeOff {
            messages[conciergeChatID] = []
            tasks = []
            topicChats = []
        }
        if variant == .longChat { lengthenMainChat() }
    }

    private func lengthenMainChat() {
        let start = Date.now.addingTimeInterval(-2 * 86400)
        var earlier: [ChatMessage] = []
        for index in 0..<60 {
            let at = start.addingTimeInterval(Double(index) * 600)
            earlier.append(user("long-u\(index)", "第 \(index + 1) 个问题：今天有什么要注意的？", at: at))
            earlier.append(agent("第 \(index + 1) 个回答：没有新的安排，照常进行。", at: at.addingTimeInterval(30)))
        }
        let digest = (1...24).map { "\($0). 今天的邮件摘要第 \($0) 条：项目进度、会议时间和需要你回复的事项。" }.joined(separator: "\n")
        messages[conciergeChatID] = earlier + (messages[conciergeChatID] ?? []) + [agent(digest, at: .now.addingTimeInterval(-60))]
    }

    // MARK: RomeBackend

    func conciergeSession() async throws -> ConciergeSessionInfo {
        try await pause(0.25)
        if variant == .conciergeOff { throw APIError.conciergeOff }
        return ConciergeSessionInfo(id: conciergeChatID, unread: 0)
    }

    func conciergeChats() async throws -> [ConciergeChat] {
        try await pause(0.2)
        if variant == .conciergeOff { throw APIError.conciergeOff }
        startActivityCycle()
        return [ConciergeChat(id: conciergeChatID, name: "Main chat", main: true, unread: 0, activity: .working)] + topicChats
    }

    /// The header's states, in turn, so each can be seen on a phone: working,
    /// a tool, running tasks, waiting on the guardian, then idle. The main
    /// chat and the trip topic run it two steps apart. Snapshot runs set
    /// their states themselves.
    private var activityCycle: Task<Void, Never>?

    private func startActivityCycle() {
        guard activityCycle == nil, SnapshotRunner.directory == nil else { return }
        let steps: [(ConciergeActivity, Double)] = [
            (.working, 3), (.tool(.searchingWeb), 3), (.tasks(title: "整理本周会议纪要", more: 1), 4), (.needsYou, 4), (.idle, 4),
        ]
        activityCycle = Task { [weak self] in
            var step = 0
            while !Task.isCancelled {
                guard let self else { return }
                let (main, seconds) = steps[step % steps.count]
                self.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: conciergeChatID, activity: main))
                self.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "topic-trip", activity: steps[(step + 2) % steps.count].0))
                self.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "topic-books", activity: steps[(step + 3) % steps.count].0))
                step += 1
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    func startTopicChat() async throws -> ConciergeChat {
        try await pause(0.3)
        let chat = ConciergeChat(id: "topic-\(nextID())", name: "", main: false, unread: 0)
        topicChats.append(chat)
        messages[chat.id] = []
        return chat
    }

    var origin: URL? { nil }

    /// Asset URLs only, as the instance writes them: `/projects/asset/<name>?path=…`.
    func apiFile(path: String, query: String?) async throws -> Data {
        // App icons are SVG, as apps ship them.
        if let svg = Self.appIcons[path] { return Data(svg.utf8) }
        var components = URLComponents()
        components.percentEncodedQuery = query
        guard path.hasPrefix("/projects/asset") || path.hasPrefix("/memory/asset"),
              let logical = components.queryItems?.first(where: { $0.name == "path" })?.value
        else { throw APIError.notFound }
        return try await asset(path: logical)
    }

    func asset(path: String) async throws -> Data {
        try await pause(0.2)
        guard let data = assets[path] else { throw APIError.notFound }
        return data
    }

    func renameChat(_ id: String, to name: String) async throws {
        try await pause(0.2)
        if let index = topicChats.firstIndex(where: { $0.id == id }) { topicChats[index].name = name }
        bus.emit(LiveTopic.chat(id), .sessionName(sessionId: id, name: name))
    }

    func archiveChat(_ id: String) async throws {
        try await pause(0.2)
        topicChats.removeAll { $0.id == id }
    }

    func deleteChat(_ id: String) async throws {
        try await archiveChat(id)
    }

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        try await pause(0.3)
        // Pages from the newest back, as the server does; the cursor is the
        // oldest message of the page before.
        let all = messages[sessionId] ?? []
        let end = before.flatMap { cursor in all.firstIndex { $0.id == cursor } } ?? all.count
        let start = max(0, end - limit)
        let turned = Self.withTurns(all)
        return MessagePage(messages: Array(turned[start..<end]).map(Self.withThreads), nextCursor: start > 0 ? all[start].id : nil)
    }

    /// Turns the way the server keeps them: each message the guardian writes
    /// starts one, and what follows answers it.
    private static func withTurns(_ messages: [ChatMessage]) -> [ChatMessage] {
        var turn: String?
        return messages.map { message in
            var message = message
            if message.isUser { turn = "turn-\(message.id)" }
            if message.turnId == nil { message.turnId = turn ?? "turn-\(message.id)" }
            return message
        }
    }

    func shareChat(sessionId: String, turnIds: [String], agentName: String?) async throws -> ChatShareLink {
        try await pause(0.4)
        guard !turnIds.isEmpty else { throw APIError.server(status: 400, message: nil) }
        let title = topicChats.first { $0.id == sessionId }?.name ?? String(localized: "Chat")
        let link = ChatShareLink(id: "share-\(nextID())", url: "/share/demo\(nextID())", title: title, createdAt: RomeDate.string(.now))
        shares[sessionId, default: []].insert(link, at: 0)
        return link
    }

    func chatShares(sessionId: String) async throws -> [ChatShareLink] {
        try await pause(0.25)
        return shares[sessionId] ?? []
    }

    func revokeShare(id: String) async throws {
        try await pause(0.2)
        for key in shares.keys { shares[key]?.removeAll { $0.id == id } }
    }

    /// The demo is an instance with chat threads: every message says its thread.
    private static func withThreads(_ message: ChatMessage) -> ChatMessage {
        var message = message
        message.knowsThreads = true
        return message
    }


    func thread(sessionId: String, messageId: String) async throws -> [ChatMessage] {
        try await pause(0.25)
        let all = messages[sessionId] ?? []
        guard let anchor = all.first(where: { $0.id == messageId }) else { throw APIError.notFound }
        let root = anchor.chatThreadId ?? anchor.id
        return all.filter { !$0.isTrace && ($0.chatThreadId == root || $0.id == anchor.id) }.map(Self.withThreads)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority, thread: nil)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, thread target: ThreadTarget?) async throws -> CreatedTurn {
        try await pause(0.35)
        if text.contains("失败") || text.lowercased().contains("fail") { throw APIError.network }
        // Stored the way the server stores it: a line per file after the text.
        let lines = files.enumerated().map { index, file in
            let path = "projects/demo/\(inputId)/\(file.name)"
            assets[path] = Data(base64Encoded: file.dataBase64)
            return "- File \(index + 1): [\(file.name)](</\(path)>)"
        }
        let stored = ([text] + (lines.isEmpty ? [] : [lines.joined(separator: "\n")])).filter { !$0.isEmpty }.joined(separator: "\n\n")
        // A send from a chat thread lands in it, and so does the answer.
        let thread = target.flatMap { target in (messages[sessionId] ?? []).first { $0.id == target.messageId } }.map { $0.chatThreadId ?? $0.id }
        if let thread, let index = messages[sessionId]?.firstIndex(where: { $0.id == thread }), messages[sessionId]?[index].chatThreadId == nil {
            // A message alone starts the thread the reply opens.
            messages[sessionId]?[index].chatThreadId = thread
            bus.emit(LiveTopic.chat(sessionId), .messageThread(sessionId: sessionId, messageId: thread, chatThreadId: thread))
        }
        insert(sessionId, threaded(user(inputId, stored, at: .now, session: sessionId), thread))
        if let thread { bus.emit(LiveTopic.chat(sessionId), .messageThread(sessionId: sessionId, messageId: inputId, chatThreadId: thread)) }
        let turnId = "turn-\(nextID())"
        setRunning(sessionId, turnId)
        let topic = topicChats.firstIndex { $0.id == sessionId }
        let concierge = sessionId == conciergeChatID || topic != nil
        Task {
            try? await pause(concierge ? 1.8 : 3.5)
            if concierge {
                insert(sessionId, threaded(agent("好，我记下了。", at: .now, session: sessionId), thread))
                try? await pause(0.7)
                insert(sessionId, threaded(agent("需要开任务的话，我会把它放进任务里，做完告诉你。", at: .now, session: sessionId), thread))
                // An untitled topic chat is named from its first message.
                if let topic, topicChats[topic].name.isEmpty {
                    let name = String(text.prefix(16))
                    topicChats[topic].name = name
                    bus.emit(LiveTopic.chat(sessionId), .sessionName(sessionId: sessionId, name: name))
                }
            } else {
                // A task turn streams a few replies of mixed length, so scrolling
                // during a running turn can be tried. Stop ends it early.
                for (index, text) in Self.taskReplies.enumerated() where running[sessionId] == turnId {
                    if index > 0 { try? await pause(1.4) }
                    guard running[sessionId] == turnId else { break }
                    insert(sessionId, agent(text, at: .now, session: sessionId, long: text.count > 60))
                }
                if running[sessionId] == turnId {
                    insert(sessionId, trace(steps: Self.taskReplies.count, at: .now, session: sessionId))
                }
            }
            if running[sessionId] == turnId { setRunning(sessionId, nil) }
        }
        return CreatedTurn(turnId: turnId, inputId: inputId, disposition: "started")
    }

    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws {
        try await pause(0.4)
        let part: JSONValue = .object(["type": .string("interaction_result"), "toolUseId": .string(toolUseId), "output": output])
        insert(sessionId, ChatMessage(id: nextID(), sessionId: sessionId, role: "user", content: json([part]), createdAt: RomeDate.string(.now)))
        setRunning(sessionId, "turn-\(nextID())")
        Task {
            try? await pause(3)
            let reply = toolUseId == "q-hk" ? "好，我查一下海口明天的天气。" : "好的，只看国内产品。我整理好表格后告诉你。"
            insert(sessionId, agent(reply, at: .now, session: sessionId))
            setRunning(sessionId, nil)
        }
    }

    func markRead(sessionId: String) async {}

    func sessions() async throws -> [ChatSession] {
        Array(chats.values)
    }

    func activeTurns(sessionId: String) async throws -> [ActiveTurn] {
        running[sessionId].map { [ActiveTurn(turnId: $0, status: "running", quiet: false)] } ?? []
    }

    func interrupt(turnId: String) async throws {
        try await pause(0.5)
        if let session = running.first(where: { $0.value == turnId })?.key {
            setRunning(session, nil)
        }
    }

    func tasks() async throws -> [ConciergeTask] {
        try await pause(0.2)
        return tasks
    }

    /// The demo's task list: its tasks in the groups their status gives
    /// them, with a schedule, a lone check, a follow and a routine.
    func taskList(chatId: String) async throws -> TaskListResponse {
        try await pause(0.2)
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        let chat = chatId == conciergeChatID ? nil : chatId
        var groups: [TaskListGroup.Key: [TaskListItem]] = [:]
        for task in tasks where task.archivedAt == nil && task.conciergeChat?.id == chat {
            let status = TaskListWords.status(task)
            // Where Respond goes: the message of this chat with the card it waits on.
            let card = task.waitId.flatMap { wait in
                messages[chatId]?.first { message in
                    message.parts.contains { if case .taskChat(_, _, _, let card) = $0 { return card?.id == wait } else { return false } }
                }?.id
            }
            var task = task
            if status == "needs_you" { task.waitingSince = task.updatedAt }
            let item = TaskListItem.Task(
                task: task,
                schedule: task.id == "t7" ? .init(at: "09:00", days: nil) : nil,
                check: task.dueAt.map { .init(id: "check-\(task.id)", at: $0, recurring: task.id == "t7") },
                cardMessageId: status == "needs_you" ? card : nil
            )
            let key: TaskListGroup.Key = switch status {
            case "needs_you": .needsYou
            case "later": .later
            case "ended": .ended
            default: .active
            }
            groups[key, default: []].append(.task(item))
        }
        if chat == nil {
            groups[.later, default: []].append(.check(.init(check: .init(id: "check-flight", name: "看看机票有没有降价", at: nowMs + 3 * 3_600_000, waitingFor: nil))))
            groups[.onItsOwn, default: []] += [
                .follow(.init(source: "github", label: "GitHub", target: "rome-os/rome", state: "active", digestTimes: ["09:00", "18:00"])),
                .routine(.init(id: "r-summary", name: "每日总结", trigger: .init(type: "schedule", localTime: "21:00", rrule: "FREQ=DAILY"), enabled: true, nextRunAt: nowMs + 5 * 3_600_000, lastRun: nil)),
            ]
        }
        let order: [TaskListGroup.Key] = [.needsYou, .active, .later, .onItsOwn, .ended]
        return TaskListResponse(chatId: chatId, groups: order.compactMap { key in groups[key].map { TaskListGroup(key: key, items: $0) } })
    }

    /// Stops a demo task: it ends as stopped, and its list reads again.
    func stopListedTask(chatId: String, taskId: String) async throws {
        try await pause(0.4)
        guard let index = tasks.firstIndex(where: { $0.id == taskId }) else { throw APIError.notFound }
        tasks[index].status = "ended"
        tasks[index].endReason = "stopped"
        tasks[index].state = .dropped
        tasks[index].completedAt = Date.now.timeIntervalSince1970 * 1000
        tasks[index].updatedAt = tasks[index].completedAt!
        bus.emit(LiveTopic.chatTasks(chatId), .taskListChanged(chatId: chatId))
    }

    func approval(id: String) async throws -> ApprovalRecord {
        try await pause(0.2)
        return approvals[id] ?? ApprovalRecord(id: id, status: "pending")
    }

    /// Approvals still pending, from the cards the demo's chats hold.
    func pendingApprovals() async throws -> [PendingApproval] {
        try await pause(0.2)
        return messages.flatMap { chatId, list in
            list.flatMap { message in
                message.parts.compactMap { part -> PendingApproval? in
                    guard case .approval(let approval) = part,
                          ApprovalStatus.derive(stored: "pending", record: approvals[approval.approvalId]) == .pending
                    else { return nil }
                    return PendingApproval(id: approval.approvalId, chatId: chatId, part: approval, createdAt: message.date)
                }
            }
        }
    }

    func resolveApproval(id: String, approve: Bool) async throws {
        try await pause(0.9)
        approvals[id] = ApprovalRecord(id: id, status: approve ? "approved" : "rejected", executionState: approve ? "running" : nil, resolvedAt: RomeDate.string(.now))
        if approve {
            Task {
                try? await pause(1.5)
                approvals[id]?.executionState = "succeeded"
                if let index = tasks.firstIndex(where: { $0.chat?.id == "chat-price" }) {
                    tasks[index].state = .done
                    tasks[index].updatedAt = Date.now.timeIntervalSince1970 * 1000
                    tasks[index].completedAt = tasks[index].updatedAt
                    bus.emit(LiveTopic.conciergeTasks, .taskUpsert(tasks[index]))
                }
            }
        }
    }

    func toolCalls(traceMessageId: String) async throws -> [ToolCall] {
        try await pause(0.4)
        return [
            ToolCall(id: "1", name: "web_fetch", detail: "降噪耳机商品页", input: .object(["url": .string("https://shop.example.com/headphones")])),
            ToolCall(id: "2", name: "web_fetch", detail: "另外两个商品页", input: .object(["url": .string("https://shop.example.com/compare")])),
            ToolCall(id: "3", name: "compare_price", detail: "目标价 ¥950", input: .object(["target": .number(950)])),
        ]
    }

    func aiTools() async throws -> AIToolsStatus {
        let now = Date.now
        return AIToolsStatus(
            claude: .init(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 62, resetsAt: RomeDate.string(now.addingTimeInterval(3 * 3600))), sevenDay: nil)),
            codex: .init(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 12, resetsAt: nil), sevenDay: .init(usedPercent: 30, resetsAt: RomeDate.string(now.addingTimeInterval(5 * 86_400)))))
        )
    }

    func setConciergeEnabled(_ enabled: Bool) async throws {}

    func search(_ query: String) async throws -> [SearchHit] {
        try await pause(0.3)
        var hits: [SearchHit] = []
        for (sessionId, list) in messages {
            for message in list where !message.isTrace {
                let text = message.parts.compactMap(\.textContent).joined(separator: " ")
                guard text.localizedCaseInsensitiveContains(query) else { continue }
                let session = chats[sessionId] ?? ChatSession(id: sessionId, name: "Chat")
                hits.append(SearchHit(session: session, message: .init(id: message.id, role: message.role, snippet: text, createdAt: message.createdAt)))
            }
        }
        return hits.sorted { $0.message.createdAt > $1.message.createdAt }
    }

    /// The demo's Concierge goes by a name of its own.
    func agentName() async -> String? { "Milo" }

    /// A visitor is known by a long email, to check what Settings cuts.
    func me() async throws -> AccountIdentity? {
        variant == .visitor
            ? AccountIdentity(name: "lin.wei.visiting.designer@studio-example.com", isGuardian: false)
            : AccountIdentity(name: "Lin")
    }

    func isGuardian() async -> Bool { variant != .visitor }

    func apps() async throws -> [InstalledApp] {
        try await pause(0.3)
        let few = [
            InstalledApp(id: "habits", displayName: "习惯打卡", description: "每天的小目标，连着打卡", iconUrl: "/api/apps/habits/icon", fullHref: "/full/apps/habits", origin: "local"),
            InstalledApp(id: "packing", displayName: "Trip packing list", description: "What to bring to Kyoto, checked off as it goes in the bag", iconUrl: "/api/apps/packing/icon", fullHref: "/full/apps/packing", origin: "appstore"),
            // Not running: it stays in the grid, dimmed.
            InstalledApp(id: "reading", displayName: "Reading log", fullHref: nil, origin: "local", status: "stopped"),
            InstalledApp(id: "browser-automation", displayName: "Browser", description: "Ships with Rome", fullHref: "/full/apps/browser-automation", origin: "builtin"),
        ]
        switch variant {
        case .full, .visitor, .updateOffered, .longChat:
            return few
        case .manyApps:
            let names = ["记账本", "Recipes", "Workout plan", "家庭相册", "Plant care", "Budget", "单词卡片", "Meal planner",
                         "Kyoto trip", "Movie night", "读书笔记", "Garden", "Chores", "Gift ideas", "Running log", "A very long app name that cuts"]
            return few + names.enumerated().map { index, name in
                InstalledApp(id: "app-\(index)", displayName: name, fullHref: "/full/apps/app-\(index)", origin: "local")
            }
        case .empty, .conciergeOff, .updateRequired:
            return []
        }
    }

    /// Self-painted SVG tiles, as the coding app's guide asks apps to ship.
    static let appIcons: [String: String] = [
        "/apps/habits/icon": ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="#e3efe0"/><g transform="translate(4.56 4.56) scale(0.62)" fill="none" stroke="#2f5a2a" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8.5 14.5l2.2 2.2 4.8-4.8"/></g></svg>"##,
        "/apps/packing/icon": ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="#dfe8f5"/><g transform="translate(4.56 4.56) scale(0.62)" fill="none" stroke="#1f3f6e" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><rect x="4" y="7" width="16" height="13" rx="2.5"/><path d="M9 7V4.5h6V7M4 12h16"/></g></svg>"##,
    ]

    // MARK: Connect cards

    /// Services connected so far; GitHub is from the start.
    private var connected: [String: String] = ["github": "lin-dev"]

    func routines() async throws -> [RoutineRef] {
        if variant == .visitor { throw APIError.server(status: 403, message: nil) }
        return [RoutineRef(id: "r-books", name: "每周读书小结", key: "chat-routine:books", enabled: true)]
    }

    func connectors() async throws -> [ConnectorState] {
        try await pause(0.2)
        return ["gmail", "github", "notion", "linear", "slack"].map { service in
            ConnectorState(service: service, state: connected[service] == nil ? nil : "working", account: connected[service])
        }
    }

    func connectCall(method: String, apiPath: String, body: JSONValue?) async throws -> ConnectReply {
        try await pause(0.4)
        // The demo's broker: the service is connected a few seconds after the link opens.
        guard let provider = body?["provider"]?.string else { return ConnectReply(ok: false, body: .object(["message": .string("No provider")])) }
        Task {
            try? await Task.sleep(for: .seconds(4))
            connected[provider] = "lin@example.com"
        }
        return ConnectReply(ok: true, body: .object(["redirectUrl": .string("https://example.com/connect/\(provider)")]))
    }

    /// The meal planner app's API, for its card in `topic-meals`.
    func appCall(appId: String, method: String, path: String, body: JSONValue?) async throws -> ConnectReply {
        try await pause(0.3)
        guard appId == "meal-planner" else { return ConnectReply(ok: false, body: .object([:])) }
        if method == "POST", path == "water" { glasses += 1 }
        return ConnectReply(ok: true, body: .object([
            "calories": .number(1240), "goal": .number(2000), "water": .number(Double(glasses)),
            "meals": .array([
                .object(["name": .string("燕麦粥和蓝莓"), "calories": .string("320 千卡")]),
                .object(["name": .string("牛肉面"), "calories": .string("680 千卡")]),
                .object(["name": .string("拿铁"), "calories": .string("240 千卡")]),
            ]),
        ]))
    }

    private var glasses = 3


    static let mealCard: JSONValue = {
        func c(_ id: String, _ kind: String, _ props: [String: JSONValue]) -> JSONValue {
            .object(props.merging(["id": .string(id), "component": .string(kind)]) { a, _ in a })
        }
        let path = { (p: String) in JSONValue.object(["path": .string(p)]) }
        let ids = { (list: [String]) in JSONValue.array(list.map(JSONValue.string)) }
        return .object([
            "type": .string("widget"), "toolUseId": .string("meal-1"), "appId": .string("meal-planner"),
            "text": .string("今天的饮食记录"),
            "bind": .object(["/today": .string("days/today")]),
            "ui": .object(["components": .array([
                c("root", "Column", ["children": ids(["title", "stats", "goal", "meals", "water"])]),
                c("title", "Text", ["text": .string("今天的饮食"), "variant": .string("h3")]),
                c("stats", "Row", ["children": ids(["kcal", "cups"]), "justify": .string("spaceBetween")]),
                c("kcal", "Stat", ["label": .string("热量"), "value": path("/today/calories"), "unit": .string("千卡")]),
                c("cups", "Stat", ["label": .string("喝水"), "value": path("/today/water"), "unit": .string("杯")]),
                c("goal", "Progress", ["label": .string("每日目标 2,000 千卡"), "value": path("/today/calories"), "max": path("/today/goal")]),
                c("meals", "List", ["children": .object(["componentId": .string("meal"), "path": .string("/today/meals")])]),
                c("meal", "Row", ["children": ids(["meal-name", "meal-kcal"]), "justify": .string("spaceBetween")]),
                c("meal-name", "Text", ["text": path("name")]),
                c("meal-kcal", "Text", ["text": path("calories"), "variant": .string("caption")]),
                c("water", "Button", ["child": .string("water-label"), "action": .object(["event": .object(["name": .string("water")])])]),
                c("water-label", "Text", ["text": .string("喝了一杯水")]),
            ])]),
        ])
    }()

    func sendFeedback(_ text: String) async throws {
        try await pause(0.8)
    }

    // MARK: Helpers

    // MARK: Updates

    static let releasedVersion = "1.1.192"
    /// Below the app's minimum, and between it and the latest.
    static let tooOldVersion = "1.1.120"
    static let offeredFromVersion = "1.1.191"
    private lazy var runningVersion = switch variant {
    case .updateRequired: Self.tooOldVersion
    case .updateOffered: Self.offeredFromVersion
    default: Self.releasedVersion
    }
    private var upgradeDoneAt: Date?

    func upgradeCheck() async throws -> UpgradeCheck {
        try await pause(0.3)
        return UpgradeCheck(
            current: .init(version: runningVersion, sha: "demo"),
            latest: .init(version: Self.releasedVersion),
            upgradeAvailable: runningVersion != Self.releasedVersion
        )
    }

    func startUpgrade(target: String) async throws -> UpgradeStarted {
        try await pause(0.6)
        upgradeDoneAt = .now.addingTimeInterval(8)
        return UpgradeStarted(status: "started", target: target)
    }

    func buildInfo() async throws -> BuildInfo {
        try await pause(0.2)
        if let done = upgradeDoneAt {
            // The instance restarts: no answer until it is back on the target.
            guard Date.now >= done else { throw APIError.network }
            runningVersion = Self.releasedVersion
            upgradeDoneAt = nil
        }
        return BuildInfo(version: runningVersion, sha: "demo")
    }

    private func pause(_ seconds: Double) async throws {
        try await Task.sleep(for: .seconds(seconds))
    }

    private func nextID() -> String {
        counter += 1
        return "demo-\(counter)"
    }

    private func insert(_ sessionId: String, _ message: ChatMessage) {
        let message = Self.withThreads(Self.withTurns((messages[sessionId] ?? []) + [message]).last ?? message)
        messages[sessionId, default: []].append(message)
        bus.emit(LiveTopic.chat(sessionId), .messageInsert(message))
    }

    private func setRunning(_ sessionId: String, _ turnId: String?) {
        running[sessionId] = turnId
        chats[sessionId]?.running = turnId != nil
        let event = LiveEvent.sessionRunning(sessionId: sessionId, running: turnId != nil)
        bus.emit(LiveTopic.chatStatus, event)
        bus.emit(LiveTopic.chat(sessionId), event)
    }

    private func json(_ parts: [JSONValue]) -> String {
        String(data: (try? JSONEncoder().encode(parts)) ?? Data(), encoding: .utf8) ?? "[]"
    }

    /// A guardian-side message said by the Concierge, as the instance marks it.
    private func saidByConcierge(_ message: ChatMessage) -> ChatMessage {
        var message = message
        message.sender = MessageSender(kind: "automated", sourceType: "agent", name: "Milo", onBehalfOf: nil)
        return message
    }

    /// The message, placed in the chat thread that starts at `root`: a
    /// task's thread, named by the task's title, as the server sends it.
    private func threaded(_ message: ChatMessage, _ root: String?, _ title: String? = nil) -> ChatMessage {
        var message = message
        message.chatThreadId = root
        message.chatThreadTitle = root == nil ? nil : (title ?? threadTitles[root!])
        message.knowsThreads = true
        return message
    }

    /// The title of the task each demo chat thread is, by its root.
    private var threadTitles: [String: String] = [:]

    /// The guardian's reply to a message, with its quote, as the server stores it.
    private func reply(_ id: String, _ text: String, to original: String, quoting: String, at date: Date, session: String) -> ChatMessage {
        ChatMessage(id: id, sessionId: session, role: "user", content: json([
            .object(["type": .string("reply_to"), "messageId": .string(original), "author": .string("agent"), "text": .string(quoting)]),
            .object(["type": .string("text"), "content": .string(text)]),
        ]), createdAt: RomeDate.string(date))
    }

    private func taskPart(_ chatId: String, _ title: String, show: String, card: JSONValue? = nil, at date: Date, session: String = conciergeChatID) -> ChatMessage {
        var part: [String: JSONValue] = ["type": .string("task_chat"), "chatId": .string(chatId), "title": .string(title), "show": .string(show)]
        // The instance fills in the card of a part that shows one.
        if let card { part["card"] = card }
        return parts([.object(part)], at: date, session: session)
    }

    /// A task's question as its card carries it, with the outcome it ended in.
    private func questionCard(_ id: String, _ question: String, options: [String], expired: Bool = false, answered: String? = nil, since: Date) -> JSONValue {
        var card: [String: JSONValue] = [
            "kind": .string("question"), "id": .string(id), "messageId": .string("m-\(id)"),
            "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "props": .object(["questions": .array([
                .object(["id": .string("q"), "question": .string(question), "type": .string("single"), "options": .array(options.map { .string($0) })]),
            ])])]),
            "since": .number(since.timeIntervalSince1970 * 1000), "expired": .bool(expired),
        ]
        if let answered {
            card["outcome"] = .object(["kind": .string("answered"), "answer": .object(["text": .string(answered), "output": .object(["answers": .array([.object(["questionId": .string("q"), "value": .string(answered)])])])])])
        }
        return .object(card)
    }

    private func approvalCard(_ id: String, _ title: String, outcome: String? = nil, since: Date) -> JSONValue {
        var card: [String: JSONValue] = [
            "kind": .string("approval"), "id": .string(id), "title": .string(title), "actionName": .string("system:send_email"),
            "preview": .object(["kind": .string("generic"), "title": .string(title), "summary": .string(""), "fields": .array([
                .object(["label": .string("收件人"), "value": .string("lin@example.com")]),
            ])]),
            "since": .number(since.timeIntervalSince1970 * 1000),
        ]
        if let outcome { card["outcome"] = .object(["kind": .string(outcome)]) }
        return .object(card)
    }

    private func user(_ id: String, _ text: String, at date: Date, session: String = conciergeChatID) -> ChatMessage {
        ChatMessage(id: id, sessionId: session, role: "user", content: json([.object(["type": .string("text"), "content": .string(text)])]), createdAt: RomeDate.string(date))
    }

    private func agent(_ text: String, at date: Date, session: String = conciergeChatID, long: Bool = false, id: String? = nil) -> ChatMessage {
        var part: [String: JSONValue] = ["type": .string("text"), "content": .string(text)]
        if long { part["format"] = .string("long") }
        return ChatMessage(id: id ?? nextID(), sessionId: session, role: "assistant", content: json([.object(part)]), createdAt: RomeDate.string(date))
    }

    private func parts(_ parts: [JSONValue], at date: Date, session: String, role: String = "assistant") -> ChatMessage {
        ChatMessage(id: nextID(), sessionId: session, role: role, content: json(parts), createdAt: RomeDate.string(date))
    }

    private func trace(steps: Int, at date: Date, session: String) -> ChatMessage {
        ChatMessage(id: nextID(), sessionId: session, role: "trace", content: "[]", createdAt: RomeDate.string(date), traceSummary: TraceSummary(totalSteps: steps, turnStatus: "completed"))
    }

    private static let taskReplies = [
        "收到，我按这个继续。",
        """
        先看了现有的页面结构，要改的地方有三处：

        1. 首页 Hero 区的标题和副标题
        2. 功能卡片的说明文字
        3. 页脚的联系方式和版权
        """,
        "Hero 标题译好了。",
        """
        功能卡片的英文稿：

        - **Fast setup**: one command, and Rome runs on your machine.
        - **Your data stays yours**: everything is stored locally.
        - **Apps that grow**: install or build apps as your needs change.
        """,
        "页脚也改好了，正在核对链接。",
        """
        链接都能打开。最后检查了一遍深色模式下的排版，英文比中文长，两张卡片的标题会换行，我把字号调小了一档，现在三张卡片高度一致。
        """,
        "全部完成，翻译稿在 `content/home.en.md`。",
    ]

    // MARK: Seed

    private func seed() {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        func at(_ hour: Int, _ minute: Int, daysAgo: Int = 0) -> Date {
            calendar.date(byAdding: .day, value: -daysAgo, to: today)!.addingTimeInterval(Double(hour * 3600 + minute * 60))
        }
        let nowMs = Date.now.timeIntervalSince1970 * 1000

        chats = [
            "chat-price": ChatSession(id: "chat-price", name: "价格追踪：发提醒邮件", triggerKind: "concierge", running: false, lastTurnFailed: false, awaitingGuardian: true),
            "chat-research": ChatSession(id: "chat-research", name: "竞品定价调研", triggerKind: "concierge", running: false, lastTurnFailed: false, awaitingGuardian: true),
            "chat-site": ChatSession(id: "chat-site", name: "官网首页双语文案", triggerKind: "concierge", running: true, lastTurnFailed: false, awaitingGuardian: false),
            "chat-notes": ChatSession(id: "chat-notes", name: "整理本周会议纪要", triggerKind: "concierge", running: true, lastTurnFailed: false, awaitingGuardian: false),
            "chat-notion": ChatSession(id: "chat-notion", name: "同步 Notion 数据库：把客户、订单和每周报告三张表合到一起", triggerKind: "concierge", running: false, lastTurnFailed: true, awaitingGuardian: false),
            "chat-login": ChatSession(id: "chat-login", name: "修复登录页样式", triggerKind: "concierge", running: false, lastTurnFailed: false, awaitingGuardian: false),
        ]
        running = ["chat-site": "turn-site", "chat-notes": "turn-notes"]
        shares = ["topic-trip": [
            ChatShareLink(id: "share-trip", url: "/share/demo-trip", title: "京都旅行计划", createdAt: RomeDate.string(.now.addingTimeInterval(-2 * 3600))),
            ChatShareLink(id: "share-weather", url: "/share/demo-weather", title: "四月京都天气", createdAt: RomeDate.string(at(21, 5, daysAgo: 3))),
        ]]

        topicChats = [
            ConciergeChat(id: "topic-trip", name: "京都旅行计划", main: false, unread: 2),
            ConciergeChat(id: "topic-home", name: "家里装修：厨房翻新、浴室防水和客厅灯具的预算与师傅安排", main: false, unread: 0),
            ConciergeChat(id: "topic-meals", name: "今天吃了什么", main: false, unread: 0),
            ConciergeChat(id: "topic-books", name: "读书笔记", main: false, unread: 0),
            ConciergeChat(id: "topic-mail", name: "每天的邮件摘要", main: false, unread: 0),
            ConciergeChat(id: "topic-mail-setup", name: "邮件摘要设置", main: false, unread: 0),
            ConciergeChat(id: "topic-routine", name: "每周读书提醒", main: false, unread: 0),
            ConciergeChat(id: "topic-table", name: "耳机比价", main: false, unread: 0),
            ConciergeChat(id: "topic-errors", name: "出错的情况", main: false, unread: 0),
        ]

        func task(_ id: String, _ title: String, _ state: TaskState, chat: String?, from topic: String? = nil, summary: String? = nil, waitingOn: String? = nil, minutesAgo: Double, due: Double? = nil, done: Bool = false, root: String? = nil, status: String? = nil, endReason: String? = nil, wait: JSONValue? = nil) -> ConciergeTask {
            let updated = nowMs - minutesAgo * 60_000
            return ConciergeTask(
                id: id, title: title, state: state, summary: summary, waitingOn: waitingOn,
                dueAt: due.map { nowMs + $0 * 60_000 }, rank: nil,
                chat: chat.map { .init(id: $0, name: chats[$0]?.name ?? title) },
                conciergeChat: topic.flatMap { id in topicChats.first { $0.id == id } },
                sourceMessageId: nil, createdAt: updated - 3_600_000, updatedAt: updated,
                completedAt: done ? updated : nil, archivedAt: nil, notSynced: false,
                threadRoot: root, status: status, endReason: endReason, openWait: wait
            )
        }
        tasks = [
            task("t1", "价格追踪：发提醒邮件", .needsUser, chat: "chat-price", waitingOn: "需要批准发送邮件", minutesAgo: 10, root: "c-price", status: "needs_you", wait: .object(["kind": .string("approval"), "id": .string("ap-1"), "since": .number(nowMs - 10 * 60_000)])),
            // Its question waited more than a day: it ended for no response.
            task("t2", "竞品定价调研", .done, chat: "chat-research", waitingOn: "在等你回答调研范围", minutesAgo: 25, root: "c-research", status: "ended", endReason: "no_response"),
            task("t3", "官网首页双语文案", .doing, chat: "chat-site", summary: "正在逐段翻译首页文案", minutesAgo: 2, root: "c-site", status: "active"),
            task("t4", "整理本周会议纪要", .doing, chat: "chat-notes", summary: "已读完 3 份纪要", minutesAgo: 8),
            task("t5", "同步 Notion 数据库", .doing, chat: "chat-notion", summary: "Notion 连接已过期", minutesAgo: 60 * 15),
            task("t6", "每周一整理周报", .next, chat: nil, summary: "下周一早上开始", minutesAgo: 120, due: 60 * 30),
            task("t7", "盯着降噪耳机价格", .watching, chat: nil, summary: "每天早上 9 点检查一次", minutesAgo: 300, due: 60 * 14),
            task("t8", "修复登录页样式", .done, chat: "chat-login", summary: "按钮间距和深色模式都改好了", minutesAgo: 60 * 24 * 3, done: true, root: "c-login", status: "ended", endReason: "done"),
            task("t9", "比较京都三家酒店", .doing, chat: nil, from: "topic-trip", summary: "正在看评价和价格", minutesAgo: 6, root: "k1", status: "active"),
        ]

        // A topic chat about one trip.
        let hotel = "projects/demo/trip/hotel.jpg"
        assets[hotel] = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 520)).image { context in
            UIColor(red: 0.62, green: 0.74, blue: 0.86, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 520))
            UIColor(red: 0.55, green: 0.38, blue: 0.28, alpha: 1).setFill()
            context.fill(CGRect(x: 160, y: 180, width: 480, height: 340))
            UIColor(red: 0.95, green: 0.88, blue: 0.7, alpha: 1).setFill()
            for row in 0..<3 { for column in 0..<5 { context.fill(CGRect(x: 200 + column * 85, y: 220 + row * 95, width: 50, height: 60)) } }
        }.jpegData(compressionQuality: 0.8)
        // A long chat, to scroll far from the bottom.
        // The last eight chapters are one long chat thread, taller than the
        // screen: its root, chapter 17's question, carries the replies line.
        threadTitles = [
            "b16": "读书笔记：第 17–24 章", "k1": "比较京都三家酒店",
            "c-site": "官网首页双语文案", "c-price": "价格追踪：发提醒邮件", "c-research": "竞品定价调研", "c-login": "修复登录页样式",
        ]
        messages["topic-books"] = (0..<24).flatMap { index -> [ChatMessage] in
            let time = at(8, 0, daysAgo: 1).addingTimeInterval(Double(index) * 600)
            let root: String? = index >= 16 ? "b16" : nil
            return [
                threaded(user("b\(index)", "第 \(index + 1) 章讲了什么？", at: time, session: "topic-books"), root),
                // The last answer opens with bold that closes after `。`.
                threaded(agent(index == 23
                    ? "**第 24 章的重点：先把大问题拆小。**每个小问题都能在一天内做完，然后用一个简单的清单跟踪进度。"
                    : "第 \(index + 1) 章讲的是作者怎么把一个大问题拆成几个小问题，每个小问题都能在一天内做完，然后用一个简单的清单跟踪进度。", at: time.addingTimeInterval(30), session: "topic-books"), root),
            ]
        }
        // One task's chat thread among messages in none: the plan's task
        // came back into the thread of the message that started it, so its
        // Concierge messages carry its label. The weather's question and
        // answer are in no thread. The last word is a reply to the hotel
        // message, in the thread, with its quote.
        messages["topic-trip"] = [
            threaded(user("k1", "四月去京都五天，帮我排个行程。", at: at(8, 50), session: "topic-trip"), "k1"),
            threaded(agent("好。先定住处：我比较三家酒店的位置和价格，再按区域排每天的行程。", at: at(8, 51), session: "topic-trip"), "k1"),
            threaded(user("k4", "顺便看下四月京都的天气。", at: at(8, 58), session: "topic-trip"), nil),
            threaded(agent("四月白天 15–20 度，早晚凉，带件外套。月初樱花还在。", at: at(8, 59), session: "topic-trip"), nil),
            threaded(agent("酒店比较好了：河原町那家离车站最近，价格中等。\n\n![河原町酒店外观](/api/projects/asset/hotel.jpg?path=projects%2Fdemo%2Ftrip%2Fhotel.jpg)\n\n要我按它来排吗？", at: at(9, 20), session: "topic-trip", id: "k5"), "k1"),
            threaded(reply("k6", "就按它排。", to: "k5", quoting: "酒店比较好了：河原町那家离车站最近，价格中等。", at: at(9, 24), session: "topic-trip"), "k1"),
        ]
        // A photo the guardian sent, stored the way the server stores it, and a long reply.
        let kitchen = "projects/demo/home/kitchen.jpg"
        assets[kitchen] = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 450)).image { context in
            UIColor(red: 0.85, green: 0.72, blue: 0.55, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 600, height: 450))
            UIColor(red: 0.45, green: 0.32, blue: 0.22, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 300, width: 600, height: 150))
        }.jpegData(compressionQuality: 0.8)
        messages["topic-home"] = [
            user("h1", "厨房翻新，记下要找的师傅。\n\n- File 1: [kitchen.jpg](</\(kitchen)>)", at: at(20, 10, daysAgo: 1), session: "topic-home"),
            agent((1...20).map { "\($0). 第 \($0) 步：量好尺寸，确认材料和师傅的时间。" }.joined(separator: "\n"), at: at(20, 11, daysAgo: 1), session: "topic-home"),
        ]

        // A card the meal planner app described as data, drawn natively.
        messages["topic-meals"] = [
            user("m1", "我今天吃了多少？", at: at(12, 40), session: "topic-meals"),
            parts([Self.mealCard], at: at(12, 41), session: "topic-meals"),
            agent("到现在 1,240 千卡，离目标还差 760。晚饭可以吃点蛋白质多的。", at: at(12, 41).addingTimeInterval(2), session: "topic-meals"),
        ]

        // Concierge, as on the design's Chat board.
        // The chat's session was renewed before the weather question, with a
        // handoff; then a routine sent its summary in, which shows
        // only as a line, then the Concierge's answer (rome-os/rome#2076, #2088).
        var renewed = trace(steps: 0, at: at(9, 52), session: conciergeChatID)
        renewed.turnId = "turn-c3"
        renewed.traceSummary?.sessionRenewal = TraceSummary.SessionRenewal(reason: "context", sessionId: "demo-session-2")
        var routineRun = trace(steps: 1, at: at(9, 58), session: conciergeChatID)
        routineRun.turnId = "turn-routine"
        routineRun.traceSummary?.automatedInput = TraceSummary.InputSource(type: "routine", name: "每日摘要")
        var routineAnswer = agent("今天的摘要：两个任务在等你，一个在跑。", at: at(9, 58).addingTimeInterval(5))
        routineAnswer.turnId = "turn-routine"
        // What the Concierge follows speaks on its own too: an important event, and the digest.
        var followRun = trace(steps: 0, at: at(10, 5), session: conciergeChatID)
        followRun.turnId = "turn-follow"
        followRun.traceSummary?.automatedInput = TraceSummary.InputSource(type: "following", name: "Gmail")
        var followAnswer = agent("出版社回信了，说书稿下周一前可以看。", at: at(10, 5).addingTimeInterval(5))
        followAnswer.turnId = "turn-follow"
        var digestRun = trace(steps: 0, at: at(10, 20), session: conciergeChatID)
        digestRun.turnId = "turn-digest"
        digestRun.traceSummary?.automatedInput = TraceSummary.InputSource(type: "digest", name: nil)
        var digestAnswer = agent("今天的摘要：三封邮件，一个日程。", at: at(10, 20).addingTimeInterval(5))
        digestAnswer.turnId = "turn-digest"
        // Each task's messages are in its chat thread, labelled with the
        // task: a task card when it starts, its question or approval on its
        // own when it asks. The login task's cards are settled and fold; the
        // research question expired; the price approval waits.
        messages[conciergeChatID] = [
            threaded(user("c-login", "登录页的按钮间距不对，深色模式下也看不清，修一下。", at: at(9, 58, daysAgo: 3)), "c-login"),
            threaded(taskPart("chat-login", "修复登录页样式", show: "task", at: at(9, 59, daysAgo: 3)), "c-login"),
            threaded(taskPart("chat-login", "修复登录页样式", show: "ask", card: questionCard("q-login", "深色模式下按钮用珊瑚色，还是用中性色？", options: ["珊瑚色", "中性色"], answered: "珊瑚色", since: at(10, 10, daysAgo: 3)), at: at(10, 11, daysAgo: 3)), "c-login"),
            threaded(taskPart("chat-login", "修复登录页样式", show: "ask", card: approvalCard("ap-login", "发布预览环境", outcome: "approved", since: at(10, 30, daysAgo: 3)), at: at(10, 31, daysAgo: 3)), "c-login"),
            threaded(agent("改好了：按钮间距统一成 14 pt，深色模式下的文字换成了浅色。", at: at(10, 41, daysAgo: 3)), "c-login"),
            threaded(user("c-site", "帮我把官网首页的文案改成中英双语", at: at(9, 12)), "c-site"),
            threaded(agent("好，我开一个任务去改。", at: at(9, 12).addingTimeInterval(20)), "c-site"),
            threaded(agent("改完告诉你。", at: at(9, 12).addingTimeInterval(21)), "c-site"),
            threaded(taskPart("chat-site", "官网首页双语文案", show: "task", at: at(9, 12).addingTimeInterval(22)), "c-site"),
            threaded(agent("竞品调研想确认一下范围，你看下。", at: at(9, 15), id: "c-research"), "c-research"),
            threaded(taskPart("chat-research", "竞品定价调研", show: "ask", card: questionCard("q-1", "调研范围只看国内产品，还是包括海外？", options: ["只看国内", "包括海外"], expired: true, since: at(9, 15)), at: at(9, 15).addingTimeInterval(1)), "c-research"),
            threaded(agent("降噪耳机降到 ¥899 了，价格追踪想给你发提醒邮件，需要你批准。", at: at(9, 40), id: "c-price"), "c-price"),
            threaded(taskPart("chat-price", "价格追踪：发提醒邮件", show: "ask", card: approvalCard("ap-1", "发送邮件", since: at(9, 39).addingTimeInterval(5)), at: at(9, 40).addingTimeInterval(1)), "c-price"),
            // The Concierge asks and waits for an approval in the main chat too.
            renewed,
            user("c3", "海口明天怎么样？", at: at(9, 52), session: conciergeChatID),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-hk"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "props": .object(["questions": .array([
                    .object(["id": .string("intent"), "question": .string("你是想查海口明天的天气，还是了解海口这座城市？"), "type": .string("single"), "options": .array([.string("查明天的天气"), .string("了解这座城市")]), "freeText": .bool(true)]),
                ])])]),
            ])], at: at(9, 52).addingTimeInterval(20), session: conciergeChatID),
            parts([.object([
                "type": .string("approval_card"), "approvalId": .string("ap-cal"), "actionName": .string("calendar:create_event"), "status": .string("pending"),
                "preview": .object(["kind": .string("generic"), "title": .string("添加日程"), "summary": .string(""), "fields": .array([
                    .object(["label": .string("标题"), "value": .string("和设计团队过首页文案")]),
                    .object(["label": .string("时间"), "value": .string("明天 15:00–15:30")]),
                ])]),
            ])], at: at(9, 53), session: conciergeChatID),
            routineRun,
            routineAnswer,
            followRun,
            followAnswer,
            digestRun,
            digestAnswer,
        ]
        approvals["ap-cal"] = ApprovalRecord(id: "ap-cal", status: "pending")

        // A topic chat that needs services connected, and a question with defaults.
        let mail = "topic-mail"
        func card(_ service: String, _ label: String, _ icon: String, _ connect: JSONValue) -> JSONValue {
            .object(["type": .string("connect_card"), "service": .string(service), "label": .string(label), "icon": .string(icon), "connect": connect])
        }
        let composio: (String) -> JSONValue = { provider in
            .object(["kind": .string("composio"), "method": .string("POST"), "path": .string("/api/apps/connector/connect"), "body": .object(["provider": .string(provider)]), "needsLogin": .bool(false), "login": .object(["method": .string("POST"), "path": .string("/api/apps/connector/login/start")])])
        }
        messages[mail] = [
            user("m1", "每天早上把重要邮件整理给我，顺便看看 GitHub 上要我处理的事。", at: at(10, 2), session: mail),
            agent("要先连上这几个服务。", at: at(10, 3), session: mail),
            parts([
                card("gmail", "Gmail", "glyph:gmail", composio("gmail")),
                card("github", "GitHub", "brand:github", .object(["kind": .string("rome_oauth"), "url": .string("https://romeos.cc/connect/github"), "available": .bool(true), "unavailableReason": .null])),
                card("notion", "Notion", "glyph:notion", composio("notion")),
                card("linear", "Linear", "glyph:linear", composio("linear")),
                card("slack", "Slack", "brand:slack", .object(["kind": .string("rome_oauth"), "url": .null, "available": .bool(false), "unavailableReason": .string("Rome Cloud 还不能连接 Slack")])),
            ], at: at(10, 3).addingTimeInterval(5), session: mail),
        ]
        // Routine cards (one on, one not yet), and cards only the web draws.
        let routine = "topic-routine"
        func routineCard(_ key: String, name: String, trigger: String, watch: String, then: String) -> JSONValue {
            .object([
                "type": .string("routine_draft_card"), "toolUseId": .string("tu-\(key)"), "routineKey": .string("chat-routine:\(key)"),
                "draft": .object([
                    "name": .string(name), "sentence": .string(""), "watchLabel": .string(watch), "thenSummary": .string(then),
                    "trigger": .object(["type": .string(trigger)]), "actionName": .string("concierge:run_prompt"), "args": .object([:]),
                ]),
            ])
        }
        messages[routine] = [
            user("rt1", "每周五早上提醒我这周读了多少，有新邮件来自出版社也告诉我。", at: at(11, 0), session: routine),
            parts([
                routineCard("books", name: "每周读书小结", trigger: "schedule", watch: "每周五 09:00", then: "汇总这周的读书笔记，在 Chat 里告诉你"),
                routineCard("publisher", name: "出版社来信提醒", trigger: "event_bus", watch: "Gmail · 新邮件", then: "用一句话总结并提醒你"),
            ], at: at(11, 1), session: routine),
            parts([
                .object(["type": .string("pending_interaction"), "toolUseId": .string("ai-1"), "appId": .string("rome"), "render": .object(["componentId": .string("ai-tools-card"), "builtin": .bool(true)])]),
                .object(["type": .string("quota_switch"), "from": .string("claude"), "to": .string("codex"), "model": .string("GPT-5")]),
                .object(["type": .string("poll_card"), "question": .string("?")]),
            ], at: at(11, 2), session: routine),
            // The AI tools card was answered on the web: its row says Done.
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("ai-1"), "output": .object(["connected": .bool(true)])])], at: at(11, 3), session: routine, role: "user"),
        ]
        // What goes wrong: a limit before a turn ran, a turn that failed midway, a
        // switch of model, and messages the instance could not hand over.
        func marked(_ message: ChatMessage, _ reaction: String?, inputState: String? = nil, turn: String? = nil) -> ChatMessage {
            var message = message
            message.turnId = turn
            message.statusReaction = reaction
            message.inputState = inputState
            return message
        }
        func failedTrace(turn: String, error: String?, code: String? = nil, provider: String? = nil, at date: Date) -> ChatMessage {
            var message = ChatMessage(id: nextID(), sessionId: "topic-errors", turnId: turn, role: "trace", content: "[]", createdAt: RomeDate.string(date), traceSummary: TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: error, terminalErrorCode: code, terminalErrorProvider: provider))
            message.turnId = turn
            return message
        }
        messages["topic-errors"] = [
            marked(user("er1", "把今天的邮件整理一下。", at: at(13, 0), session: "topic-errors"), "failed"),
            parts([.object(["type": .string("error"), "error": .string("Selected model provider is unavailable: Codex (ChatGPT) has reached its usage limit"), "code": .string("model_provider_unavailable"), "provider": .string("openai"), "reason": .string("quota_exhausted")])], at: at(13, 0), session: "topic-errors"),
            marked(user("er2", "那就现在发给我吧。", at: at(13, 5), session: "topic-errors"), "failed", turn: "er-t2"),
            failedTrace(turn: "er-t2", error: "You've hit your limit · resets 3pm", code: "usage_limit", provider: "openai", at: at(13, 6)),
            parts([.object(["type": .string("quota_switch"), "from": .string("openai"), "to": .string("anthropic"), "reason": .string("quota"), "fromModel": .string("gpt-6-luna"), "model": .string("claude-sonnet-5-5")])], at: at(13, 7), session: "topic-errors"),
            marked(user("er3", "好，继续。", at: at(13, 8), session: "topic-errors"), "working"),
            marked(user("er4", "顺便查一下周五的航班。", at: at(13, 9), session: "topic-errors"), nil, inputState: "failed"),
            marked(user("er5", "再提醒我带护照。", at: at(13, 10), session: "topic-errors"), nil, inputState: "unknown"),
        ]
        // A narrow table, and one wider than the bubble that scrolls inside it.
        messages["topic-table"] = [
            user("tb1", "帮我比一下这三款降噪耳机。", at: at(12, 0), session: "topic-table"),
            agent("""
            三款的价格和续航：

            | 型号 | 价格 | 续航 |
            | :--- | ---: | :---: |
            | Sony WH-1000XM6 | ¥2,499 | 30 h |
            | Bose QC Ultra | ¥2,299 | 24 h |
            | AirPods Max | ¥3,999 | 20 h |
            """, at: at(12, 1), session: "topic-table"),
            agent("""
            细节对比：

            | 型号 | 降噪 | 佩戴 | 通话 | 适合谁 |
            | --- | --- | --- | --- | --- |
            | **Sony WH-1000XM6** | 三款里最强，地铁和飞机上都很安静 | 偏紧，戴久了耳朵会热 | 清楚 | 经常出差、坐飞机的人 |
            | Bose QC Ultra | 接近 Sony，人声压得更干净 | 最轻最松，适合长时间戴 | 一般 | 每天通勤、要戴一整天的人 |
            | AirPods Max | 比前两款弱一些 | 重，但做工最好 | 很好 | 已经在用 `iPhone` 和 Mac 的人 |
            """, at: at(12, 2), session: "topic-table"),
        ]
        messages["topic-mail-setup"] = [
            user("ms1", "摘要按什么来整理？", at: at(10, 1), session: "topic-mail-setup"),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-mail"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "props": .object(["questions": .array([
                    .object(["id": .string("what"), "question": .string("摘要里要包括哪些？"), "type": .string("multi"),
                             "options": .array([.string("需要我回复的"), .string("账单和收据"), .string("新闻简报")]),
                             "defaults": .array([.string("需要我回复的")]),
                             "optionDescriptions": .object(["需要我回复的": .string("别人在等你答复的邮件"), "新闻简报": .string("订阅的周报和新闻")])]),
                    .object(["id": .string("when"), "question": .string("几点发给你？"), "type": .string("text"), "defaultText": .string("每天早上 8 点")]),
                ])])]),
            ])], at: at(10, 4), session: "topic-mail-setup"),
        ]

        // Task: price tracking, waiting on an approval.
        let price = "chat-price"
        messages[price] = [
            user("p1", "每天早上检查这三个商品的价格，低于目标价就发邮件提醒我。", at: at(9, 30), session: price),
            trace(steps: 3, at: at(9, 31), session: price),
            agent("降噪耳机今天 ¥899，低于你设的 ¥950。另外两个没有变化。", at: at(9, 39), session: price),
            parts([.object([
                "type": .string("approval_card"), "approvalId": .string("ap-1"), "actionName": .string("system:send_email"), "status": .string("pending"),
                "preview": .object(["kind": .string("generic"), "title": .string("发送邮件"), "summary": .string(""), "fields": .array([
                    .object(["label": .string("收件人"), "value": .string("lin@example.com")]),
                    .object(["label": .string("主题"), "value": .string("价格提醒：降噪耳机 ¥899")]),
                ])]),
            ])], at: at(9, 39).addingTimeInterval(5), session: price),
        ]
        approvals["ap-1"] = ApprovalRecord(id: "ap-1", status: "pending")

        // Task: research, waiting on a question.
        let research = "chat-research"
        messages[research] = [
            user("r1", "调研三家主要竞品的定价，整理成表格。", at: at(9, 10), session: research),
            trace(steps: 5, at: at(9, 11), session: research),
            parts([.object(["type": .string("pending_interaction"), "toolUseId": .string("app-1"), "appId": .string("showcases"), "render": .object(["componentId": .string("pricing-table")])])], at: at(9, 14), session: research),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-1"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "props": .object(["questions": .array([
                    .object(["id": .string("scope"), "question": .string("调研范围只看国内产品，还是包括海外？"), "type": .string("single"), "options": .array([.string("只看国内"), .string("包括海外")]), "freeText": .bool(true)]),
                ])])]),
            ])], at: at(9, 15), session: research),
        ]

        // Task: site copy, running.
        let site = "chat-site"
        messages[site] = [
            user("s1", "把官网首页的文案改成中英双语。", at: at(9, 13), session: site),
            trace(steps: 2, at: at(9, 14), session: site),
            agent("""
            首页一共 6 段文案，我先翻译**标题和副标题**，再处理功能介绍：

            1. Hero 标题和副标题
            2. 三个功能卡片
            3. 页脚的联系方式

            翻译稿会放在 `content/home.en.md`。
            """, at: at(9, 16), session: site, long: true),
            // The Concierge relays what the guardian added in the main chat:
            // drawn on the guardian's side, under its own name.
            saidByConcierge(user("s2", "补充一下：英文版标题保持简短，不超过 8 个词。", at: at(9, 18), session: site)),
            agent("好的，标题我会控制在 8 个词以内。", at: at(9, 19), session: site),
        ]

        // Task: Notion, failed.
        let notion = "chat-notion"
        messages[notion] = [
            user("n1", "每晚把 Notion 的任务数据库同步到表格。", at: at(18, 0, daysAgo: 1), session: notion),
            trace(steps: 4, at: at(18, 1, daysAgo: 1), session: notion),
            parts([.object(["type": .string("error"), "error": .string("Notion 连接已过期。在 Web 上重新连接后可以重试。")])], at: at(18, 20, daysAgo: 1), session: notion),
        ]

        // Task: meeting notes, running, nothing written yet.
        messages["chat-notes"] = [
            user("m1", "整理本周的会议纪要，按项目分组。", at: at(9, 32), session: "chat-notes"),
        ]

        // Task: done.
        messages["chat-login"] = [
            user("l1", "登录页的按钮间距不对，深色模式下也看不清，修一下。", at: at(10, 0, daysAgo: 3), session: "chat-login"),
            trace(steps: 7, at: at(10, 2, daysAgo: 3), session: "chat-login"),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-login"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "props": .object(["questions": .array([
                    .object(["id": .string("color"), "question": .string("深色模式下按钮用珊瑚色，还是用中性色？"), "type": .string("single"), "options": .array([.string("珊瑚色"), .string("中性色")])]),
                ])])]),
            ])], at: at(10, 10, daysAgo: 3), session: "chat-login"),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("q-login"), "output": .object(["answers": .array([.object(["questionId": .string("color"), "value": .string("珊瑚色")])])])])], at: at(10, 12, daysAgo: 3), session: "chat-login", role: "user"),
            parts([.object([
                "type": .string("approval_card"), "approvalId": .string("ap-login"), "actionName": .string("coding:deploy_preview"), "status": .string("pending"),
                "preview": .object(["kind": .string("generic"), "title": .string("发布预览环境"), "summary": .string("")]),
            ])], at: at(10, 30, daysAgo: 3), session: "chat-login"),
            agent("改好了：按钮间距统一成 14 pt，深色模式下的文字换成了浅色。", at: at(10, 40, daysAgo: 3), session: "chat-login"),
        ]
        approvals["ap-login"] = ApprovalRecord(id: "ap-login", status: "approved", executionState: "succeeded", resolvedAt: RomeDate.string(at(10, 32, daysAgo: 3)))
    }
}
#endif

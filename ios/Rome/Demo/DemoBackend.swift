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
    static let instances = [
        CloudInstance(id: "demo-1", name: "我的 Rome", slug: "me", origin: "https://me.romeos.cc", status: "running"),
        CloudInstance(id: "demo-2", name: "团队 Rome", slug: "team", origin: "https://team.romeos.cc", status: "running"),
        CloudInstance(id: "demo-3", name: "测试实例", slug: "staging", origin: "https://staging.romeos.cc", status: "stopped"),
    ]

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

    /// `updateRequired`: the full data on a Rome one release behind, so the
    /// update page shows; "Update now" brings it up to date after a few seconds.
    enum Variant { case full, empty, conciergeOff, updateRequired }
    private let variant: Variant

    init(variant: Variant = .full) {
        self.variant = variant
        seed()
        if variant != .full && variant != .updateRequired {
            messages[conciergeChatID] = []
            tasks = []
            topicChats = []
        }
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
        return [ConciergeChat(id: conciergeChatID, name: "Concierge", main: true, unread: 0)] + topicChats
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

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        try await pause(0.3)
        // Pages from the newest back, as the server does; the cursor is the
        // oldest message of the page before.
        let all = messages[sessionId] ?? []
        let end = before.flatMap { cursor in all.firstIndex { $0.id == cursor } } ?? all.count
        let start = max(0, end - limit)
        return MessagePage(messages: Array(all[start..<end]), nextCursor: start > 0 ? all[start].id : nil)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        try await pause(0.35)
        if text.contains("失败") { throw APIError.network }
        // Stored the way the server stores it: a line per file after the text.
        let lines = files.enumerated().map { index, file in
            let path = "projects/demo/\(inputId)/\(file.name)"
            assets[path] = Data(base64Encoded: file.dataBase64)
            return "- File \(index + 1): [\(file.name)](</\(path)>)"
        }
        let stored = ([text] + (lines.isEmpty ? [] : [lines.joined(separator: "\n")])).filter { !$0.isEmpty }.joined(separator: "\n\n")
        insert(sessionId, user(inputId, stored, at: .now, session: sessionId))
        let turnId = "turn-\(nextID())"
        setRunning(sessionId, turnId)
        let topic = topicChats.firstIndex { $0.id == sessionId }
        let concierge = sessionId == conciergeChatID || topic != nil
        Task {
            try? await pause(concierge ? 1.8 : 3.5)
            if concierge {
                insert(sessionId, agent("好，我记下了。", at: .now, session: sessionId))
                try? await pause(0.7)
                insert(sessionId, agent("需要开任务的话，我会把它放进任务里，做完告诉你。", at: .now, session: sessionId))
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

    func approval(id: String) async throws -> ApprovalRecord {
        try await pause(0.2)
        return approvals[id] ?? ApprovalRecord(id: id, status: "pending")
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

    func me() async throws -> String? { "lin@example.com" }

    /// The next time the clock reads `hour`: today if it is still ahead, else tomorrow.
    private static func nextAt(_ hour: Double) -> String {
        let today = Calendar.current.startOfDay(for: .now).addingTimeInterval(hour * 3600)
        return RomeDate.string(today > .now ? today : today.addingTimeInterval(24 * 3600))
    }

    private var routineList: [Routine] = [
        Routine(id: "r1", name: "每日简报", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("08:30"), "rrule": .string("FREQ=DAILY")]), nextRunAt: DemoBackend.nextAt(8.5)),
        Routine(id: "r2", name: "price_watch", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("09:00"), "rrule": .string("FREQ=DAILY")]), nextRunAt: DemoBackend.nextAt(9)),
        Routine(id: "r3", name: "weekly_report", enabled: false, trigger: .object(["type": .string("schedule"), "localTime": .string("09:00"), "rrule": .string("FREQ=WEEKLY;BYDAY=MO")]), nextRunAt: nil),
        Routine(id: "r4", name: "dream", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("03:00"), "rrule": .string("FREQ=DAILY;INTERVAL=3")]), nextRunAt: nil, managedBy: "dream"),
        // Listed with "Last run failed".
        Routine(id: "r5", name: "notion_sync", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("07:00"), "rrule": .string("FREQ=DAILY")]), nextRunAt: DemoBackend.nextAt(7), lastRun: .init(status: "error")),
        Routine(id: "r7", name: "Standup notes", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("09:30"), "rrule": .string("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")]), nextRunAt: DemoBackend.nextAt(9.5)),
        Routine(id: "r8", name: "team_digest", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("09:00"), "rrule": .string("FREQ=WEEKLY;BYDAY=MO")]), nextRunAt: RomeDate.string(Calendar.current.date(byAdding: .day, value: 4, to: Calendar.current.startOfDay(for: .now))!.addingTimeInterval(9 * 3600))),
        Routine(id: "r9", name: "每月对账：汇总所有订阅、发票和退款，整理成表格发到邮箱", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("10:00"), "rrule": .string("FREQ=MONTHLY")]), nextRunAt: RomeDate.string(Calendar.current.date(byAdding: .day, value: 12, to: Calendar.current.startOfDay(for: .now))!.addingTimeInterval(10 * 3600))),
        Routine(id: "r10", name: "Weekend reading list for the family trip planning", enabled: false, trigger: .object(["type": .string("schedule"), "localTime": .string("08:00"), "rrule": .string("FREQ=WEEKLY;BYDAY=SA,SU")]), nextRunAt: nil),
        // As core keeps them for Chat: a follow is two routines (two triggers),
        // with the target in the name, and a digest with its time.
        Routine(id: "c1", name: "Concierge follows lin.chen.workspace@example.com (Google Calendar)", enabled: true, trigger: .object(["type": .string("event-bus")]), nextRunAt: nil, key: "concierge-follow:gcal:1", actionName: "core:concierge_follow_event"),
        Routine(id: "c2", name: "Concierge follows lin.chen.workspace@example.com (Google Calendar)", enabled: true, trigger: .object(["type": .string("event-bus")]), nextRunAt: nil, key: "concierge-follow:gcal:2", actionName: "core:concierge_follow_event"),
        Routine(id: "c3", name: "Concierge digest at 09:00", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("09:00"), "rrule": .string("FREQ=DAILY")]), nextRunAt: DemoBackend.nextAt(9), key: "concierge-digest:guardian", actionName: "core:concierge_digest"),
        Routine(id: "s1", name: "system_upgrade", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("03:00"), "rrule": .string("FREQ=DAILY")]), nextRunAt: DemoBackend.nextAt(3), actionName: "system_upgrade"),
        // A one-off that already ran: hidden, as on the dashboard.
        Routine(id: "r6", name: "dentist_reminder", enabled: true, trigger: .object(["type": .string("schedule"), "localTime": .string("10:00")]), nextRunAt: nil, lastFiredAt: .string("2026-11-01T10:00:00Z"), lastRun: .init(status: "success")),
    ]

    func sendFeedback(_ text: String) async throws {
        try await pause(0.8)
    }

    func routines() async throws -> [Routine] {
        try await pause(0.3)
        return routineList
    }

    func setRoutine(_ id: String, enabled: Bool) async throws {
        try await pause(0.3)
        if let index = routineList.firstIndex(where: { $0.id == id }) { routineList[index].enabled = enabled }
    }

    // MARK: Helpers

    // MARK: Updates

    static let releasedVersion = "0.42.0"
    private lazy var runningVersion = variant == .updateRequired ? "0.41.3" : Self.releasedVersion
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

    private func user(_ id: String, _ text: String, at date: Date, session: String = conciergeChatID) -> ChatMessage {
        ChatMessage(id: id, sessionId: session, role: "user", content: json([.object(["type": .string("text"), "content": .string(text)])]), createdAt: RomeDate.string(date))
    }

    private func agent(_ text: String, at date: Date, session: String = conciergeChatID, long: Bool = false) -> ChatMessage {
        var part: [String: JSONValue] = ["type": .string("text"), "content": .string(text)]
        if long { part["format"] = .string("long") }
        return ChatMessage(id: nextID(), sessionId: session, role: "assistant", content: json([.object(part)]), createdAt: RomeDate.string(date))
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

        topicChats = [
            ConciergeChat(id: "topic-trip", name: "京都旅行计划", main: false, unread: 2),
            ConciergeChat(id: "topic-home", name: "家里装修：厨房翻新、浴室防水和客厅灯具的预算与师傅安排", main: false, unread: 0),
            ConciergeChat(id: "topic-books", name: "读书笔记", main: false, unread: 0),
        ]

        func task(_ id: String, _ title: String, _ state: TaskState, chat: String?, from topic: String? = nil, summary: String? = nil, waitingOn: String? = nil, minutesAgo: Double, due: Double? = nil, done: Bool = false) -> ConciergeTask {
            let updated = nowMs - minutesAgo * 60_000
            return ConciergeTask(
                id: id, title: title, state: state, summary: summary, waitingOn: waitingOn,
                dueAt: due.map { nowMs + $0 * 60_000 }, rank: nil,
                chat: chat.map { .init(id: $0, name: chats[$0]?.name ?? title) },
                conciergeChat: topic.flatMap { id in topicChats.first { $0.id == id } },
                sourceMessageId: nil, createdAt: updated - 3_600_000, updatedAt: updated,
                completedAt: done ? updated : nil, archivedAt: nil, notSynced: false
            )
        }
        tasks = [
            task("t1", "价格追踪：发提醒邮件", .needsUser, chat: "chat-price", waitingOn: "需要批准发送邮件", minutesAgo: 10),
            task("t2", "竞品定价调研", .needsUser, chat: "chat-research", waitingOn: "在等你回答调研范围", minutesAgo: 25),
            task("t3", "官网首页双语文案", .doing, chat: "chat-site", summary: "正在逐段翻译首页文案", minutesAgo: 2),
            task("t4", "整理本周会议纪要", .doing, chat: "chat-notes", summary: "已读完 3 份纪要", minutesAgo: 8),
            task("t5", "同步 Notion 数据库", .doing, chat: "chat-notion", summary: "Notion 连接已过期", minutesAgo: 60 * 15),
            task("t6", "每周一整理周报", .next, chat: nil, summary: "下周一早上开始", minutesAgo: 120, due: 60 * 30),
            task("t7", "盯着降噪耳机价格", .watching, chat: nil, summary: "每天早上 9 点检查一次", minutesAgo: 300, due: 60 * 14),
            task("t8", "修复登录页样式", .done, chat: "chat-login", summary: "按钮间距和深色模式都改好了", minutesAgo: 60 * 24 * 3, done: true),
            task("t9", "比较京都三家酒店", .doing, chat: nil, from: "topic-trip", summary: "正在看评价和价格", minutesAgo: 6),
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
        messages["topic-books"] = (0..<24).flatMap { index -> [ChatMessage] in
            let time = at(8, 0, daysAgo: 1).addingTimeInterval(Double(index) * 600)
            return [
                user("b\(index)", "第 \(index + 1) 章讲了什么？", at: time, session: "topic-books"),
                agent("第 \(index + 1) 章讲的是作者怎么把一个大问题拆成几个小问题，每个小问题都能在一天内做完，然后用一个简单的清单跟踪进度。", at: time.addingTimeInterval(30), session: "topic-books"),
            ]
        }
        messages["topic-trip"] = [
            user("k1", "四月去京都五天，帮我排个行程。", at: at(8, 50), session: "topic-trip"),
            agent("好。先定住处：我比较三家酒店的位置和价格，再按区域排每天的行程。", at: at(8, 51), session: "topic-trip"),
            agent("酒店比较好了：河原町那家离车站最近，价格中等。\n\n![河原町酒店外观](/api/projects/asset/hotel.jpg?path=projects%2Fdemo%2Ftrip%2Fhotel.jpg)\n\n要我按它来排吗？", at: at(9, 20), session: "topic-trip"),
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

        // Concierge, as on the design's Chat board.
        messages[conciergeChatID] = [
            user("u1", "帮我把官网首页的文案改成中英双语", at: at(9, 12)),
            agent("好，我开一个任务去改。", at: at(9, 12).addingTimeInterval(20)),
            agent("改完告诉你。", at: at(9, 12).addingTimeInterval(21)),
            parts([.object(["type": .string("task_chat"), "chatId": .string("chat-site"), "title": .string("官网首页双语文案")])], at: at(9, 12).addingTimeInterval(22), session: conciergeChatID),
            agent("降噪耳机降到 ¥899 了，价格追踪想给你发提醒邮件，需要你批准。", at: at(9, 40)),
            parts([.object(["type": .string("task_chat"), "chatId": .string("chat-price"), "title": .string("价格追踪：发提醒邮件")])], at: at(9, 40).addingTimeInterval(1), session: conciergeChatID),
            agent("竞品调研想确认一下范围，你看下。", at: at(9, 40).addingTimeInterval(2)),
            // The Concierge asks and waits for an approval in the main chat too.
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
        ]
        approvals["ap-cal"] = ApprovalRecord(id: "ap-cal", status: "pending")

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

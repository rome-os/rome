#if DEBUG
import Foundation
import UIKit

/// The demo's Claude login socket: `auth_url` after a beat, then
/// `auth_error` for the code "wrong" and a login for any other.
@MainActor
final class DemoLoginSocket: LoginSocket {
    private var frames: [String] = []
    private var waiting: CheckedContinuation<String?, Never>?
    private var closed = false
    private let loggedIn: () -> Void
    /// How long a code takes to check; tests pass zero.
    private let check: Duration

    /// `beat`: how long the sign-in page takes to come.
    init(beat: Duration = .seconds(1.2), check: Duration = .seconds(0.8), loggedIn: @escaping () -> Void) {
        self.loggedIn = loggedIn
        self.check = check
        Task { [weak self] in
            if beat > .zero { try? await Task.sleep(for: beat) }
            self?.push(#"{"type":"auth_url","url":"https://claude.ai/oauth/authorize?code=true&client_id=demo"}"#)
        }
    }

    private func push(_ frame: String) {
        if let waiting {
            self.waiting = nil
            waiting.resume(returning: frame)
        } else {
            frames.append(frame)
        }
    }

    func receive() async throws -> String {
        if !frames.isEmpty { return frames.removeFirst() }
        if closed { throw URLError(.networkConnectionLost) }
        guard let frame = await withCheckedContinuation({ waiting = $0 }) else { throw URLError(.networkConnectionLost) }
        return frame
    }

    func send(_ text: String) async throws {
        guard let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)), frame["type"]?.string == "submit_code" else { return }
        if check > .zero { try? await Task.sleep(for: check) }
        if frame["code"]?.string?.lowercased() == "wrong" {
            push(#"{"type":"auth_error","message":"Invalid code"}"#)
        } else {
            loggedIn()
        }
    }

    func close() {
        closed = true
        if let waiting {
            self.waiting = nil
            waiting.resume(returning: nil)
        }
    }
}

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

    /// Whether anyone still listens to `topic`.
    func isListening(to topic: String) -> Bool { handlers.values.contains { $0.topic == topic } }

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
    /// Archived topic chats, latest archived first; their messages stay.
    private var archivedTopics: [ConciergeChat] = []
    /// The follows each archived chat's archive moved to the main chat.
    private var movedFollows: [String: [ConciergeChatWork.Follow]] = [:]
    /// Each topic chat's last activity, for the chat list; the drawer sorts by it.
    private var topicActivity: [String: Date] = [:]
    /// When each pinned topic chat was pinned. None is pinned at first.
    private var topicPins: [String: Date] = [:]
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
    /// `visitor`: the full demo, seen by a dashboard admin of the shared Rome.
    /// `updateOffered`: a Rome behind its latest release but new enough for
    /// the app, which offers the update instead of requiring it.
    /// `longChat`: the full data with a main chat long enough to page, ending
    /// in a long digest that folds: what a cold launch from kept rows meets.
    /// It has more topic chats than the drawer's first page, too.
    enum Variant { case full, empty, conciergeOff, updateRequired, updateOffered, manyApps, visitor, longChat, olderTopics }
    private let variant: Variant

    init(variant: Variant = .full) {
        self.variant = variant
        seed()
        if variant == .empty || variant == .conciergeOff {
            messages[conciergeChatID] = []
            tasks = []
            topicChats = []
            archivedTopics = []
        }
        if variant == .longChat {
            lengthenMainChat()
            addOlderTopicChats()
        }
        if variant == .olderTopics {
            let ids: Set<String> = ["topic-home", "topic-trip", "topic-books", "topic-meals", "topic-location", "topic-mail"]
            topicChats.removeAll { !ids.contains($0.id) }
            for chat in topicChats { topicActivity[chat.id] = .now.addingTimeInterval(chat.id == "topic-home" ? -60 : -15 * 86400) }
            topicPins["topic-books"] = .now
        }
    }

    /// Forty quiet topic chats, older than the others, started before them:
    /// the drawer shows them a page at a time.
    private func addOlderTopicChats() {
        let older = (1...40).map { ConciergeChat(id: "topic-old-\($0)", name: "旧话题 \($0)", main: false, unread: $0 == 35 ? 1 : 0) }
        for chat in older {
            let number = Int(chat.id.split(separator: "-").last!)!
            topicActivity[chat.id] = Date.now.addingTimeInterval(Double(-86400 - number * 3600))
            messages[chat.id] = []
        }
        topicChats = older.reversed() + topicChats
    }

    private func lengthenMainChat() {
        let start = Date.now.addingTimeInterval(-2 * 86400)
        var earlier: [ChatMessage] = []
        // `ROME_DEMO_PAIRS` makes it deeper and mixed like a real chat, for
        // paging through many pages (`ROME_PERF=paging`): long Markdown,
        // pictures that load after they show, and approval cards that fill in
        // once their record comes.
        let pairs = ProcessInfo.processInfo.environment["ROME_DEMO_PAIRS"].flatMap(Int.init)
        let picture = assets["projects/demo/trip/hotel.jpg"]
        // A deeper history starts before the oldest demo message (3 days ago),
        // so its pages go in above the rows, as a real chat's do.
        let first = pairs.map { Date.now.addingTimeInterval(-4 * 86400 - Double($0) * 600) } ?? start
        for index in 0..<(pairs ?? 60) {
            let at = first.addingTimeInterval(Double(index) * 600)
            earlier.append(user("long-u\(index)", "第 \(index + 1) 个问题：今天有什么要注意的？", at: at))
            guard pairs != nil else {
                earlier.append(agent("第 \(index + 1) 个回答：没有新的安排，照常进行。", at: at.addingTimeInterval(30)))
                continue
            }
            switch index % 6 {
            case 0:
                let items = (1...(3 + index % 7)).map { "\($0). 下午三点和设计团队过首页文案，记得带上上周的反馈。" }.joined(separator: "\n")
                earlier.append(agent("## 第 \(index + 1) 个回答\n\n\(items)\n\n| 事项 | 时间 | 谁 |\n|---|---|---|\n| 首页文案 | 15:00 | 设计 |\n| 周报 | 17:30 | 我 |", at: at.addingTimeInterval(30)))
            case 2:
                // A path of its own, so the picture is not cached and loads late.
                let path = "projects/demo/deep/pic-\(index).jpg"
                assets[path] = picture
                earlier.append(agent("第 \(index + 1) 个回答：这是现场的照片。\n\n![现场](/api/projects/asset/pic.jpg?path=\(path.replacingOccurrences(of: "/", with: "%2F")))\n\n看起来没问题。", at: at.addingTimeInterval(30)))
            case 3:
                let id = "ap-deep-\(index)"
                approvals[id] = ApprovalRecord(id: id, status: index % 12 == 3 ? "approved" : "pending")
                earlier.append(parts([.object([
                    "type": .string("approval_card"), "approvalId": .string(id), "actionName": .string("calendar:create_event"), "status": .string("pending"),
                    "preview": .object(["kind": .string("generic"), "title": .string("添加日程"), "summary": .string(""), "fields": .array([
                        .object(["label": .string("标题"), "value": .string("第 \(index + 1) 次例会")]),
                        .object(["label": .string("时间"), "value": .string("明天 15:00–15:30")]),
                    ])]),
                ])], at: at.addingTimeInterval(30), session: conciergeChatID))
            case 5:
                earlier.append(agent("第 \(index + 1) 个回答：上午的会议改到了下午，地点不变。会后需要把讨论的要点整理成文档发给大家，截止时间是周五。", at: at.addingTimeInterval(30)))
            default:
                earlier.append(agent("第 \(index + 1) 个回答：没有新的安排，照常进行。", at: at.addingTimeInterval(30)))
            }
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
        if path.hasPrefix("/chat/sessions/") { return try await chatOutputFile(path: path) }
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

    /// A stored picture by its logical path, else a short trip plan as text.
    func linkedFile(_ file: LinkedFile) async throws -> Data {
        if file.apiPath.hasPrefix("/chat/sessions/") { return try await chatOutputFile(path: file.apiPath) }
        try await pause(0.2)
        var components = URLComponents()
        components.percentEncodedQuery = file.query
        if let logical = components.queryItems?.first(where: { $0.name == "path" })?.value, let data = assets[logical] { return data }
        return Data("# 京都行程\n\n周六：伏见稻荷、清水寺；周日：岚山、金阁寺。\n".utf8)
    }

    func renameChat(_ id: String, to name: String) async throws {
        try await pause(0.2)
        if let index = topicChats.firstIndex(where: { $0.id == id }) { topicChats[index].name = name }
        bus.emit(LiveTopic.chat(id), .sessionName(sessionId: id, name: name))
    }

    func pinChat(_ id: String, pinned: Bool) async throws {
        try await pause(0.2)
        topicPins[id] = pinned ? .now : nil
    }

    func archiveChat(_ id: String) async throws {
        try await pause(0.2)
        if let chat = topicChats.first(where: { $0.id == id }) { archivedTopics.insert(chat, at: 0) }
        topicChats.removeAll { $0.id == id }
    }

    func archivedTopicChats() async throws -> [ChatSession] {
        try await pause(0.2)
        // Latest archived first, an hour apart.
        return archivedTopics.enumerated().map { index, chat in
            ChatSession(id: chat.id, name: chat.name, agentName: ChatSession.conciergeAgent, archivedAt: RomeDate.string(.now.addingTimeInterval(Double(-index * 3600))), activityAt: topicActivity[chat.id].map(RomeDate.string), pinnedAt: nil)
        }
    }

    func unarchiveChat(_ id: String, movingFollowsBack: Bool) async throws {
        try await pause(0.2)
        guard let chat = archivedTopics.first(where: { $0.id == id }) else { throw APIError.notFound }
        archivedTopics.removeAll { $0.id == id }
        movedFollows[id] = nil
        topicChats.append(chat)
    }

    /// An archived chat's follows its archive moved. Any other chat answers
    /// as an older instance does, so its archive and delete ask as before.
    func chatWork(chatId: String) async throws -> ConciergeChatWork {
        try await pause(0.2)
        guard archivedTopics.contains(where: { $0.id == chatId }) else { throw APIError.notFound }
        return ConciergeChatWork(movedFollows: movedFollows[chatId] ?? [])
    }

    func deleteChat(_ id: String) async throws {
        try await pause(0.2)
        topicChats.removeAll { $0.id == id }
        archivedTopics.removeAll { $0.id == id }
    }

    /// Chats whose messages cannot be read, for the load-error bar's snapshots.
    var unreadableChats: Set<String> = []

    func threadPage(sessionId: String, anchor: String, before: String?, after: String?, limit: Int) async throws -> ThreadPage {
        let all = Self.withThreadRoots(Self.withTurns(messages[sessionId] ?? []))
        guard let pressed = all.first(where: { $0.id == anchor && !$0.isTrace }) else { throw APIError.notFound }
        let chain = all.filter { !$0.isTrace && $0.chatThreadId == pressed.chatThreadId }
        guard let at = chain.firstIndex(where: { $0.id == (before ?? after ?? anchor) }) else { throw APIError.notFound }
        let start = after != nil ? at + 1 : max(0, at - limit)
        let end = before != nil ? at : min(chain.count, at + limit + 1)
        return ThreadPage(messages: Array(chain[start..<end]), hasOlder: after != nil || start > 0, hasNewer: before != nil || end < chain.count)
    }

    private static func withThreadRoots(_ messages: [ChatMessage]) -> [ChatMessage] {
        var roots: [String: String] = [:]
        return messages.map { message in
            var message = message
            let original = message.parts.lazy.compactMap(\.replyQuote).first?.messageId
            message.chatThreadId = original.flatMap { roots[$0] } ?? message.id
            roots[message.id] = message.chatThreadId
            return message
        }
    }

    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage {
        try await pause(0.3)
        if unreadableChats.contains(sessionId) { throw APIError.server(status: 503, message: nil) }
        // Pages from the newest back, as the server does; the cursor is the
        // oldest message of the page before.
        let all = messages[sessionId] ?? []
        let end = before.flatMap { cursor in all.firstIndex { $0.id == cursor } } ?? all.count
        let start = max(0, end - limit)
        let turned = Self.withThreadRoots(Self.withTurns(all))
        return MessagePage(messages: Array(turned[start..<end]), nextCursor: start > 0 ? all[start].id : nil)
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
        let chatName = topicChats.first { $0.id == sessionId }?.name ?? String(localized: "Chat")
        let link = ChatShareLink(id: "share-\(nextID())", url: "/share/demo\(nextID())", title: chatName, createdAt: RomeDate.string(.now), chatId: sessionId, chatName: chatName)
        shares[sessionId, default: []].insert(link, at: 0)
        return link
    }

    func allShares() async throws -> [ChatShareLink] {
        try await pause(0.25)
        return shares.values.flatMap { $0 }.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    func revokeShare(id: String) async throws {
        try await pause(0.2)
        for key in shares.keys { shares[key]?.removeAll { $0.id == id } }
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn {
        try await send(sessionId: sessionId, text: text, files: files, inputId: inputId, priority: priority, reply: nil)
    }

    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority, reply target: ReplyTarget?) async throws -> CreatedTurn {
        try await pause(0.35)
        if text.contains("失败") || text.lowercased().contains("fail") { throw APIError.network }
        // Stored the way the server stores it: a line per file after the text.
        let lines = files.enumerated().map { index, file in
            let path = "projects/demo/\(inputId)/\(file.name)"
            assets[path] = Data(base64Encoded: file.dataBase64)
            return "- File \(index + 1): [\(file.name)](</\(path)>)"
        }
        let stored = ([text] + (lines.isEmpty ? [] : [lines.joined(separator: "\n")])).filter { !$0.isEmpty }.joined(separator: "\n\n")
        // A send replies to the message it names and shows its quote; so does
        // the answer, which sits right under it.
        let original = target.flatMap { target in (messages[sessionId] ?? []).first { $0.id == target.messageId } }
        let sent = quoting(user(inputId, stored, at: .now, session: sessionId), original)
        insert(sessionId, sent)
        let turnId = "turn-\(nextID())"
        setRunning(sessionId, turnId)
        let topic = topicChats.firstIndex { $0.id == sessionId }
        let concierge = sessionId == conciergeChatID || topic != nil
        Task {
            try? await pause(concierge ? 1.8 : 3.5)
            if concierge {
                insert(sessionId, quoting(agent("好，我记下了。", at: .now, session: sessionId), sent))
                try? await pause(0.7)
                insert(sessionId, quoting(agent("需要开任务的话，我会把它放进任务里，做完告诉你。", at: .now, session: sessionId), sent))
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

    /// Core's routing of a widget's event: an app's widget calls its app, and
    /// the question card core owns answers the agent with Send or Dismiss.
    func answerWidget(widgetId: String, name: String, context: JSONValue) async throws -> WidgetEventReply {
        // A widget is a message of its own: its id finds its chat and its card.
        guard let (sessionId, held) = messages.lazy.compactMap({ entry in
            entry.value.first(where: { $0.id == widgetId }).map { (entry.key, $0) }
        }).first,
            let data = held.content.data(using: .utf8),
            let card = (try? JSONDecoder().decode(JSONValue.self, from: data))?.array?.first,
            let toolUseId = card["toolUseId"]?.string, let appId = card["appId"]?.string
        else { throw APIError.notFound }
        guard appId == "core" else {
            _ = try await appCall(appId: appId, method: "POST", path: name, body: context)
            return WidgetEventReply()
        }
        try await pause(0.4)
        let output: JSONValue = name == "dismiss" || name == "rome:dismiss" ? .object(["dismissed": .bool(true)]) : context
        // Core keeps what a described card sent as `card`, beside the answers.
        var stored = output
        if case .object(var object) = output, let sent = object["answers"], sent.array?.first?["questionId"] == nil {
            object["card"] = sent
            stored = .object(object)
        }
        let part: JSONValue = .object(["type": .string("interaction_result"), "toolUseId": .string(toolUseId), "output": stored])
        insert(sessionId, ChatMessage(id: nextID(), sessionId: sessionId, role: "user", content: json([part]), createdAt: RomeDate.string(.now)))
        setRunning(sessionId, "turn-\(nextID())")
        Task {
            try? await pause(3)
            let reply = toolUseId == "q-hk" ? "好，我查一下海口明天的天气。"
                : toolUseId == "q-dinner" ? "好，晚饭按你选的来，我列三个做法。"
                : "好的，只看国内产品。我整理好表格后告诉你。"
            insert(sessionId, agent(reply, at: .now, session: sessionId))
            setRunning(sessionId, nil)
        }
        return WidgetEventReply(answered: true)
    }

    func markRead(sessionId: String) async {}

    func sessions() async throws -> [ChatSession] {
        Array(chats.values) + topicChats.map { chat in
            ChatSession(id: chat.id, name: chat.name, activityAt: topicActivity[chat.id].map(RomeDate.string), pinnedAt: topicPins[chat.id].map(RomeDate.string))
        }
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

    /// The task chats the demo's task links name, by id.
    private var taskLinkInfo: [String: TaskLinkInfo] = [:]

    func taskLinks(chatId: String, ids: [String]) async throws -> TaskLinksResponse {
        try await pause(0.1)
        return TaskLinksResponse(tasks: ids.compactMap { taskLinkInfo[$0] })
    }

    /// The main chat's rows that are no task chat: a reminder, a follow and
    /// routines (a daily one, a paused weekly one, a one-off), made on the
    /// first read so their times count from then. The row actions change them.
    private var listExtras: [TaskListItem]?

    private func extras(nowMs: Double) -> [TaskListItem] {
        if let listExtras { return listExtras }
        let hour = 3_600_000.0
        let made = nowMs - 6 * 24 * hour
        let oneOffDate: String = {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.string(from: Date(timeIntervalSince1970: (nowMs + 2 * 24 * hour) / 1000))
        }()
        let items: [TaskListItem] = [
            .check(.init(check: .init(id: "check-flight", name: "看看机票有没有降价", at: nowMs + 3 * hour, waitingFor: nil, createdAt: made))),
            .routine(.init(id: "r-passport", name: "提醒续签护照", trigger: .init(type: "schedule", localTime: "10:00", rrule: nil, date: oneOffDate), enabled: true, nextRunAt: nowMs + 2 * 24 * hour, lastRun: nil, createdAt: made)),
            .routine(.init(id: "r-summary", name: "每日总结", trigger: .init(type: "schedule", localTime: "21:00", rrule: "FREQ=DAILY"), enabled: true, nextRunAt: nowMs + 5 * hour, lastRun: nil, createdAt: made)),
            .follow(.init(source: "github", label: "GitHub", target: "rome-os/rome", state: "active", digestTimes: ["09:00", "18:00"], nextAt: nowMs + 7 * hour, createdAt: made)),
            .routine(.init(id: "r-weekly", name: "周报提醒", trigger: .init(type: "schedule", localTime: "17:00", rrule: "FREQ=WEEKLY;BYDAY=FR"), enabled: false, nextRunAt: nil, lastRun: .init(status: "error", firedAt: made), createdAt: made)),
        ]
        listExtras = items
        return items
    }

    /// The demo's task list in the one panel's groups: its tasks in the
    /// groups their status gives them, a scheduled task between runs in
    /// Scheduled, with a lone reminder, a follow and routines.
    func taskList(chatId: String) async throws -> TaskListResponse {
        try await pause(0.2)
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        let chat = chatId == conciergeChatID ? nil : chatId
        var groups: [TaskListGroup.Key: [TaskListItem]] = [:]
        for task in tasks where task.archivedAt == nil && task.conciergeChat?.id == chat {
            let status = TaskListWords.status(task)
            // Where Respond goes: the message of this chat with the card it waits on.
            let card = task.openWait?["id"]?.string.flatMap { wait in
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
            case "later": item.schedule == nil ? .later : .scheduled
            case "ended": .ended
            default: .active
            }
            groups[key, default: []].append(.task(item))
        }
        // The empty demo has none, so its tab shows "No tasks yet".
        if chat == nil, variant != .empty {
            for item in extras(nowMs: nowMs) {
                let key: TaskListGroup.Key
                switch item {
                case .routine(let routine): key = routine.trigger.date != nil && routine.trigger.rrule == nil ? .later : .scheduled
                case .follow: key = .scheduled
                default: key = .later
                }
                groups[key, default: []].append(item)
            }
        }
        let order: [TaskListGroup.Key] = [.needsYou, .active, .later, .scheduled, .ended]
        return TaskListResponse(chatId: chatId, groups: order.compactMap { key in groups[key].map { TaskListGroup(key: key, items: $0) } })
    }

    /// Changes a row that is no task chat, then reads the list again; one
    /// the list does not hold is not found.
    private func changeExtra(_ id: String, chatId: String, _ change: (inout [TaskListItem], Int) -> Void) async throws {
        try await pause(0.4)
        guard var items = listExtras, let index = items.firstIndex(where: { $0.id == id }) else { throw APIError.notFound }
        change(&items, index)
        listExtras = items
        bus.emit(LiveTopic.chatTasks(chatId), .taskListChanged(chatId: chatId))
    }

    func cancelListedCheck(chatId: String, checkId: String) async throws {
        try await changeExtra("check:\(checkId)", chatId: chatId) { items, index in items.remove(at: index) }
    }

    func unfollowListed(chatId: String, source: String, target: String) async throws {
        try await changeExtra("follow:\(source):\(target)", chatId: chatId) { items, index in items.remove(at: index) }
    }

    func setListedRoutineEnabled(chatId: String, routineId: String, enabled: Bool) async throws {
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        try await changeExtra("routine:\(routineId)", chatId: chatId) { items, index in
            guard case .routine(var routine) = items[index] else { return }
            routine.enabled = enabled
            routine.nextRunAt = enabled ? nowMs + 24 * 3_600_000 : nil
            items[index] = .routine(routine)
        }
    }

    func deleteListedRoutine(chatId: String, routineId: String) async throws {
        try await changeExtra("routine:\(routineId)", chatId: chatId) { items, index in items.remove(at: index) }
    }

    /// Marks a demo task done: it ends as done, and its list reads again.
    func markListedTaskDone(chatId: String, taskId: String) async throws {
        try await pause(0.4)
        guard let index = tasks.firstIndex(where: { $0.id == taskId }) else { throw APIError.notFound }
        tasks[index].status = "ended"
        tasks[index].endReason = "done"
        tasks[index].state = .done
        tasks[index].completedAt = Date.now.timeIntervalSince1970 * 1000
        tasks[index].updatedAt = tasks[index].completedAt!
        bus.emit(LiveTopic.chatTasks(chatId), .taskListChanged(chatId: chatId))
    }

    /// Stops a demo task: it ends as stopped, and its list reads again.
    func chatOutputs(chatId: String) async throws -> ChatOutputsResponse {
        try await pause(0.2)
        if variant == .empty || variant == .conciergeOff { return ChatOutputsResponse(outputs: []) }
        return ChatOutputsResponse(outputs: Self.outputs(chatId: chatId))
    }

    /// An output's bytes, by its `contentUrl` after `/api`.
    private func chatOutputFile(path: String) async throws -> Data {
        try await pause(0.2)
        guard let output = Self.outputs(chatId: conciergeChatID).first(where: { $0.contentUrl == "/api" + path }) else { throw APIError.notFound }
        if let link = output.link, let data = assets[String(link.dropFirst())] { return data }
        return Data("# \((output.name as NSString).deletingPathExtension)\n\n周六：伏见稻荷、清水寺；周日：岚山、金阁寺。\n".utf8)
    }

    /// The main chat's outputs, newest first: a task chat's among them, one moved.
    private static func outputs(chatId: String) -> [ChatOutput] {
        if chatId.hasPrefix("topic-") { return [] }
        func output(_ id: String, _ kind: String, _ name: String, link: String? = nil, mime: String?, minutesAgo: Double, missing: Bool = false, from: ChatOutput.Source? = nil) -> ChatOutput {
            ChatOutput(
                id: id, kind: kind, name: name, link: link, mimeType: mime,
                at: RomeDate.string(.now.addingTimeInterval(-minutesAgo * 60)),
                missing: missing, from: from,
                contentUrl: missing ? nil : "/api/chat/sessions/\(conciergeChatID)/outputs/\(id)/content"
            )
        }
        let price = ChatOutput.Source(chatId: "chat-price", name: "价格追踪：发提醒邮件")
        return [
            output("out-plan", "written", "京都行程.md", mime: "text/markdown", minutesAgo: 12),
            output("out-hotel", "shown", "hotel.jpg", link: "/projects/demo/trip/hotel.jpg", mime: "image/jpeg", minutesAgo: 40),
            output("out-prices", "written", "price-history.csv", mime: "text/csv", minutesAgo: 150, from: price),
            output("out-kitchen", "shown", "kitchen.jpg", link: "/projects/demo/home/kitchen.jpg", mime: "image/jpeg", minutesAgo: 2 * 1440),
            output("out-report", "written", "weekly_report.pdf", mime: "application/pdf", minutesAgo: 3 * 1440),
            output("out-script", "written", "rename-photos.py", mime: "text/x-python", minutesAgo: 5 * 1440, missing: true),
        ]
    }

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
                    tasks[index].status = "ended"
                    tasks[index].endReason = "done"
                    tasks[index].openWait = nil
                    tasks[index].updatedAt = Date.now.timeIntervalSince1970 * 1000
                    tasks[index].completedAt = tasks[index].updatedAt
                    // The task ended: its chat waits on no one, as the chat list says.
                    chats["chat-price"]?.awaitingGuardian = false
                    bus.emit(LiveTopic.chatStatus, .sessionRunning(sessionId: "chat-price", running: false))
                    bus.emit(LiveTopic.chatTasks(conciergeChatID), .taskListChanged(chatId: conciergeChatID))
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

    /// The state the demo's AI model shows, for Settings in each state.
    /// `creditsUsable`: no account logged in, no default, and credits left.
    enum AIModelPreview { case ready, paused, needsLogin, notSetUp, credits, creditsUsable }
    static var aiModelPreview: AIModelPreview = .ready
    /// The default the demo was set to, while that provider can run.
    private var chosenDefault: DefaultModelProvider?
    /// Chats that do not follow the default, by id: one kept on ChatGPT by a
    /// card's switch, one its owner picked a model for.
    private var pinned: [String: ChatSession.PinnedModel] = [
        "topic-provider": .init(by: "kept", providerId: "openai", selection: nil, model: "gpt-6-luna"),
        "topic-ai": .init(by: "owner", providerId: "anthropic", selection: "claude-haiku", model: "claude-haiku-5-5"),
    ]
    /// Accounts the demo logged out of, and when a device login started.
    private var loggedOut: Set<AIAccount> = []
    /// Accounts the demo logged in to, whatever the preview says.
    private var loggedIn: Set<AIAccount> = []
    private var deviceLoginStarted: Date?

    func aiTools() async throws -> AIToolsStatus {
        let now = Date.now
        var claude = AIToolsStatus.Provider(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 62, resetsAt: RomeDate.string(now.addingTimeInterval(3 * 3600))), sevenDay: nil), quotaExhausted: false)
        var codex = AIToolsStatus.Provider(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 12, resetsAt: nil), sevenDay: .init(usedPercent: 8, resetsAt: RomeDate.string(now.addingTimeInterval(5 * 86_400)))), quotaExhausted: false)
        var provider: DefaultModelProvider? = .openai
        switch Self.aiModelPreview {
        case .ready: break
        case .paused:
            codex.quotaExhausted = true
            // 14:20 today, or tomorrow once that has passed.
            var until = Calendar.current.date(bySettingHour: 14, minute: 20, second: 0, of: now) ?? now
            if until <= now { until = until.addingTimeInterval(86_400) }
            codex.quotaExhaustedUntil = RomeDate.string(until)
        case .needsLogin:
            codex.loggedIn = false
            codex.needsReauth = true
            codex.usage = nil
        case .notSetUp, .credits, .creditsUsable:
            claude = .init(loggedIn: false, quotaExhausted: false)
            codex = .init(loggedIn: false, quotaExhausted: false)
            provider = Self.aiModelPreview == .credits ? .romeCredits : nil
        }
        // A device login started here comes in after a few seconds.
        if let started = deviceLoginStarted, now.timeIntervalSince(started) > 5 {
            loggedOut.remove(.chatgpt)
            loggedIn.insert(.chatgpt)
            deviceLoginStarted = nil
        }
        if loggedOut.contains(.claude) { claude = .init(loggedIn: false, quotaExhausted: false) }
        if loggedOut.contains(.chatgpt) { codex = .init(loggedIn: false, quotaExhausted: false) }
        if loggedIn.contains(.claude) { claude = .init(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 4)), quotaExhausted: false) }
        if loggedIn.contains(.chatgpt) { codex = .init(loggedIn: true, usage: .init(fiveHour: .init(usedPercent: 3)), quotaExhausted: false) }
        // The first login replaces no default.
        if provider == nil || provider == .romeCredits {
            if codex.loggedIn == true { provider = .openai } else if claude.loggedIn == true { provider = .anthropic }
        }
        if provider == .openai, codex.loggedIn == false, claude.loggedIn == true, Self.aiModelPreview == .ready { provider = .anthropic }
        let creditsUsable = [.credits, .creditsUsable].contains(Self.aiModelPreview) && codex.loggedIn != true && claude.loggedIn != true
        switch chosenDefault {
        case .anthropic? where claude.loggedIn == true: provider = .anthropic
        case .openai? where codex.loggedIn == true: provider = .openai
        case .romeCredits? where creditsUsable: provider = .romeCredits
        default: break
        }
        let code = deviceLoginStarted.map { _ in AIToolsStatus.DeviceLogin(running: true, userCode: "K7QF-2M9D", verificationUrl: "https://auth.openai.com/codex/device") }
        return AIToolsStatus(
            claude: claude,
            codex: codex,
            codexDeviceLogin: code,
            defaultProvider: .init(provider: provider, signedIn: .init(anthropic: claude.loggedIn, openai: codex.loggedIn, romeCredits: creditsUsable), romeCreditsUsable: creditsUsable, followingChats: 3)
        )
    }

    func setDefaultProvider(_ provider: DefaultModelProvider, moveExisting: Bool) async throws {
        try await pause(0.5)
        chosenDefault = provider
        // A checked move lets every kept chat follow again.
        if moveExisting { pinned = pinned.filter { $0.value.by == "owner" } }
    }

    func chatSession(_ id: String) async throws -> ChatSession {
        ChatSession(id: id, name: "", followsDefault: pinned[id] == nil, pinnedModel: pinned[id])
    }

    func followDefault(sessionId: String) async throws -> ChatSession {
        try await pause(0.4)
        pinned[sessionId] = nil
        return try await chatSession(sessionId)
    }

    func refreshAITools(_ provider: DefaultModelProvider) async throws -> AIToolsStatus { try await aiTools() }

    func startChatGPTDeviceLogin() async throws -> DeviceLoginCode {
        try await pause(0.6)
        deviceLoginStarted = .now
        return DeviceLoginCode(userCode: "K7QF-2M9D", verificationUrl: "https://auth.openai.com/codex/device")
    }

    func cancelChatGPTDeviceLogin() async { deviceLoginStarted = nil }

    func logOut(_ account: AIAccount, moveExisting: Bool) async throws {
        try await pause(0.5)
        loggedIn.remove(account)
        loggedOut.insert(account)
    }

    /// Claude's login without a terminal: the sign-in page comes after a
    /// beat, and any code logs in but "wrong", which the login refuses.
    func claudeLoginSocket() -> LoginSocket? {
        DemoLoginSocket { [weak self] in
            self?.loggedOut.remove(.claude)
            self?.loggedIn.insert(.claude)
        }
    }

    func romeCredits() async throws -> RomeCreditsResponse.Credits? {
        .init(availableMicros: "2000000", balanceMicros: "2000000", grantedMicros: "5000000", enabled: true)
    }

    func answerInteraction(sessionId: String, toolUseId: String, output: JSONValue) async throws {}

    func switchProviderFailure(messageId: String, change: JSONValue) async throws -> Bool {
        let to = change["provider"]?.string.map(DefaultModelProvider.init(wire:))
        // This chat only: it stays on that account, pinned there.
        if let to, to != .romeCredits, change["makeDefault"]?.bool != true,
           let chatId = messages.first(where: { $0.value.contains { $0.id == messageId } })?.key {
            pinned[chatId] = .init(by: "kept", providerId: to.wire, selection: nil, model: nil)
        }
        if change["makeDefault"]?.bool == true, let to { chosenDefault = to }
        settleFailure(messageId, resolved: .object(["at": .string(RomeDate.string(.now)), "by": .string("switched"), "provider": to.map { .string($0.wire) } ?? .null, "model": change["selection"] ?? .null, "continued": .bool(true)]))
        return false
    }

    func continueProviderFailure(messageId: String) async throws {
        settleFailure(messageId, resolved: .object(["at": .string(RomeDate.string(.now)), "by": .string("recovered"), "continued": .bool(true)]))
    }

    /// As the server does once the stopped turn runs again: the card's message
    /// is rewritten settled, a moment later, and handed out again.
    private func settleFailure(_ messageId: String, resolved: JSONValue) {
        Task {
            try? await pause(1.5)
            for (sessionId, list) in messages {
                guard let index = list.firstIndex(where: { $0.id == messageId }),
                      let data = list[index].content.data(using: .utf8),
                      case .array(let items)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
                let settled: [JSONValue] = items.map { item in
                    guard item["type"]?.string == "provider_failure", case .object(var fields) = item else { return item }
                    fields["resolved"] = resolved
                    return .object(fields)
                }
                messages[sessionId]?[index].content = json(settled)
                if let message = messages[sessionId]?[index] { bus.emit(LiveTopic.chat(sessionId), .messageInsert(message)) }
            }
        }
    }

    func setConciergeEnabled(_ enabled: Bool) async throws {}

    func search(_ query: String) async throws -> [SearchHit] {
        try await pause(0.3)
        var hits: [SearchHit] = []
        for (sessionId, list) in messages {
            for message in list where !message.isTrace {
                let text = message.parts.compactMap(\.textContent).joined(separator: " ")
                guard text.localizedCaseInsensitiveContains(query) else { continue }
                let session = chats[sessionId]
                    ?? archivedTopics.first { $0.id == sessionId }.map { ChatSession(id: $0.id, name: $0.name, agentName: ChatSession.conciergeAgent, archivedAt: RomeDate.string(.now)) }
                    ?? ChatSession(id: sessionId, name: "Chat")
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
        case .full, .visitor, .updateOffered, .longChat, .olderTopics:
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

    /// An `ask_question` card as core stores it: the question card's props,
    /// with the same card described as data in `render.ui`.
    static let dinnerQuestion: JSONValue = try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"pending_interaction","toolUseId":"q-dinner","appId":"core","render":{"kind":"inline","componentId":"question-card","props":{"questions":[{"id":"dinner","question":"晚饭想吃哪种？","type":"single","options":["高蛋白","清淡一点"],"optionDescriptions":{"高蛋白":"鸡胸肉、豆腐、鸡蛋"},"freeText":true},{"id":"avoid","question":"有不想吃的吗？","type":"multi","options":["辣","海鲜","乳制品"],"optional":true}]},"builtin":true,"ui":{"components":[{"id":"q0-text","component":"Text","text":"晚饭想吃哪种？","variant":"h5"},{"id":"q0-title","component":"Row","children":["q0-text"]},{"id":"q0-pick","component":"ChoicePicker","variant":"mutuallyExclusive","options":[{"label":"高蛋白","value":"高蛋白","description":"鸡胸肉、豆腐、鸡蛋"},{"label":"清淡一点","value":"清淡一点"}],"value":{"path":"/answers/0/values"},"clears":{"path":"/answers/0/text"}},{"id":"q0-own","component":"TextField","label":"晚饭想吃哪种？","value":{"path":"/answers/0/text"},"variant":"shortText","placeholder":{"string":"typeOwn"},"clears":{"path":"/answers/0/values"}},{"id":"q0","component":"Column","children":["q0-title","q0-pick","q0-own"]},{"id":"q1-text","component":"Text","text":"有不想吃的吗？","variant":"h5"},{"id":"q1-optional","component":"Text","text":{"string":"optional"},"variant":"caption"},{"id":"q1-title","component":"Row","children":["q1-text","q1-optional"]},{"id":"q1-pick","component":"ChoicePicker","variant":"multipleSelection","options":[{"label":"辣","value":"辣"},{"label":"海鲜","value":"海鲜"},{"label":"乳制品","value":"乳制品"}],"value":{"path":"/answers/1/values"}},{"id":"q1","component":"Column","children":["q1-title","q1-pick"]},{"id":"send-label","component":"Text","text":{"string":"send"}},{"id":"send","component":"Button","child":"send-label","variant":"primary","action":{"event":{"name":"send","context":{"answers":{"path":"/answers"}}}},"checks":[{"condition":{"call":"or","args":{"values":[{"call":"required","args":{"value":{"path":"/answers/0/values"}}},{"call":"required","args":{"value":{"path":"/answers/0/text"}}}]}},"message":""}]},{"id":"dismiss-label","component":"Text","text":{"string":"dismiss"}},{"id":"dismiss","component":"Button","child":"dismiss-label","variant":"borderless","action":{"event":{"name":"dismiss"}}},{"id":"actions","component":"Row","children":["dismiss","send"],"justify":"end"},{"id":"root","component":"Column","children":["q0","q1","actions"]}],"data":{"answers":[{"values":[],"text":""},{"values":[],"text":""}]}}}}"#.utf8))

    /// The question cards core describes from the demo's questions
    /// (`questionCardUi`), by tool use id, and the card an answer to `q-login`
    /// is shown as (`questionCardFromAnswers`).
    static let questionCards: JSONValue = try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"q-hk":{"components":[{"id":"q0-text","component":"Text","text":"你是想查海口明天的天气，还是了解海口这座城市？","variant":"h5"},{"id":"q0-title","component":"Row","children":["q0-text"]},{"id":"q0-pick","component":"ChoicePicker","variant":"mutuallyExclusive","options":[{"label":"查明天的天气","value":"查明天的天气"},{"label":"了解这座城市","value":"了解这座城市"}],"value":{"path":"/answers/0/values"},"clears":{"path":"/answers/0/text"}},{"id":"q0-own","component":"TextField","label":"你是想查海口明天的天气，还是了解海口这座城市？","value":{"path":"/answers/0/text"},"variant":"shortText","placeholder":{"string":"typeOwn"},"clears":{"path":"/answers/0/values"}},{"id":"q0","component":"Column","children":["q0-title","q0-pick","q0-own"]},{"id":"send-label","component":"Text","text":{"string":"send"}},{"id":"send","component":"Button","child":"send-label","variant":"primary","action":{"event":{"name":"send","context":{"answers":{"path":"/answers"}}}},"checks":[{"condition":{"call":"or","args":{"values":[{"call":"required","args":{"value":{"path":"/answers/0/values"}}},{"call":"required","args":{"value":{"path":"/answers/0/text"}}}]}},"message":""}]},{"id":"dismiss-label","component":"Text","text":{"string":"dismiss"}},{"id":"dismiss","component":"Button","child":"dismiss-label","variant":"borderless","action":{"event":{"name":"dismiss"}}},{"id":"actions","component":"Row","children":["dismiss","send"],"justify":"end"},{"id":"root","component":"Column","children":["q0","actions"]}],"data":{"answers":[{"values":[],"text":""}]}},"q-mail":{"components":[{"id":"q0-text","component":"Text","text":"摘要里要包括哪些？","variant":"h5"},{"id":"q0-title","component":"Row","children":["q0-text"]},{"id":"q0-pick","component":"ChoicePicker","variant":"multipleSelection","options":[{"label":"需要我回复的","value":"需要我回复的","description":"别人在等你答复的邮件"},{"label":"账单和收据","value":"账单和收据"},{"label":"新闻简报","value":"新闻简报","description":"订阅的周报和新闻"}],"value":{"path":"/answers/0/values"}},{"id":"q0","component":"Column","children":["q0-title","q0-pick"]},{"id":"q1-text","component":"Text","text":"几点发给你？","variant":"h5"},{"id":"q1-title","component":"Row","children":["q1-text"]},{"id":"q1-own","component":"TextField","label":"几点发给你？","value":{"path":"/answers/1/text"},"variant":"longText","placeholder":{"string":"typeAnswer"}},{"id":"q1","component":"Column","children":["q1-title","q1-own"]},{"id":"send-label","component":"Text","text":{"string":"send"}},{"id":"send","component":"Button","child":"send-label","variant":"primary","action":{"event":{"name":"send","context":{"answers":{"path":"/answers"}}}},"checks":[{"condition":{"call":"required","args":{"value":{"path":"/answers/0/values"}}},"message":""},{"condition":{"call":"required","args":{"value":{"path":"/answers/1/text"}}},"message":""}]},{"id":"dismiss-label","component":"Text","text":{"string":"dismiss"}},{"id":"dismiss","component":"Button","child":"dismiss-label","variant":"borderless","action":{"event":{"name":"dismiss"}}},{"id":"actions","component":"Row","children":["dismiss","send"],"justify":"end"},{"id":"root","component":"Column","children":["q0","q1","actions"]}],"data":{"answers":[{"values":["需要我回复的"],"text":""},{"values":[],"text":"每天早上 8 点"}]}},"q-1":{"components":[{"id":"q0-text","component":"Text","text":"调研范围只看国内产品，还是包括海外？","variant":"h5"},{"id":"q0-title","component":"Row","children":["q0-text"]},{"id":"q0-pick","component":"ChoicePicker","variant":"mutuallyExclusive","options":[{"label":"只看国内","value":"只看国内"},{"label":"包括海外","value":"包括海外"}],"value":{"path":"/answers/0/values"},"clears":{"path":"/answers/0/text"}},{"id":"q0-own","component":"TextField","label":"调研范围只看国内产品，还是包括海外？","value":{"path":"/answers/0/text"},"variant":"shortText","placeholder":{"string":"typeOwn"},"clears":{"path":"/answers/0/values"}},{"id":"q0","component":"Column","children":["q0-title","q0-pick","q0-own"]},{"id":"send-label","component":"Text","text":{"string":"send"}},{"id":"send","component":"Button","child":"send-label","variant":"primary","action":{"event":{"name":"send","context":{"answers":{"path":"/answers"}}}},"checks":[{"condition":{"call":"or","args":{"values":[{"call":"required","args":{"value":{"path":"/answers/0/values"}}},{"call":"required","args":{"value":{"path":"/answers/0/text"}}}]}},"message":""}]},{"id":"dismiss-label","component":"Text","text":{"string":"dismiss"}},{"id":"dismiss","component":"Button","child":"dismiss-label","variant":"borderless","action":{"event":{"name":"dismiss"}}},{"id":"actions","component":"Row","children":["dismiss","send"],"justify":"end"},{"id":"root","component":"Column","children":["q0","actions"]}],"data":{"answers":[{"values":[],"text":""}]}},"q-login":{"components":[{"id":"q0-text","component":"Text","text":"深色模式下按钮用珊瑚色，还是用中性色？","variant":"h5"},{"id":"q0-title","component":"Row","children":["q0-text"]},{"id":"q0-pick","component":"ChoicePicker","variant":"mutuallyExclusive","options":[{"label":"珊瑚色","value":"珊瑚色"},{"label":"中性色","value":"中性色"}],"value":{"path":"/answers/0/values"}},{"id":"q0","component":"Column","children":["q0-title","q0-pick"]},{"id":"send-label","component":"Text","text":{"string":"send"}},{"id":"send","component":"Button","child":"send-label","variant":"primary","action":{"event":{"name":"send","context":{"answers":{"path":"/answers"}}}},"checks":[{"condition":{"call":"required","args":{"value":{"path":"/answers/0/values"}}},"message":""}]},{"id":"dismiss-label","component":"Text","text":{"string":"dismiss"}},{"id":"dismiss","component":"Button","child":"dismiss-label","variant":"borderless","action":{"event":{"name":"dismiss"}}},{"id":"actions","component":"Row","children":["dismiss","send"],"justify":"end"},{"id":"root","component":"Column","children":["q0","actions"]}],"data":{"answers":[{"values":[],"text":""}]}},"q-login-card":[{"values":["珊瑚色"],"text":""}]}"#.utf8))

    /// A share-location card as core stores it (`locationCardUi`).
    /// `autoShare` marks the card as core does for a turn the guardian's own
    /// message started, so the app may answer it by itself.
    static func locationCard(_ toolUseId: String, reason: String, autoShare: Bool = false, appId: String = "core") -> JSONValue {
        func c(_ id: String, _ kind: String, _ props: [String: JSONValue]) -> JSONValue {
            .object(props.merging(["id": .string(id), "component": .string(kind)]) { a, _ in a })
        }
        let ids = { (list: [String]) in JSONValue.array(list.map(JSONValue.string)) }
        let event = { (name: String) in JSONValue.object(["event": .object(["name": .string(name)])]) }
        return .object([
            "type": .string("pending_interaction"), "toolUseId": .string(toolUseId), "appId": .string(appId),
            "render": .object([
                "kind": .string("inline"), "componentId": .string("location-card"), "builtin": .bool(true),
                "props": .object(autoShare ? ["reason": .string(reason), "autoShare": .bool(true)] : ["reason": .string(reason)]),
                "ui": .object([
                    "data": .object((autoShare ? ["autoShare": .bool(true)] : [:]).merging([
                        "romeStrings": .object(["shareLocationTitle": .string("Share your location?"), "notNow": .string("Not now"), "share": .string("Share")]),
                    ]) { a, _ in a }),
                    "components": .array([
                    c("root", "Column", ["children": ids(["title", "note", "actions"])]),
                    c("title", "Text", ["text": .object(["path": .string("/romeStrings/shareLocationTitle")]), "variant": .string("h4"), "icon": .string("map-pin")]),
                    c("note", "Text", ["text": .string(reason), "variant": .string("caption")]),
                    c("actions", "Row", ["children": ids(["dismiss", "confirm"]), "justify": .string("end")]),
                    c("dismiss", "Button", ["child": .string("dismiss-label"), "variant": .string("default"), "action": event("decline")]),
                    c("dismiss-label", "Text", ["text": .object(["path": .string("/romeStrings/notNow")])]),
                    c("confirm", "Button", ["child": .string("confirm-label"), "variant": .string("primary"), "action": event("share-location")]),
                    c("confirm-label", "Text", ["text": .object(["path": .string("/romeStrings/share")])]),
                    ]),
                ]),
            ]),
        ])
    }

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

    /// An agent card: Rome's own widget whose look the Concierge wrote.
    private static func agentCard(_ id: String, text: String, _ components: [JSONValue]) -> JSONValue {
        .object([
            "type": .string("widget"), "toolUseId": .string(id), "appId": .string("core"),
            "text": .string(text), "ui": .object(["components": .array(components)]),
        ])
    }

    private static func component(_ id: String, _ kind: String, _ props: [String: JSONValue]) -> JSONValue {
        .object(props.merging(["id": .string(id), "component": .string(kind)]) { a, _ in a })
    }

    static let agentItinerary: JSONValue = {
        let c = DemoBackend.component
        let ids = { (list: [String]) in JSONValue.array(list.map(JSONValue.string)) }
        // Each stop opens in Maps; the last opens the restaurant's page.
        let stops = [
            ("9:00", "浅草寺，早去人少", "maps://?q=Senso-ji"),
            ("11:30", "上野公园，午饭在阿美横町", "maps://?q=Ueno+Park"),
            ("14:00", "秋叶原", "maps://?q=Akihabara"),
            ("18:30", "新宿思出横丁晚饭", "https://www.omoide-yokocho.com"),
        ]
        var components = [
            c("root", "Column", ["children": ids(["title", "subtitle", "steps"])]),
            c("title", "Text", ["text": .string("周六东京一日"), "variant": .string("h3")]),
            c("subtitle", "Text", ["text": .string("点一站在地图里打开"), "variant": .string("caption")]),
            c("steps", "List", ["children": ids(stops.indices.map { "s\($0)" })]),
        ]
        for (i, stop) in stops.enumerated() {
            components.append(c("s\(i)", "Row", ["children": ids(["t\(i)", "p\(i)"]), "href": .string(stop.2)]))
            components.append(c("t\(i)", "Text", ["text": .string(stop.0), "variant": .string("caption")]))
            components.append(c("p\(i)", "Text", ["text": .string(stop.1)]))
        }
        return DemoBackend.agentCard("agent-itinerary", text: "周六东京一日：9:00 浅草寺；11:30 上野公园；14:00 秋叶原；18:30 新宿晚饭。", components)
    }()

    /// A routine's daily health summary, the case agent cards are for: each
    /// number against its usual range, the week's steps, and one line to act on.
    static let agentHealth: JSONValue = {
        let c = DemoBackend.component
        let ids = { (list: [String]) in JSONValue.array(list.map(JSONValue.string)) }
        let range = { (low: Double, high: Double) in JSONValue.object(["low": .number(low), "high": .number(high)]) }
        let week: [(String, Double, String?)] = [("一", 8120, nil), ("二", 9340, nil), ("三", 7650, nil), ("四", 10210, nil), ("五", 8890, nil), ("六", 2980, "warning"), ("今天", 4210, "accent")]
        let points = JSONValue.array(week.map { day in
            var point: [String: JSONValue] = ["label": .string(day.0), "value": .number(day.1)]
            if let highlight = day.2 { point["highlight"] = .string(highlight) }
            return .object(point)
        })
        return DemoBackend.agentCard("agent-health", text: "今天的健康，对比最近 14 天：睡眠 7.2 小时（通常 7–7.7），4,210 步（通常 8,000–10,000），活动 512 千卡（通常 450–600），锻炼 12 分钟（通常 30–45），静息心率 64（通常 56–60）。今晚散步 30 分钟能补上大半步数。", [
            c("root", "Column", ["children": ids(["title", "subtitle", "stats", "week", "advice"])]),
            c("title", "Text", ["text": .string("今天的健康"), "variant": .string("h4")]),
            c("subtitle", "Text", ["text": .string("对比最近 14 天"), "variant": .string("caption")]),
            c("stats", "Row", ["children": ids(["sleep", "steps", "kcal", "exercise", "rhr"])]),
            c("sleep", "Stat", ["label": .string("睡眠"), "value": .number(7.2), "unit": .string("小时"), "range": range(7, 7.7), "icon": .string("moon")]),
            c("steps", "Stat", ["label": .string("步数"), "value": .number(4210), "range": range(8000, 10000), "icon": .string("steps")]),
            c("kcal", "Stat", ["label": .string("活动"), "value": .number(512), "unit": .string("千卡"), "range": range(450, 600), "icon": .string("flame")]),
            c("exercise", "Stat", ["label": .string("锻炼"), "value": .number(12), "unit": .string("分钟"), "range": range(30, 45), "icon": .string("run")]),
            c("rhr", "Stat", ["label": .string("静息心率"), "value": .number(64), "unit": .string("次/分"), "range": range(56, 60), "icon": .string("heart")]),
            c("week", "Chart", ["kind": .string("bar"), "points": points, "caption": .string("最近 7 天步数")]),
            c("advice", "Text", ["text": .string("今晚散步 30 分钟，能补上大半步数。"), "tone": .string("info")]),
        ])
    }()

    func sendFeedback(_ text: String) async throws {
        try await pause(0.8)
    }

    // MARK: Helpers

    // MARK: Updates

    nonisolated static let releasedVersion = "1.1.197"
    /// Below the app's minimum, and between it and the latest.
    nonisolated static let tooOldVersion = "1.1.120"
    nonisolated static let offeredFromVersion = "1.1.196"
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
        let message = Self.withThreadRoots(Self.withTurns((messages[sessionId] ?? []) + [message])).last ?? message
        messages[sessionId, default: []].append(message)
        bus.emit(LiveTopic.chat(sessionId), .messageInsert(message))
    }

    private func setRunning(_ sessionId: String, _ turnId: String?) {
        running[sessionId] = turnId
        chats[sessionId]?.running = turnId != nil
        if turnId != nil, topicChats.contains(where: { $0.id == sessionId }) { topicActivity[sessionId] = .now }
        let event = LiveEvent.sessionRunning(sessionId: sessionId, running: turnId != nil)
        bus.emit(LiveTopic.chatStatus, event)
        bus.emit(LiveTopic.chat(sessionId), event)
        // As a Claude turn does: it writes while it runs.
        if let turn = turnId ?? writingTurn[sessionId] {
            writingTurn[sessionId] = turnId
            bus.emit(LiveTopic.chat(sessionId), .messageWriting(sessionId: sessionId, turnId: turn, mode: .exact, writing: turnId != nil))
        }
    }
    private var writingTurn: [String: String] = [:]

    private func json(_ parts: [JSONValue]) -> String {
        String(data: (try? JSONEncoder().encode(parts)) ?? Data(), encoding: .utf8) ?? "[]"
    }

    /// A guardian-side message said by the Concierge, as the instance marks it.
    private func saidByConcierge(_ message: ChatMessage) -> ChatMessage {
        var message = message
        message.sender = MessageSender(kind: "automated", sourceType: "agent", name: "Milo", onBehalfOf: nil)
        return message
    }

    /// The message with the quote of `original` as its first part, as the
    /// server stores a reply; the message itself when there is nothing to quote.
    private func quoting(_ message: ChatMessage, _ original: ChatMessage?) -> ChatMessage {
        guard let original, let text = MessagePart.parse(original.content).lazy.compactMap(\.textContent).first,
              let stored = try? JSONDecoder().decode([JSONValue].self, from: Data(message.content.utf8)) else { return message }
        var message = message
        let quote: JSONValue = .object([
            "type": .string("reply_to"), "messageId": .string(original.id),
            "author": .string(original.isUser ? "guardian" : "agent"), "text": .string(text),
        ])
        message.content = json([quote] + stored)
        return message
    }

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
            // An expired question closes too, as the instance fills it in.
            "since": .number(since.timeIntervalSince1970 * 1000), "expired": .bool(expired), "closed": .bool(expired),
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
            "chat-research": ChatSession(id: "chat-research", name: "竞品定价调研", triggerKind: "concierge", running: false, lastTurnFailed: false, awaitingGuardian: false),
            "chat-site": ChatSession(id: "chat-site", name: "官网首页双语文案", triggerKind: "concierge", running: true, lastTurnFailed: false, awaitingGuardian: false),
            "chat-notes": ChatSession(id: "chat-notes", name: "整理本周会议纪要", triggerKind: "concierge", running: true, lastTurnFailed: false, awaitingGuardian: false),
            "chat-notion": ChatSession(id: "chat-notion", name: "同步 Notion 数据库：把客户、订单和每周报告三张表合到一起", triggerKind: "concierge", running: false, lastTurnFailed: true, awaitingGuardian: false),
            "chat-login": ChatSession(id: "chat-login", name: "修复登录页样式", triggerKind: "concierge", running: false, lastTurnFailed: false, awaitingGuardian: false),
        ]
        running = ["chat-site": "turn-site", "chat-notes": "turn-notes"]
        shares = [
            "topic-trip": [
                ChatShareLink(id: "share-trip", url: "/share/demo-trip", title: "京都旅行计划", createdAt: RomeDate.string(.now.addingTimeInterval(-2 * 3600)), chatId: "topic-trip", chatName: "京都旅行计划"),
                ChatShareLink(id: "share-weather", url: "/share/demo-weather", title: "四月京都天气", createdAt: RomeDate.string(at(21, 5, daysAgo: 3)), chatId: "topic-trip", chatName: "京都旅行计划"),
            ],
            conciergeChatID: [
                ChatShareLink(id: "share-digest", url: "/share/demo-digest", title: "本周日程摘要", createdAt: RomeDate.string(at(9, 30, daysAgo: 1)), chatId: conciergeChatID, chatName: "Chat"),
            ],
            "topic-meals": [
                ChatShareLink(id: "share-meals", url: "/share/demo-meals", title: "一周晚餐菜单", createdAt: RomeDate.string(at(19, 12, daysAgo: 6)), chatId: "topic-meals", chatName: "今天吃了什么"),
            ],
        ]

        topicChats = [
            ConciergeChat(id: "topic-trip", name: "京都旅行计划", main: false, unread: 2),
            ConciergeChat(id: "topic-home", name: "家里装修：厨房翻新、浴室防水和客厅灯具的预算与师傅安排", main: false, unread: 0),
            ConciergeChat(id: "topic-meals", name: "今天吃了什么", main: false, unread: 0),
            ConciergeChat(id: "topic-location", name: "附近的咖啡馆", main: false, unread: 0),
            ConciergeChat(id: "topic-books", name: "读书笔记", main: false, unread: 0),
            ConciergeChat(id: "topic-mail", name: "每天的邮件摘要", main: false, unread: 0),
            ConciergeChat(id: "topic-mail-setup", name: "邮件摘要设置", main: false, unread: 0),
            ConciergeChat(id: "topic-health", name: "睡眠和日程", main: false, unread: 0),
            ConciergeChat(id: "topic-routine", name: "每周读书提醒", main: false, unread: 0),
            ConciergeChat(id: "topic-table", name: "耳机比价", main: false, unread: 0),
            ConciergeChat(id: "topic-errors", name: "出错的情况", main: false, unread: 0),
            ConciergeChat(id: "topic-lists", name: "搬家清单", main: false, unread: 0),
            ConciergeChat(id: "topic-cards", name: "周末安排", main: false, unread: 0),
            ConciergeChat(id: "topic-itinerary", name: "东京一日", main: false, unread: 0),
            ConciergeChat(id: "topic-task-links", name: "任务进度", main: false, unread: 0),
            ConciergeChat(id: "topic-reply-links", name: "资料都放哪了", main: false, unread: 0),
            ConciergeChat(id: "topic-ai", name: "连接 AI", main: false, unread: 0),
            ConciergeChat(id: "topic-provider", name: "模型出问题", main: false, unread: 0),
        ]
        // Latest first in the drawer: the trip, then the errors, and so on.
        // The cafés come eighth, past the first five, for the drawer over it.
        let minutesAgo = ["topic-trip": 2, "topic-errors": 5, "topic-home": 30, "topic-books": 60, "topic-meals": 90, "topic-mail": 120, "topic-table": 180, "topic-location": 240, "topic-health": 300, "topic-routine": 400, "topic-mail-setup": 500, "topic-lists": 600, "topic-cards": 700, "topic-itinerary": 800, "topic-task-links": 900, "topic-reply-links": 1000, "topic-ai": 1100, "topic-provider": 1200]
        topicActivity = minutesAgo.mapValues { Date.now.addingTimeInterval(Double(-$0 * 60)) }

        // Archived topic chats, out of the drawer's list: the drawer's
        // Archived group lists them, and each opens read only. The car's
        // archive moved a follow to the main chat, so its Restore asks about it.
        archivedTopics = [
            ConciergeChat(id: "topic-archived-gift", name: "生日礼物清单", main: false),
            ConciergeChat(id: "topic-archived-car", name: "二手车比价", main: false),
            ConciergeChat(id: "topic-archived-gym", name: "健身房年卡", main: false),
            ConciergeChat(id: "topic-archived-photos", name: "整理旧照片", main: false),
            ConciergeChat(id: "topic-archived-holiday", name: "国庆出行", main: false),
            ConciergeChat(id: "topic-archived-tax", name: "个税年度汇算", main: false),
            ConciergeChat(id: "topic-archived-lease", name: "租房合同", main: false),
        ]
        let archivedDays = [
            "topic-archived-gift": 1, "topic-archived-car": 6, "topic-archived-gym": 12, "topic-archived-photos": 26,
            "topic-archived-holiday": 40, "topic-archived-tax": 120, "topic-archived-lease": 400,
        ]
        for (id, days) in archivedDays {
            topicActivity[id] = Date.now.addingTimeInterval(Double(-days * 86400))
        }
        movedFollows["topic-archived-car"] = [.init(source: "gmail", label: "Gmail", target: "dealer@example.com")]
        messages["topic-archived-car"] = [
            user("car-1", "帮我比较一下这三辆二手车：2019 款卡罗拉、2020 款思域和 2018 款马自达 3。", at: at(20, 10, daysAgo: 6), session: "topic-archived-car"),
            agent("三辆车里，2020 款思域里程最少、车况记录最完整，但价格高出约 1.2 万。卡罗拉保值率最好，保养也最便宜。马自达 3 开起来最好，但有一次小事故记录。\n\n如果你主要在市区通勤，我推荐卡罗拉。", at: at(20, 11, daysAgo: 6), session: "topic-archived-car"),
            user("car-2", "就卡罗拉吧，帮我盯着车商的邮件。", at: at(20, 15, daysAgo: 6), session: "topic-archived-car"),
            agent("好的，我会关注车商发来的邮件，有报价或试驾时间就告诉你。", at: at(20, 15, daysAgo: 6), session: "topic-archived-car"),
        ]
        messages["topic-archived-holiday"] = [
            user("holiday-1", "国庆去哪儿人少一点？", at: at(9, 0, daysAgo: 40), session: "topic-archived-holiday"),
            agent("可以考虑错峰去皖南的小村子，比如查济或屏山，人比宏村少很多。", at: at(9, 1, daysAgo: 40), session: "topic-archived-holiday"),
        ]
        messages["topic-archived-tax"] = [
            user("tax-1", "个税汇算要准备什么？", at: at(19, 30, daysAgo: 120), session: "topic-archived-tax"),
            agent("准备好全年的收入明细和专项附加扣除的材料，在个税 App 里核对后提交就行。", at: at(19, 31, daysAgo: 120), session: "topic-archived-tax"),
        ]

        func task(_ id: String, _ title: String, _ state: TaskState, chat: String?, from topic: String? = nil, summary: String? = nil, waitingOn: String? = nil, minutesAgo: Double, due: Double? = nil, done: Bool = false, status: String? = nil, endReason: String? = nil, wait: JSONValue? = nil) -> ConciergeTask {
            let updated = nowMs - minutesAgo * 60_000
            return ConciergeTask(
                id: id, title: title, state: state, summary: summary, waitingOn: waitingOn,
                dueAt: due.map { nowMs + $0 * 60_000 }, rank: nil,
                chat: chat.map { .init(id: $0, name: chats[$0]?.name ?? title) },
                conciergeChat: topic.flatMap { id in topicChats.first { $0.id == id } },
                sourceMessageId: nil, createdAt: updated - 3_600_000, updatedAt: updated,
                completedAt: done ? updated : nil, archivedAt: nil, notSynced: false,
                status: status, endReason: endReason, openWait: wait
            )
        }
        tasks = [
            task("t1", "价格追踪：发提醒邮件", .needsUser, chat: "chat-price", waitingOn: "需要批准发送邮件", minutesAgo: 10, status: "needs_you", wait: .object(["kind": .string("approval"), "id": .string("ap-1"), "since": .number(nowMs - 10 * 60_000)])),
            // Its question waited more than a day: it ended for no response.
            task("t2", "竞品定价调研", .done, chat: "chat-research", waitingOn: "在等你回答调研范围", minutesAgo: 25, status: "ended", endReason: "no_response"),
            task("t3", "官网首页双语文案", .doing, chat: "chat-site", summary: "正在逐段翻译首页文案", minutesAgo: 2, status: "active"),
            task("t4", "整理本周会议纪要", .doing, chat: "chat-notes", summary: "已读完 3 份纪要", minutesAgo: 8),
            task("t5", "同步 Notion 数据库", .doing, chat: "chat-notion", summary: "Notion 连接已过期", minutesAgo: 60 * 15),
            task("t6", "每周一整理周报", .next, chat: nil, summary: "下周一早上开始", minutesAgo: 120, due: 60 * 30),
            task("t7", "盯着降噪耳机价格", .watching, chat: nil, summary: "每天早上 9 点检查一次", minutesAgo: 300, due: 60 * 14),
            task("t8", "修复登录页样式", .done, chat: "chat-login", summary: "按钮间距和深色模式都改好了", minutesAgo: 60 * 24 * 3, done: true, status: "ended", endReason: "done"),
            task("t9", "比较京都三家酒店", .doing, chat: nil, from: "topic-trip", summary: "正在看评价和价格", minutesAgo: 6, status: "active"),
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
                // The last answer opens with bold that closes after `。`.
                agent(index == 23
                    ? "**第 24 章的重点：先把大问题拆小。**每个小问题都能在一天内做完，然后用一个简单的清单跟踪进度。"
                    : "第 \(index + 1) 章讲的是作者怎么把一个大问题拆成几个小问题，每个小问题都能在一天内做完，然后用一个简单的清单跟踪进度。", at: time.addingTimeInterval(30), session: "topic-books"),
            ]
        }
        // The weather's question and answer sit between the trip's messages.
        // The last word is the guardian's reply to the hotel message, with its quote.
        messages["topic-trip"] = [
            user("k1", "四月去京都五天，帮我排个行程。", at: at(8, 50), session: "topic-trip"),
            agent("好。先定住处：我比较三家酒店的位置和价格，再按区域排每天的行程。", at: at(8, 51), session: "topic-trip"),
            user("k4", "顺便看下四月京都的天气。", at: at(8, 58), session: "topic-trip"),
            agent("四月白天 15–20 度，早晚凉，带件外套。月初樱花还在。", at: at(8, 59), session: "topic-trip"),
            agent("酒店比较好了：河原町那家离车站最近，价格中等。\n\n![河原町酒店外观](/api/projects/asset/hotel.jpg?path=projects%2Fdemo%2Ftrip%2Fhotel.jpg)\n\n要我按它来排吗？", at: at(9, 20), session: "topic-trip", id: "k5"),
            reply("k6", "就按它排。", to: "k5", quoting: "酒店比较好了：河原町那家离车站最近，价格中等。", at: at(9, 24), session: "topic-trip"),
        ]
        // A photo the guardian sent, stored the way the server stores it, and a long reply.
        let kitchen = "projects/demo/home/kitchen.jpg"
        assets[kitchen] = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 450)).image { context in
            UIColor(red: 0.85, green: 0.72, blue: 0.55, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 600, height: 450))
            UIColor(red: 0.45, green: 0.32, blue: 0.22, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 300, width: 600, height: 150))
        }.jpegData(compressionQuality: 0.8)
        // Two more rooms, so a message of photos pages between different ones.
        let bathroom = "projects/demo/home/bathroom.jpg"
        let lamp = "projects/demo/home/lamp.jpg"
        for (path, wall, floor) in [(bathroom, UIColor(red: 0.7, green: 0.84, blue: 0.86, alpha: 1), UIColor(red: 0.9, green: 0.92, blue: 0.94, alpha: 1)),
                                    (lamp, UIColor(red: 0.3, green: 0.32, blue: 0.42, alpha: 1), UIColor(red: 0.98, green: 0.85, blue: 0.45, alpha: 1))] {
            assets[path] = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 450)).image { context in
                wall.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 600, height: 450))
                floor.setFill()
                context.fill(CGRect(x: 0, y: 300, width: 600, height: 150))
            }.jpegData(compressionQuality: 0.8)
        }
        messages["topic-home"] = [
            user("h1", "厨房翻新，记下要找的师傅。\n\n- File 1: [kitchen.jpg](</\(kitchen)>)", at: at(20, 10, daysAgo: 1), session: "topic-home"),
            agent((1...20).map { "\($0). 第 \($0) 步：量好尺寸，确认材料和师傅的时间。" }.joined(separator: "\n"), at: at(20, 11, daysAgo: 1), session: "topic-home"),
        ]

        // A card the meal planner app described as data, drawn natively.
        messages["topic-meals"] = [
            user("m1", "我今天吃了多少？", at: at(12, 40), session: "topic-meals"),
            parts([Self.mealCard], at: at(12, 41), session: "topic-meals"),
            agent("到现在 1,240 千卡，离目标还差 760。晚饭可以吃点蛋白质多的。", at: at(12, 41).addingTimeInterval(2), session: "topic-meals"),
            parts([Self.dinnerQuestion], at: at(12, 41).addingTimeInterval(3), session: "topic-meals"),
        ]

        // Share-location cards in each state: shared, not shared, and open.
        let location = "topic-location"
        messages[location] = [
            user("l1", "明天这里会下雨吗？", at: at(9, 10), session: location),
            parts([Self.locationCard("loc-rain", reason: "查你所在地明天的天气")], at: at(9, 10).addingTimeInterval(2), session: location),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("loc-rain"), "output": .object([
                "status": .string("shared"), "latitude": .number(31.2), "longitude": .number(121.4),
                "accuracyMeters": .number(18), "fixedAt": .string("2026-11-14T01:10:00.000Z"),
            ])])], at: at(9, 11), session: location, role: "user"),
            agent("明天下午有小雨，出门记得带伞。", at: at(9, 11).addingTimeInterval(3), session: location),
            user("l2", "离机场多远？", at: at(9, 30), session: location),
            parts([Self.locationCard("loc-airport", reason: "算你到机场的距离")], at: at(9, 30).addingTimeInterval(2), session: location),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("loc-airport"), "output": .object([
                "status": .string("declined"), "dismissed": .bool(true),
            ])])], at: at(9, 31), session: location, role: "user"),
            agent("好的。你从哪里出发？告诉我地点就能算。", at: at(9, 31).addingTimeInterval(3), session: location),
            // A share the app made by itself shows as one centered line.
            user("l2b", "晚上会降温吗？", at: at(9, 45), session: location),
            parts([Self.locationCard("loc-night", reason: "查你所在地晚上的气温")], at: at(9, 45).addingTimeInterval(2), session: location),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("loc-night"), "output": .object([
                "status": .string("shared"), "auto": .bool(true), "latitude": .number(31.2), "longitude": .number(121.4),
                "accuracyMeters": .number(37), "fixedAt": .string("2026-11-14T01:45:00.000Z"),
            ])])], at: at(9, 46), session: location, role: "user"),
            agent("晚上降到 12 度左右，加件外套。", at: at(9, 46).addingTimeInterval(3), session: location),
            user("l3", "附近有什么好的咖啡馆？", at: at(10, 5), session: location),
            parts([Self.locationCard("loc-coffee", reason: "找你附近的咖啡馆")], at: at(10, 5).addingTimeInterval(2), session: location),
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
        let loginAsk = user("c-login", "登录页的按钮间距不对，深色模式下也看不清，修一下。", at: at(9, 58, daysAgo: 3))
        let siteAsk = user("c-site", "帮我把官网首页的文案改成中英双语", at: at(9, 12))
        let researchAsk = agent("竞品调研想确认一下范围，你看下。", at: at(9, 15), id: "c-research")
        let researchReply = reply("c-research-reply", "只看国内的就行。", to: "c-research", quoting: "竞品调研想确认一下范围，你看下。", at: at(9, 18), session: conciergeChatID)
        // Each task: a task card when it starts, its question or approval on
        // its own when it asks. The login task's cards are settled and fold;
        // the research question expired; the price approval waits. The
        // Concierge's replies to one message sit together, and a reply to an
        // earlier message shows its quote.
        messages[conciergeChatID] = [
            loginAsk,
            taskPart("chat-login", "修复登录页样式", show: "task", at: at(9, 59, daysAgo: 3)),
            taskPart("chat-login", "修复登录页样式", show: "ask", card: questionCard("q-login", "深色模式下按钮用珊瑚色，还是用中性色？", options: ["珊瑚色", "中性色"], answered: "珊瑚色", since: at(10, 10, daysAgo: 3)), at: at(10, 11, daysAgo: 3)),
            taskPart("chat-login", "修复登录页样式", show: "ask", card: approvalCard("ap-login", "发布预览环境", outcome: "approved", since: at(10, 30, daysAgo: 3)), at: at(10, 31, daysAgo: 3)),
            quoting(agent("改好了：按钮间距统一成 14 pt，深色模式下的文字换成了浅色。", at: at(10, 41, daysAgo: 3)), loginAsk),
            siteAsk,
            quoting(agent("好，我开一个任务去改。", at: at(9, 12).addingTimeInterval(20)), siteAsk),
            quoting(agent("改完告诉你。", at: at(9, 12).addingTimeInterval(21)), siteAsk),
            taskPart("chat-site", "官网首页双语文案", show: "task", at: at(9, 12).addingTimeInterval(22)),
            researchAsk,
            taskPart("chat-research", "竞品定价调研", show: "ask", card: questionCard("q-1", "调研范围只看国内产品，还是包括海外？", options: ["只看国内", "包括海外"], expired: true, since: at(9, 15)), at: at(9, 15).addingTimeInterval(1)),
            researchReply,
            quoting(agent("好，只看国内的。", at: at(9, 18).addingTimeInterval(20)), researchReply),
            agent("降噪耳机降到 ¥899 了，价格追踪想给你发提醒邮件，需要你批准。", at: at(9, 40), id: "c-price"),
            taskPart("chat-price", "价格追踪：发提醒邮件", show: "ask", card: approvalCard("ap-1", "发送邮件", since: at(9, 39).addingTimeInterval(5)), at: at(9, 40).addingTimeInterval(1)),
            // The Concierge asks and waits for an approval in the main chat too.
            renewed,
            user("c3", "海口明天怎么样？", at: at(9, 52), session: conciergeChatID),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-hk"), "appId": .string("core"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "ui": Self.questionCards["q-hk"] ?? .null, "props": .object(["questions": .array([
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
        func marked(_ message: ChatMessage, _ reaction: String?, status: String? = nil, inputState: String? = nil, turn: String? = nil) -> ChatMessage {
            var message = message
            message.turnId = turn
            message.reaction = reaction
            message.status = status
            message.inputState = inputState
            return message
        }
        func failedTrace(turn: String, error: String?, code: String? = nil, provider: String? = nil, at date: Date) -> ChatMessage {
            var message = ChatMessage(id: nextID(), sessionId: "topic-errors", turnId: turn, role: "trace", content: "[]", createdAt: RomeDate.string(date), traceSummary: TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: error, terminalErrorCode: code, terminalErrorProvider: provider))
            message.turnId = turn
            return message
        }
        messages["topic-errors"] = [
            marked(user("er1", "把今天的邮件整理一下。", at: at(13, 0), session: "topic-errors"), "👍"),
            parts([.object(["type": .string("error"), "error": .string("Selected model provider is unavailable: Codex (ChatGPT) has reached its usage limit"), "code": .string("model_provider_unavailable"), "provider": .string("openai"), "reason": .string("quota_exhausted")])], at: at(13, 0), session: "topic-errors"),
            marked(user("er2", "那就现在发给我吧。", at: at(13, 5), session: "topic-errors"), nil, status: "failed", turn: "er-t2"),
            failedTrace(turn: "er-t2", error: "You've hit your limit · resets 3pm", code: "usage_limit", provider: "openai", at: at(13, 6)),
            parts([.object(["type": .string("quota_switch"), "from": .string("openai"), "to": .string("anthropic"), "reason": .string("quota"), "fromModel": .string("gpt-6-luna"), "model": .string("claude-sonnet-5-5")])], at: at(13, 7), session: "topic-errors"),
            marked(user("er3", "好，继续。", at: at(13, 8), session: "topic-errors"), "👍", status: "working"),
            marked(user("er4", "顺便查一下周五的航班。", at: at(13, 9), session: "topic-errors"), nil, inputState: "failed"),
            marked(user("er5", "再提醒我带护照。", at: at(13, 10), session: "topic-errors"), nil, inputState: "unknown"),
            // Photos alone, with a mark: the badge sits on the photos' corner.
            // Three different ones: a tap on the third opens the viewer there.
            marked(user("er6", "- File 1: [kitchen.jpg](</\(kitchen)>)\n- File 2: [bathroom.jpg](</\(bathroom)>)\n- File 3: [lamp.jpg](</\(lamp)>)", at: at(13, 11), session: "topic-errors"), nil, status: "working"),
            // Photos with text, with a mark: the badge sits on the text bubble.
            marked(user("er6b", "厨房这样改可以吗？\n\n- File 1: [kitchen.jpg](</\(kitchen)>)", at: at(13, 11), session: "topic-errors"), "👍"),
            // Two messages in a row, the second marked: its badge sits over
            // the bubble above, never under it.
            user("er7", "还有一件事。", at: at(13, 12), session: "topic-errors"),
            marked(user("er8", "明早 8 点叫我起床。", at: at(13, 12), session: "topic-errors"), "👀", status: "working"),
        ]
        // Cards the Concierge composed itself: Rome's own, every value
        // written out, with no `bind`.
        // Task links in each status, the way the Concierge refers to its tasks.
        taskLinkInfo = Dictionary(uniqueKeysWithValues: [
            TaskLinkInfo(id: "chat-site", name: "官网首页双语文案", status: "active"),
            TaskLinkInfo(id: "chat-price", name: "价格追踪：发提醒邮件", status: "needs_you"),
            TaskLinkInfo(id: "chat-login", name: "修复登录页样式", status: "ended", endReason: "done"),
            TaskLinkInfo(id: "chat-export", name: "导出季度报表", status: "ended", endReason: "failed"),
            TaskLinkInfo(id: "chat-quotes", name: "抓取供应商报价", status: "ended", endReason: "stopped"),
            TaskLinkInfo(id: "chat-research", name: "竞品定价调研", status: "ended", endReason: "no_response"),
            TaskLinkInfo(id: "chat-weekly", name: "每周一整理周报", status: "later"),
            TaskLinkInfo(id: "chat-blur", name: "iOS 退出 task chat 后头部模糊变实心", status: "active"),
            TaskLinkInfo(id: "chat-reload", name: "iOS 长气泡展开和折叠时图片重新加载，先在 Mac mini 上复现", status: "needs_you"),
        ].map { ($0.id, $0) })
        // Chat asks to connect an AI account; the card waits on it.
        messages["topic-ai"] = [
            user("ai1", "帮我整理一下这周的日程。", at: at(9, 40), session: "topic-ai"),
            agent("先连接一个 AI 账号，我就能开始。", at: at(9, 41), session: "topic-ai"),
            parts([.object(["type": .string("pending_interaction"), "toolUseId": .string("ai-connect"), "appId": .string("rome"), "render": .object(["componentId": .string("ai-tools-card"), "builtin": .bool(true)])])], at: at(9, 41), session: "topic-ai"),
        ]
        // Provider failure cards of each kind, a settled one, and the outage notice.
        let provider = "topic-provider"
        var pauseEnd = Calendar.current.date(bySettingHour: 14, minute: 20, second: 0, of: .now) ?? .now
        if pauseEnd <= .now { pauseEnd = pauseEnd.addingTimeInterval(86_400) }
        func failure(_ fields: [String: JSONValue]) -> JSONValue {
            var part: [String: JSONValue] = ["type": .string("provider_failure"), "chatId": .string(provider), "followsDefault": .bool(true), "alternatives": .array([])]
            part.merge(fields) { _, new in new }
            return .object(part)
        }
        messages[provider] = [
            user("pf1", "把这周的会议纪要整理成一页。", at: at(10, 0), session: provider),
            parts([failure(["provider": .string("anthropic"), "reason": .string("temporary"), "card": .string("wait")])], at: at(10, 1), session: provider),
            user("pf2", "再试一次。", at: at(10, 5), session: provider),
            parts([failure(["provider": .string("openai"), "reason": .string("login"), "card": .string("account"), "alternatives": .array([.string("anthropic")]), "detail": .string("401 Unauthorized: token expired")])], at: at(10, 6), session: provider),
            user("pf3", "用 Sol 写。", at: at(10, 10), session: provider),
            parts([failure(["provider": .string("openai"), "reason": .string("model_unavailable"), "card": .string("model"), "model": .string("gpt-6-sol"), "replacement": .object(["selection": .string("gpt-6-luna"), "model": .string("gpt-6-luna")])])], at: at(10, 11), session: provider),
            user("pf4", "那换一个问题：明天几点开会？", at: at(10, 15), session: provider),
            parts([failure(["provider": .string("openai"), "reason": .string("quota"), "card": .string("wait"), "until": .string(RomeDate.string(pauseEnd)), "alternatives": .array([.string("anthropic")])])], at: at(10, 16), session: provider),
            parts([failure(["provider": .string("openai"), "reason": .string("quota"), "card": .string("wait"), "resolved": .object(["at": .string(RomeDate.string(.now)), "by": .string("switched"), "provider": .string("anthropic"), "continued": .bool(true)])])], at: at(10, 17), session: provider),
            // A model at its limit, swapped for this reply only.
            parts([.object(["type": .string("quota_switch"), "from": .string("anthropic"), "to": .string("anthropic"), "reason": .string("model_limit"), "fromModel": .string("claude-opus-5-5"), "model": .string("claude-sonnet-5-5"), "oneTurn": .bool(true)])], at: at(10, 17), session: provider),
            parts([.object(["type": .string("provider_outage"), "outageId": .string("out-1"), "provider": .string("openai"), "reason": .string("quota"), "until": .string(RomeDate.string(pauseEnd)), "chatIds": .array([.string("chat-site"), .string("chat-price")])])], at: at(10, 18), session: provider),
        ]
        // Every kind of link a reply holds: a project file whose name has a
        // space, one by its path on the instance's disk, a file no route
        // serves, a topic chat and a task chat.
        messages["topic-reply-links"] = [
            user("rl1", "行程和预算放哪了？", at: at(9, 40), session: "topic-reply-links"),
            agent("都放好了：\n\n- 行程：[京都行程](/projects/demo/trip/kyoto plan.md)\n- 预算：[budget.csv](/home/rome/.rome/default/projects/demo/trip/budget.csv)\n- 运行日志：[run.log](/tmp/run.log)\n\n要改行程就回 [京都旅行计划](/chat/topic-trip)，翻译进度在 [官网首页双语文案](/chat/chat-site)。", at: at(9, 41), session: "topic-reply-links"),
        ]
        messages["topic-task-links"] = [
            user("tl1", "我的任务都怎么样了？", at: at(9, 30), session: "topic-task-links"),
            agent("[官网首页双语文案](#rome-task=chat-site) 还在逐段翻译，好了告诉你。其余的：\n\n- [价格追踪：发提醒邮件](#rome-task=chat-price) 等你批准\n- [修复登录页样式](#rome-task=chat-login) 改好了\n- [导出季度报表](#rome-task=chat-export) 没导出来，表格权限不够\n- [抓取供应商报价](#rome-task=chat-quotes) 你停掉了\n- [竞品定价调研](#rome-task=chat-research) 没等到你的回答\n- [每周一整理周报](#rome-task=chat-weekly) 下周一开始", at: at(9, 31), session: "topic-task-links"),
            // Chips on a wrapped paragraph's first line, and one that wraps itself.
            agent("在查了：[iOS 退出 task chat 后头部模糊变实心](#rome-task=chat-blur)。会在 Mac mini 上复现、找根因，先给你看修法，不直接改。\n\n另一件：[iOS 长气泡展开和折叠时图片重新加载，先在 Mac mini 上复现](#rome-task=chat-reload) 等你确认。", at: at(9, 32), session: "topic-task-links"),
        ]
        messages["topic-itinerary"] = [
            user("it1", "周六在东京怎么安排？", at: at(9, 0), session: "topic-itinerary"),
            parts([Self.agentItinerary], at: at(9, 1), session: "topic-itinerary"),
        ]
        messages["topic-cards"] = [
            user("ac1", "周六在东京怎么安排？", at: at(10, 0), session: "topic-cards"),
            parts([Self.agentItinerary], at: at(10, 1), session: "topic-cards"),
            user("ac2", "今天身体怎么样？", at: at(10, 5), session: "topic-cards"),
            parts([Self.agentHealth], at: at(10, 6), session: "topic-cards"),
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
        // Lists nested three deep, bullets and numbers mixed.
        messages["topic-lists"] = [
            user("ls1", "下周搬家，帮我列个清单。", at: at(11, 0), session: "topic-lists"),
            agent("""
            按时间排了一下：

            1. 搬家前一周
               - 预约搬家公司
                 - 确认电梯能用
                 - 问清楚大件家具怎么拆
               - 办宽带移机
            2. 搬家当天
               1. 先搬易碎品
               2. 拍下电表和水表读数
            3. 搬完以后
               - 改快递地址
            """, at: at(11, 1), session: "topic-lists"),
        ]
        // A device connection's card, as core draws it in the guardian's
        // language from the words the phone declared (here the app's own): answered once the phone
        // connected Health, then a new one for Calendar.
        func deviceCard(_ id: String, kind: String, label: String, title: String, summary: String, icon: String) -> JSONValue {
            func c(_ id: String, _ type: String, _ fields: [String: JSONValue]) -> JSONValue {
                var object = fields
                object["id"] = .string(id)
                object["component"] = .string(type)
                return .object(object)
            }
            let context: JSONValue = .object(["kind": .string(kind)])
            return .object([
                "type": .string("pending_interaction"), "toolUseId": .string(id), "appId": .string("core"),
                "render": .object(["kind": .string("inline"), "componentId": .string("connect-card"), "builtin": .bool(true),
                    "props": .object(["kind": .string(kind), "label": .string(label), "title": .string(title), "summary": .string(summary), "device": .bool(true)]),
                    "ui": .object(["data": .object(["romeStrings": .object(["notNow": .string("Not now"), "connect": .string("Connect")])]), "components": .array([
                        c("root", "Column", ["children": .array([.string("title"), .string("note"), .string("actions")])]),
                        c("title", "Text", ["text": .string(title), "variant": .string("h4"), "icon": .string(icon)]),
                        c("note", "Text", ["text": .string(summary), "variant": .string("caption")]),
                        c("actions", "Row", ["children": .array([.string("dismiss"), .string("connect")]), "justify": .string("end")]),
                        c("dismiss", "Button", ["child": .string("dismiss-label"), "variant": .string("default"), "action": .object(["event": .object(["name": .string("dismiss"), "context": context])])]),
                        c("dismiss-label", "Text", ["text": .object(["path": .string("/romeStrings/notNow")])]),
                        c("connect", "Button", ["child": .string("connect-label"), "variant": .string("primary"), "action": .object(["event": .object(["name": .string("connect"), "context": context])])]),
                        c("connect-label", "Text", ["text": .object(["path": .string("/romeStrings/connect")])]),
                    ])]),
                ]),
            ])
        }
        messages["topic-health"] = [
            user("h1", "这周睡得怎么样？", at: at(9, 1), session: "topic-health"),
            parts([deviceCard("dc-health", kind: "apple_health", label: "Apple Health", title: String(localized: "Apple Health"), summary: String(localized: "Your Rome reads the Health data you allow."), icon: "heart")], at: at(9, 2), session: "topic-health"),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("dc-health"), "output": .object(["kind": .string("apple_health"), "status": .string("connected")])])], at: at(9, 3), session: "topic-health", role: "user"),
            agent("这周平均每晚睡 6 小时 48 分，周三最少，只有 5 小时 10 分。", at: at(9, 4), session: "topic-health"),
            user("h2", "明天下午有空吗？", at: at(9, 20), session: "topic-health"),
            parts([deviceCard("dc-calendar", kind: "apple_calendar", label: "Calendar", title: String(localized: "Calendar"), summary: String(localized: "Your Rome reads your calendars, and adds or changes events when you ask."), icon: "calendar")], at: at(9, 21), session: "topic-health"),
        ]
        messages["topic-mail-setup"] = [
            user("ms1", "摘要按什么来整理？", at: at(10, 1), session: "topic-mail-setup"),
            parts([.object([
                "type": .string("pending_interaction"), "toolUseId": .string("q-mail"), "appId": .string("core"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "ui": Self.questionCards["q-mail"] ?? .null, "props": .object(["questions": .array([
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
                "type": .string("pending_interaction"), "toolUseId": .string("q-1"), "appId": .string("core"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "ui": Self.questionCards["q-1"] ?? .null, "props": .object(["questions": .array([
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
                "type": .string("pending_interaction"), "toolUseId": .string("q-login"), "appId": .string("core"),
                "render": .object(["kind": .string("inline"), "componentId": .string("question-card"), "builtin": .bool(true), "ui": Self.questionCards["q-login"] ?? .null, "props": .object(["questions": .array([
                    .object(["id": .string("color"), "question": .string("深色模式下按钮用珊瑚色，还是用中性色？"), "type": .string("single"), "options": .array([.string("珊瑚色"), .string("中性色")])]),
                ])])]),
            ])], at: at(10, 10, daysAgo: 3), session: "chat-login"),
            parts([.object(["type": .string("interaction_result"), "toolUseId": .string("q-login"), "output": .object(["answers": .array([.object(["questionId": .string("color"), "value": .string("珊瑚色")])]), "card": Self.questionCards["q-login-card"] ?? .null])])], at: at(10, 12, daysAgo: 3), session: "chat-login", role: "user"),
            parts([.object([
                "type": .string("approval_card"), "approvalId": .string("ap-login"), "actionName": .string("coding:deploy_preview"), "status": .string("pending"),
                "preview": .object(["kind": .string("generic"), "title": .string("发布预览环境"), "summary": .string("")]),
            ])], at: at(10, 30, daysAgo: 3), session: "chat-login"),
            agent("改好了：按钮间距统一成 14 pt，深色模式下的文字换成了浅色。", at: at(10, 40, daysAgo: 3), session: "chat-login"),
        ]
        approvals["ap-login"] = ApprovalRecord(id: "ap-login", status: "approved", executionState: "succeeded", resolvedAt: RomeDate.string(at(10, 32, daysAgo: 3)))
    }
}

extension UpdateGate.Minimums {
    /// The minimums the demo's versions are set against, and the update
    /// tests with them: `tooOldVersion` blocks, `offeredFromVersion` is only
    /// offered `releasedVersion`. Fixed, so a release's raise of the real
    /// minimums (`Tools/bump-minimum.mjs`) moves neither.
    static let demo = UpdateGate.Minimums(blocking: DemoBackend.offeredFromVersion, background: DemoBackend.offeredFromVersion)
}
#endif

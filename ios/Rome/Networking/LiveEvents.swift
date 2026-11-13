import Foundation
import UIKit

/// An event from the dashboard's live-events socket (`/ws/events`).
enum LiveEvent: Sendable {
    /// A chat started or stopped running a turn (`chat.status`).
    case sessionRunning(sessionId: String, running: Bool)
    /// How the running turn shows the typing dots (`message_writing` on
    /// `chat.session:<id>`): `exact` while `writing`, or `simulated`.
    case messageWriting(sessionId: String, turnId: String, mode: WritingMode, writing: Bool)
    /// A message was stored in a chat (`chat.session:<id>`).
    case messageInsert(ChatMessage)
    /// A message was placed in a chat thread (`message_chat_thread`), with
    /// the title of the task the thread is.
    case messageThread(sessionId: String, messageId: String, chatThreadId: String?, title: String? = nil)
    /// A task left the chat and took its thread with it (`chat_thread_retired`):
    /// its messages are in no thread now.
    case threadRetired(sessionId: String, chatThreadId: String)
    /// Rome's mark on a guardian message changed (`message_status_reaction`).
    /// Nil: it has none now.
    case statusReaction(sessionId: String, messageId: String, reaction: String?)
    /// A task's question or approval that a card in the chat shows ended
    /// (`chat_card_settled`): `card` replaces the card of every part that shows it.
    case cardSettled(sessionId: String, card: JSONValue)
    /// A Concierge chat's activity changed (`concierge_activity`). Nil: a
    /// state this build does not know, shown as no status line.
    /// `at`: when it took effect on the server, epoch milliseconds.
    case conciergeActivity(chatId: String, activity: ConciergeActivity?, at: Double? = nil)
    /// The Concierge was renamed (`agent_name_changed`, newer instances).
    case agentName(String?)
    /// A chat was renamed.
    case sessionName(sessionId: String, name: String)
    /// The Concierge wrote a task row (`concierge.tasks`).
    case taskUpsert(ConciergeTask)
    /// Something a Concierge chat's task list holds changed
    /// (`tasks_changed` on `chat.tasks:<chatId>`): read the list again.
    case taskListChanged(chatId: String)
    /// Events may have been missed: the app came back to the foreground, or
    /// the socket came back after a drop. Listeners refetch what they show.
    case reconnected
}

/// How a turn shows the typing dots: `exact` where the provider says when
/// it writes a message (the dots show while it does), `simulated` where it
/// cannot (each new message waits behind the dots for a moment).
enum WritingMode: String, Sendable { case exact, simulated }

/// The source of live events. The real socket and the demo backend both implement it.
@MainActor
protocol LiveEventSource: AnyObject {
    /// Starts delivering `topic`'s events. Returns a token for `unsubscribe`.
    func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID
    func unsubscribe(_ token: UUID)
    func pause()
    func resume()
    /// The chat on the phone's screen, by the server's id, or nil for none:
    /// the instance does not push what the Concierge says there.
    func watch(_ chatId: String?)
}

extension LiveEventSource {
    /// Stand-ins (demo, tests) have no instance to tell.
    func watch(_ chatId: String?) {}
}

enum LiveTopic {
    static let chatStatus = "chat.status"
    /// What the Concierge is doing in each of the guardian's Concierge chats.
    static let conciergeActivity = "concierge.activity"
    static let conciergeTasks = "concierge.tasks"
    static func chat(_ sessionId: String) -> String { "chat.session:\(sessionId)" }
    /// A Concierge chat's task list, by the chat's server id.
    static func chatTasks(_ chatId: String) -> String { "chat.tasks:\(chatId)" }
    /// Held for the one chat on screen; it carries no events.
    static func watch(_ chatId: String) -> String { "chat.watch:\(chatId)" }
}

/// The phone's one watch: which frames move it from chat to chat.
struct ChatWatch {
    private(set) var chatId: String?

    /// The frames that move the watch to `next`: leave the old chat, then
    /// hold the new one. None when it stays.
    mutating func move(to next: String?) -> [(type: String, topic: String)] {
        guard next != chatId else { return [] }
        var frames: [(type: String, topic: String)] = []
        if let chatId { frames.append(("unsubscribe", LiveTopic.watch(chatId))) }
        if let next { frames.append(("subscribe", LiveTopic.watch(next))) }
        chatId = next
        return frames
    }

    /// What a new connection holds, if a chat is on screen.
    var topic: String? { chatId.map(LiveTopic.watch) }

    /// What a new connection subscribes, the watch first: it never meets the
    /// server's cap on data topics, whatever comes after it.
    func connecting(_ topics: Set<String>) -> [String] {
        (topic.map { [$0] } ?? []) + topics.sorted()
    }
}

/// Which view set the chat on screen, so a view replaced by a new one cannot
/// clear the chat the new one set.
struct ScreenChat {
    private(set) var chat: String?
    private var owner: UUID?

    mutating func show(_ chat: String?, by owner: UUID) {
        self.chat = chat
        self.owner = owner
    }

    /// Clears the chat only if `owner` set it last.
    mutating func hide(by owner: UUID) {
        guard self.owner == owner else { return }
        chat = nil
        self.owner = nil
    }
}

/// When the socket's listeners must refetch after a connection that followed
/// a drop or a pause: once per topic held before, when the server confirms it
/// again. Events sent before that confirmation are gone.
struct LiveResync {
    private var missed = false
    /// Topics this connection still owes a refetch for.
    private var owed: Set<String> = []

    /// The connection closed with events possibly unsent: a drop or a pause.
    mutating func dropped() { missed = true }

    /// A new connection starts with `topics`.
    mutating func connecting(topics: Set<String>) {
        owed = missed ? topics : []
        missed = false
    }

    /// The server confirmed `topic` on this connection. True when its
    /// listeners missed events and should refetch now.
    mutating func confirmed(_ topic: String) -> Bool {
        owed.remove(topic) != nil
    }
}

/// One WebSocket carries every topic. It reconnects with backoff, subscribes
/// again to what it held, and tells listeners when they may have missed events.
@MainActor
final class LiveEventsSocket: LiveEventSource {
    private struct Subscription {
        let topic: String
        let handler: @MainActor (LiveEvent) -> Void
    }

    private let client: APIClient
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var subscriptions: [UUID: Subscription] = [:]
    private var attempt = 0
    private var paused = false
    private var resync = LiveResync()
    private var reconnectWork: Task<Void, Never>?
    private var pingWork: Task<Void, Never>?
    private var generation = 0
    private var watching = ChatWatch()

    init(client: APIClient) {
        self.client = client
    }

    func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID {
        let token = UUID()
        let isNew = !subscriptions.values.contains { $0.topic == topic }
        subscriptions[token] = Subscription(topic: topic, handler: handler)
        if task == nil {
            connect()
        } else if isNew {
            sendFrame(type: "subscribe", topic: topic)
        }
        return token
    }

    func unsubscribe(_ token: UUID) {
        guard let removed = subscriptions.removeValue(forKey: token) else { return }
        if !subscriptions.values.contains(where: { $0.topic == removed.topic }) {
            sendFrame(type: "unsubscribe", topic: removed.topic)
        }
    }

    /// The app left the foreground: a goodbye. Every topic is unsubscribed and
    /// the socket closed at once, so the server stops counting this phone as
    /// watching its chats and pushes what is said there. A background task
    /// holds the app awake while the frames go out.
    func pause() {
        guard !paused else { return }
        paused = true
        resync.dropped()
        let hold = BackgroundHold("live-events-goodbye")
        // The watch first: it is what the push depends on.
        if let watch = watching.topic { sendFrame(type: "unsubscribe", topic: watch) }
        for topic in Set(subscriptions.values.map(\.topic)) {
            sendFrame(type: "unsubscribe", topic: topic)
        }
        disconnect()
        Task {
            try? await Task.sleep(for: .seconds(1))
            hold.end()
        }
    }

    /// The app is back in front. Listeners refetch right away, before the
    /// socket is back: a socket that is slow, refused or dead must not keep
    /// the screen on what it showed before. The socket starts over even if it
    /// was never paused, since one that sat through a suspension can look open
    /// and deliver nothing. Listeners refetch again as the server confirms
    /// each topic, which covers what was sent in between.
    func resume() {
        paused = false
        guard !subscriptions.isEmpty else { return }
        resync.dropped()
        for subscription in Array(subscriptions.values) { subscription.handler(.reconnected) }
        connect()
    }

    func watch(_ chatId: String?) {
        let frames = watching.move(to: chatId)
        // Paused or not connected: the next connection holds the new watch.
        guard !paused, task != nil else { return }
        for frame in frames { sendFrame(type: frame.type, topic: frame.topic) }
    }

    private func connect() {
        guard !paused else { return }
        disconnect()
        generation += 1
        let current = generation
        let task = session.webSocketTask(with: client.socketRequest("/ws/events"))
        self.task = task
        task.resume()
        let topics = Set(subscriptions.values.map(\.topic))
        resync.connecting(topics: topics)
        for topic in watching.connecting(topics) {
            sendFrame(type: "subscribe", topic: topic)
        }
        receive(task, generation: current)
        pingWork = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard let self, self.generation == current else { return }
                self.task?.sendPing { _ in }
            }
        }
    }

    private func disconnect() {
        reconnectWork?.cancel()
        pingWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func receive(_ task: URLSessionWebSocketTask, generation current: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                switch result {
                case .success(let message):
                    self.attempt = 0
                    if case .string(let text) = message { self.handle(text) }
                    self.receive(task, generation: current)
                case .failure:
                    self.resync.dropped()
                    // A refused session would fail every retry the same way;
                    // the REST client's handler gets a fresh one.
                    if (task.response as? HTTPURLResponse)?.statusCode == 401 { self.client.reportUnauthorized() }
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        guard !paused, !subscriptions.isEmpty else { return }
        task = nil
        attempt += 1
        let delay = min(30.0, pow(2.0, Double(min(attempt, 5))) * 0.5)
        reconnectWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func sendFrame(type: String, topic: String) {
        guard let task else { return }
        let frame = #"{"type":"\#(type)","topic":"\#(topic)"}"#
        task.send(.string(frame)) { _ in }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONDecoder().decode(JSONValue.self, from: data),
              let topic = frame["topic"]?.string
        else { return }
        if frame["type"]?.string == "subscribed" {
            guard resync.confirmed(topic) else { return }
            for subscription in Array(subscriptions.values) where subscription.topic == topic {
                subscription.handler(.reconnected)
            }
            return
        }
        guard frame["type"]?.string == "event",
              let name = frame["event"]?.string,
              let event = Self.decode(name: name, data: frame["data"])
        else { return }
        for subscription in subscriptions.values where subscription.topic == topic {
            subscription.handler(event)
        }
    }

    static func decode(name: String, data: JSONValue?) -> LiveEvent? {
        guard let data else { return nil }
        switch name {
        case "session_running":
            guard let id = data["sessionId"]?.string, let running = data["running"]?.bool else { return nil }
            return .sessionRunning(sessionId: id, running: running)
        case "message_writing":
            guard let id = data["sessionId"]?.string, let turn = data["turnId"]?.string,
                  let mode = data["mode"]?.string.flatMap(WritingMode.init(rawValue:)) else { return nil }
            return .messageWriting(sessionId: id, turnId: turn, mode: mode, writing: data["writing"]?.bool ?? false)
        case "session_name":
            guard let id = data["sessionId"]?.string, let name = data["name"]?.string else { return nil }
            return .sessionName(sessionId: id, name: name)
        case "tasks_changed":
            guard let id = data["chatId"]?.string else { return nil }
            return .taskListChanged(chatId: id)
        case "message_insert":
            guard let message = data.decoded(ChatMessage.self) else { return nil }
            return .messageInsert(message)
        case "message_status_reaction":
            guard let id = data["sessionId"]?.string, let message = data["messageId"]?.string else { return nil }
            return .statusReaction(sessionId: id, messageId: message, reaction: data["statusReaction"]?.string)
        case "chat_card_settled":
            guard let id = data["sessionId"]?.string, let card = data["card"], card["kind"]?.string != nil, card["id"]?.string != nil else { return nil }
            return .cardSettled(sessionId: id, card: card)
        case "concierge_activity":
            guard let chatId = data["chatId"]?.string, let activity = data["activity"] else { return nil }
            return .conciergeActivity(chatId: chatId, activity: ConciergeActivity(json: activity), at: data["at"]?.number)
        case "agent_name_changed":
            return .agentName(AgentName.display(data["agentName"]?.string))
        case "message_chat_thread":
            guard let id = data["sessionId"]?.string, let message = data["messageId"]?.string else { return nil }
            return .messageThread(sessionId: id, messageId: message, chatThreadId: data["chatThreadId"]?.string, title: data["chatThreadTitle"]?.string)
        case "chat_thread_retired":
            guard let id = data["sessionId"]?.string, let root = data["chatThreadId"]?.string else { return nil }
            return .threadRetired(sessionId: id, chatThreadId: root)
        case "task_upsert":
            guard let event = data.decoded(TaskUpsertEvent.self) else { return nil }
            return .taskUpsert(event.task)
        default:
            return nil
        }
    }
}

extension JSONValue {
    /// Re-decodes this value as a typed model.
    func decoded<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

/// A short stretch of background time, ended once, by hand or by the system.
@MainActor
final class BackgroundHold {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

import Foundation

/// An event from the dashboard's live-events socket (`/ws/events`).
enum LiveEvent: Sendable {
    /// A chat started or stopped running a turn (`chat.status`).
    case sessionRunning(sessionId: String, running: Bool)
    /// A message was stored in a chat (`chat.session:<id>`).
    case messageInsert(ChatMessage)
    /// A chat was renamed.
    case sessionName(sessionId: String, name: String)
    /// The Concierge wrote a task row (`concierge.tasks`).
    case taskUpsert(ConciergeTask)
    /// The socket came back after a drop. Listeners refetch what they show,
    /// since events sent while it was down are gone.
    case reconnected
}

/// The source of live events. The real socket and the demo backend both implement it.
@MainActor
protocol LiveEventSource: AnyObject {
    /// Starts delivering `topic`'s events. Returns a token for `unsubscribe`.
    func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID
    func unsubscribe(_ token: UUID)
    func pause()
    func resume()
}

enum LiveTopic {
    static let chatStatus = "chat.status"
    static let conciergeTasks = "concierge.tasks"
    static func chat(_ sessionId: String) -> String { "chat.session:\(sessionId)" }
}

/// One WebSocket carries every topic. It reconnects with backoff, subscribes
/// again to what it held, and tells listeners it came back.
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
    private var connectedOnce = false
    private var reconnectWork: Task<Void, Never>?
    private var pingWork: Task<Void, Never>?
    private var generation = 0

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

    func pause() {
        paused = true
        disconnect()
    }

    func resume() {
        guard paused else { return }
        paused = false
        // Events sent while the app was away are gone, so treat this like a reconnect.
        attempt = max(attempt, 1)
        if !subscriptions.isEmpty { connect() }
    }

    private func connect() {
        guard !paused else { return }
        disconnect()
        generation += 1
        let current = generation
        let task = session.webSocketTask(with: client.socketRequest("/ws/events"))
        self.task = task
        task.resume()
        for topic in Set(subscriptions.values.map(\.topic)) {
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
                    self.handleOpen()
                    if case .string(let text) = message { self.handle(text) }
                    self.receive(task, generation: current)
                case .failure:
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handleOpen() {
        guard attempt > 0 || !connectedOnce else { return }
        let wasReconnect = connectedOnce
        attempt = 0
        connectedOnce = true
        if wasReconnect {
            for subscription in subscriptions.values { subscription.handler(.reconnected) }
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
              frame["type"]?.string == "event",
              let topic = frame["topic"]?.string,
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
        case "session_name":
            guard let id = data["sessionId"]?.string, let name = data["name"]?.string else { return nil }
            return .sessionName(sessionId: id, name: name)
        case "message_insert":
            guard let message = data.decoded(ChatMessage.self) else { return nil }
            return .messageInsert(message)
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

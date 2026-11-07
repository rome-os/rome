import Foundation
import UIKit

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
    /// Events may have been missed: the app came back to the foreground, or
    /// the socket came back after a drop. Listeners refetch what they show.
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
        for topic in topics {
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

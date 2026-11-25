import Foundation
import Network

/// One voice conversation in a chat: microphone audio goes to the instance's
/// `/ws/voice-conversation` socket, and Rome sends back its state and the
/// reply's audio. Rome listens, sends each turn to the chat and speaks; the
/// phone only records and plays, as the dashboard does. Built the way
/// `VoiceDictation` is.
@MainActor
final class VoiceConversation {
    struct Handlers {
        /// Rome's state changed: listening, thinking or speaking.
        var onState: (VoiceConversationState) -> Void
        /// Called once, last. nil when the guardian ended it.
        var onEnded: (VoiceConversationStopReason?) -> Void
    }

    private let request: URLRequest
    private let chatId: String
    private let audio: VoiceConversationAudio
    private let handlers: Handlers
    private let session: URLSession
    private let sender = ConversationSender()
    private var task: URLSessionWebSocketTask?
    /// The reply's rate, once Rome names it in `ready`.
    private var replyRate: Int?
    private var done = false
    private var quiet: Task<Void, Never>?
    private var path: NWPathMonitor?
    private var reconnect = VoiceReconnect()
    private var retry: Task<Void, Never>?
    private var online = true

    init(request: URLRequest, chatId: String, audio: VoiceConversationAudio, session: URLSession = .shared, handlers: Handlers) {
        self.request = request
        self.chatId = chatId
        self.audio = audio
        self.session = session
        self.handlers = handlers
    }

    func start() {
        Task {
            guard await audio.requestAccess() else { return finish(.microphoneBlocked) }
            // Ended while the system asked.
            guard !done else { return }
            connect()
            do {
                let sender = sender
                try audio.start(onChunk: { chunk in sender.send(audio: chunk) }, onLost: { [weak self] in
                    self?.finish(.microphoneFailed)
                })
            } catch {
                return finish(.microphoneFailed)
            }
            watchNetwork()
        }
    }

    /// Opens a socket to Rome and starts the conversation on it. The audio
    /// sent before `start` goes nowhere.
    private func connect() {
        let socket = session.webSocketTask(with: request)
        task = socket
        replyRate = nil
        sender.attach(socket)
        socket.resume()
        sender.send(text: VoiceConversationWire.start(chatId: chatId, sampleRate: VoiceConversationWire.sampleRate))
        heardFromRome(within: VoiceConversationWire.openLimit)
        receive(socket)
    }

    /// The connection to Rome dropped: a network change, a lost signal, or
    /// Rome falling quiet. The microphone goes on, and the phone calls Rome
    /// again while the network allows, for up to `reconnectWindow`. What
    /// Rome was saying is lost, and the reply stays in the chat.
    private func lost() {
        guard !done else { return }
        guard reconnect.lost(at: .now) else { return finish(.connectionLost) }
        quiet?.cancel()
        sender.close(sending: nil)
        task = nil
        audio.clear()
        handlers.onState(.thinking)
        retry?.cancel()
        retry = Task { [weak self] in
            try? await Task.sleep(for: VoiceConversationWire.reconnectEvery)
            guard !Task.isCancelled else { return }
            self?.callAgain()
        }
    }

    private func callAgain() {
        guard !done, task == nil else { return }
        // Offline: the network coming back calls again, or the window runs out.
        guard online else { return lost() }
        connect()
    }

    /// The guardian's call or Siri ended and the system lets the app go on.
    func resumeAudio() {
        guard !done else { return }
        do {
            try audio.resume()
        } catch {
            finish(.interrupted)
        }
    }

    /// While muted, no microphone audio leaves the phone. The microphone
    /// itself keeps running, so unmuting is instant.
    func setMuted(_ muted: Bool) {
        sender.setMuted(muted)
    }

    /// Ends the conversation: the guardian's End with nil, or the phone's own
    /// `reason`, such as the app going to the background.
    func end(_ reason: VoiceConversationStopReason? = nil) {
        finish(reason, tellingRome: true)
    }

    private func finish(_ reason: VoiceConversationStopReason?, tellingRome: Bool = false) {
        guard !done else { return }
        done = true
        audio.close()
        quiet?.cancel()
        retry?.cancel()
        path?.cancel()
        path = nil
        // A stop, if Rome should hear one, goes out before the socket closes.
        sender.close(sending: tellingRome && task != nil ? VoiceConversationWire.stop : nil)
        task = nil
        handlers.onEnded(reason)
    }

    /// A connection that dies without the phone knowing ends the conversation
    /// once Rome falls quiet: it says it is there every second.
    private func heardFromRome(within limit: Duration = VoiceConversationWire.quietLimit) {
        quiet?.cancel()
        quiet = Task { [weak self] in
            try? await Task.sleep(for: limit)
            guard !Task.isCancelled else { return }
            self?.lost()
        }
    }

    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(online: online) }
        }
        monitor.start(queue: .main)
        path = monitor
    }

    private func networkChanged(online: Bool) {
        guard !done else { return }
        self.online = online
        if !online {
            if task != nil { lost() }
        } else if task == nil {
            retry?.cancel()
            callAgain()
        }
    }

    private enum Received: Sendable {
        case message(VoiceConversationServerMessage?)
        case audio(Data)
        case failed
    }

    private func receive(_ socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            // Read here, off the main actor: only the typed message goes over.
            let received: Received = switch result {
            case .success(.string(let text)): .message(VoiceConversationServerMessage(json: Data(text.utf8)))
            case .success(.data(let data)): .audio(data)
            case .success: .message(nil)
            case .failure: .failed
            }
            Task { @MainActor in
                guard let self, !self.done, self.task === socket else { return }
                switch received {
                case .failed: return self.lost()
                case .audio(let chunk):
                    self.heardFromRome()
                    if let rate = self.replyRate { self.audio.play(chunk, sampleRate: rate) }
                case .message(let message):
                    self.heardFromRome()
                    if let message { self.handle(message) }
                }
                if !self.done { self.receive(socket) }
            }
        }
    }

    private func handle(_ message: VoiceConversationServerMessage) {
        switch message {
        case .ready(let rate):
            replyRate = rate
            reconnect.recovered()
        case .state(let state): handlers.onState(state)
        case .clear: audio.clear()
        case .alive: break
        case .ended: finish(nil)
        case .error(let reason): finish(reason)
        }
    }
}

/// Sends on the socket in order, from the audio thread and from main alike.
private final class ConversationSender: @unchecked Sendable {
    private let queue = DispatchQueue(label: "cc.romeos.voice-conversation.send")
    private var task: URLSessionWebSocketTask?
    private var muted = false

    func attach(_ task: URLSessionWebSocketTask) {
        queue.async { self.task = task }
    }

    func send(text: String) {
        queue.async { self.task?.send(.string(text)) { _ in } }
    }

    func send(audio: Data) {
        queue.async {
            guard !self.muted else { return }
            self.task?.send(.data(audio)) { _ in }
        }
    }

    func setMuted(_ muted: Bool) {
        queue.async { self.muted = muted }
    }

    /// Sends `last`, if any, then closes the socket, after everything sent before.
    func close(sending last: String?) {
        queue.async {
            guard let task = self.task else { return }
            self.task = nil
            guard let last else { return task.cancel(with: .normalClosure, reason: nil) }
            task.send(.string(last)) { _ in task.cancel(with: .normalClosure, reason: nil) }
        }
    }
}

/// How long a dropped conversation keeps calling Rome again: from the first
/// drop until Rome is back, at most `VoiceConversationWire.reconnectWindow`.
struct VoiceReconnect {
    private var since: ContinuousClock.Instant?

    /// The connection dropped at `now`. True while the phone may still call again.
    mutating func lost(at now: ContinuousClock.Instant) -> Bool {
        let first = since ?? now
        since = first
        return now - first < VoiceConversationWire.reconnectWindow
    }

    /// Rome answered again: a later drop gets the whole window.
    mutating func recovered() {
        since = nil
    }
}

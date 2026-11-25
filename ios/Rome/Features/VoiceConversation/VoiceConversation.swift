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
    private var retry: Task<Void, Never>?
    /// Ends the conversation once the reconnect window is over, however the calls go.
    private var deadline: Task<Void, Never>?
    private var online = true
    /// Rome said `ready` on some socket: only then is a drop called again.
    private var established = false
    /// Ends the conversation when a call or Siri never says it ended.
    private var interruption: Task<Void, Never>?

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
        // One step: microphone audio queued meanwhile goes after `start`, never before it.
        sender.attach(socket, first: VoiceConversationWire.start(chatId: chatId, sampleRate: VoiceConversationWire.sampleRate))
        socket.resume()
        heardFromRome(within: VoiceConversationWire.openLimit)
        receive(socket)
    }

    /// The connection to Rome dropped: a network change, a lost signal, or
    /// Rome falling quiet. Once the conversation has started, the microphone
    /// goes on, and the phone calls Rome again while the network allows, for
    /// up to `reconnectWindow` from the first drop. What Rome was saying is
    /// lost, and the reply stays in the chat. A conversation that never
    /// started ends at once, so a refusal shows.
    private func lost() {
        guard !done else { return }
        guard established else { return finish(.connectionLost) }
        if deadline == nil {
            deadline = Task { [weak self] in
                try? await Task.sleep(for: VoiceConversationWire.reconnectWindow)
                guard !Task.isCancelled else { return }
                self?.finish(.connectionLost)
            }
        }
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

    /// A call or Siri took the audio. Its end resumes the conversation, and
    /// so does the app coming to the front, since iOS may never say it ended.
    /// After `interruptionLimit` with neither, the conversation ends.
    func interrupted() {
        guard !done else { return }
        interruption?.cancel()
        interruption = Task { [weak self] in
            try? await Task.sleep(for: VoiceConversationWire.interruptionLimit)
            guard !Task.isCancelled else { return }
            self?.finish(.interrupted)
        }
    }

    /// The app came to the front: an interruption that never said it ended
    /// may be over. If the audio cannot start yet, as during a call the
    /// guardian switched away from, it waits on for the end or the limit.
    func cameToFront() {
        guard !done, interruption != nil else { return }
        guard (try? audio.resume()) != nil else { return }
        interruption?.cancel()
        interruption = nil
    }

    /// The guardian's call or Siri ended and the system lets the app go on.
    func resumeAudio() {
        guard !done else { return }
        interruption?.cancel()
        interruption = nil
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
    /// `reason`, such as a call that kept the microphone.
    func end(_ reason: VoiceConversationStopReason? = nil) {
        finish(reason, tellingRome: true)
    }

    private func finish(_ reason: VoiceConversationStopReason?, tellingRome: Bool = false) {
        guard !done else { return }
        done = true
        audio.close()
        quiet?.cancel()
        retry?.cancel()
        deadline?.cancel()
        interruption?.cancel()
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
            established = true
            sender.ready()
            deadline?.cancel()
            deadline = nil
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
    /// Rome is ready on `task`. Until then the microphone's audio is dropped,
    /// not queued: a slow handshake would let it pile up past what Rome takes.
    private var open = false

    /// Sends on `task` from now, `first` before anything else.
    func attach(_ task: URLSessionWebSocketTask, first: String) {
        queue.async {
            self.task = task
            self.open = false
            task.send(.string(first)) { _ in }
        }
    }

    /// Rome said `ready`: the microphone's audio goes out from now.
    func ready() {
        queue.async { self.open = true }
    }

    func send(audio: Data) {
        queue.async {
            guard !self.muted, self.open else { return }
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

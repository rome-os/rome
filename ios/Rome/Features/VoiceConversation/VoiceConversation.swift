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
            let socket = session.webSocketTask(with: request)
            task = socket
            sender.attach(socket)
            socket.resume()
            sender.send(text: VoiceConversationWire.start(chatId: chatId, sampleRate: VoiceConversationWire.sampleRate))
            do {
                let sender = sender
                try audio.start(onChunk: { chunk in sender.send(audio: chunk) }, onLost: { [weak self] in
                    self?.finish(.microphoneFailed)
                })
            } catch {
                return finish(.microphoneFailed)
            }
            heardFromRome(within: VoiceConversationWire.openLimit)
            receive(socket)
            watchNetwork()
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
            self?.finish(.connectionLost)
        }
    }

    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status != .satisfied else { return }
            Task { @MainActor in self?.finish(.connectionLost) }
        }
        monitor.start(queue: .main)
        path = monitor
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
                case .failed: return self.finish(.connectionLost)
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
        case .ready(let rate): replyRate = rate
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

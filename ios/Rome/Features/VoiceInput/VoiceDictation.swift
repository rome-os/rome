import Foundation
import Network

/// One dictation: audio from `source` goes to the instance's `/ws/voice-input`
/// socket, and the text comes back while the guardian speaks.
@MainActor
final class VoiceDictation {
    struct Handlers {
        /// Everything heard so far, settled and pending, each time it changes.
        var onText: (String) -> Void
        /// Called once, last: everything heard, and why listening stopped,
        /// nil when the guardian stopped it and the rest of the text came.
        var onDone: (String, VoiceInputStop?) -> Void
    }

    private let request: URLRequest
    private let source: VoiceAudioSource
    private let handlers: Handlers
    private let session: URLSession
    private let sender = AudioSender()
    private var task: URLSessionWebSocketTask?
    private var settled = ""
    private var pending = ""
    private var done = false
    private var stopping = false
    private var quiet: Task<Void, Never>?
    private var stopTimer: Task<Void, Never>?
    private var path: NWPathMonitor?

    init(request: URLRequest, source: VoiceAudioSource, session: URLSession = .shared, handlers: Handlers) {
        self.request = request
        self.source = source
        self.session = session
        self.handlers = handlers
    }

    var heard: String { settled + pending }

    func start() {
        Task {
            guard await source.requestAccess() else { return finish(VoiceInputStop(reason: .microphoneBlocked)) }
            guard !done else { return }
            // Stopped while the system asked: nothing was heard.
            if stopping { return finish(nil) }
            let socket = session.webSocketTask(with: request)
            task = socket
            sender.attach(socket)
            socket.resume()
            sender.send(text: VoiceInputWire.start(sampleRate: VoiceInputWire.sampleRate))
            do {
                let sender = sender
                try source.start { chunk in sender.send(audio: chunk) }
            } catch {
                return finish(VoiceInputStop(reason: .microphoneFailed))
            }
            // The first word from the instance also waits for the handshake.
            heardFromRome(within: VoiceInputWire.quietLimit + .seconds(5))
            receive(socket)
            watchNetwork()
        }
    }

    /// Stops listening and waits for the rest of the text.
    func stop() {
        guard !done, !stopping else { return }
        stopping = true
        // Nothing went out yet: nothing more can come back.
        guard task != nil else { return }
        source.finish()
        sender.send(text: VoiceInputWire.stop)
        sender.endAudio()
        stopTimer = Task { [weak self] in
            try? await Task.sleep(for: VoiceInputWire.stopTimeout)
            guard !Task.isCancelled else { return }
            self?.finish(VoiceInputStop(reason: .connectionLost))
        }
    }

    /// Ends listening at once for `reason`, keeping what was heard.
    func end(_ reason: VoiceInputStopReason) {
        finish(VoiceInputStop(reason: reason))
    }

    /// Drops the dictation. No handler is called after it.
    func cancel() {
        guard !done else { return }
        done = true
        teardown()
    }

    private func finish(_ stop: VoiceInputStop?) {
        guard !done else { return }
        done = true
        teardown()
        handlers.onDone(heard, stop)
    }

    private func teardown() {
        source.close()
        sender.endAudio()
        quiet?.cancel()
        stopTimer?.cancel()
        path?.cancel()
        path = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    /// A connection that dies without the phone knowing ends the dictation
    /// once the instance falls quiet: it says it is there every second.
    private func heardFromRome(within limit: Duration = VoiceInputWire.quietLimit) {
        quiet?.cancel()
        quiet = Task { [weak self] in
            try? await Task.sleep(for: limit)
            guard !Task.isCancelled else { return }
            self?.finish(VoiceInputStop(reason: .connectionLost))
        }
    }

    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status != .satisfied else { return }
            Task { @MainActor in self?.finish(VoiceInputStop(reason: .connectionLost)) }
        }
        monitor.start(queue: .main)
        path = monitor
    }

    private func receive(_ socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            // Read here, off the main actor: only the typed message goes over.
            let message: VoiceInputServerMessage? = if case .success(.string(let text)) = result { VoiceInputServerMessage(json: Data(text.utf8)) } else { nil }
            let failed = if case .failure = result { true } else { false }
            Task { @MainActor in
                guard let self, !self.done, self.task === socket else { return }
                if failed { return self.finish(VoiceInputStop(reason: .connectionLost)) }
                self.heardFromRome()
                if let message { self.handle(message) }
                if !self.done { self.receive(socket) }
            }
        }
    }

    private func handle(_ message: VoiceInputServerMessage) {
        switch message {
        case .text(let newlySettled, let tail):
            settled += newlySettled
            pending = tail
            handlers.onText(heard)
        case .alive:
            break
        case .ended:
            finish(nil)
        case .error(let stop):
            finish(stop)
        }
    }
}

/// Sends on the socket in order, from the audio thread and from main alike.
private final class AudioSender: @unchecked Sendable {
    private let queue = DispatchQueue(label: "cc.romeos.voice-input.send")
    private var task: URLSessionWebSocketTask?
    private var audioOpen = true

    func attach(_ task: URLSessionWebSocketTask) {
        queue.async { self.task = task }
    }

    func send(text: String) {
        queue.async { self.task?.send(.string(text)) { _ in } }
    }

    func send(audio: Data) {
        queue.async {
            guard self.audioOpen else { return }
            self.task?.send(.data(audio)) { _ in }
        }
    }

    /// Audio after a stop is not part of the dictation.
    func endAudio() {
        queue.async { self.audioOpen = false }
    }
}

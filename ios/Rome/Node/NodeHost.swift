import Foundation
import Observation
import UIKit

// This iPhone as a rome-node device, ported from connectHost() and
// connectGateway() in packages/rome-node-core. The app's Rome Cloud sign-in
// (`romemob_` token and its device session) is the device's identity, as the
// Mac app's is: signed in means connected, unless the switch in Settings is
// off. The connection lives while the app is in front.

/// The app's Rome Cloud sign-in, as the host reads it.
@MainActor
protocol NodeCredentials: AnyObject {
    var origin: URL { get }
    var deviceCredential: CloudCredential? { get }
    /// Goes up when the account ends.
    var accountGeneration: Int { get }
    /// Rome Cloud says this device session is not valid: the sign-in is over.
    func rejectCredential(_ credential: CloudCredential)
}

enum NodeConfigError: Error {
    /// 401 `invalid_device_session`.
    case invalidDeviceSession
    case unavailable
}

/// `GET {cloud}/v1/gateway/config` with the device token: where the Gateway is.
enum NodeGatewayConfig {
    static func fetch(cloud: URL, token: String, http: URLSession) async throws -> URL {
        var request = URLRequest(url: cloud.appending(path: "v1/gateway/config"))
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let status: Int
        do {
            let (body, response) = try await http.data(for: request)
            data = body
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw NodeConfigError.unavailable
        }
        let body = try? JSONDecoder().decode(JSONValue.self, from: data)
        guard (200..<300).contains(status) else {
            throw status == 401 && body?["error"]?.string == "invalid_device_session" ? NodeConfigError.invalidDeviceSession : NodeConfigError.unavailable
        }
        guard let text = body?["gatewayUrl"]?.string, let url = GatewayURL.parse(text) else { throw NodeConfigError.unavailable }
        return url
    }
}

/// An open WebSocket to the Gateway, text only.
protocol NodeSocket: Sendable {
    /// The next text frame; nil for a binary one, which this phone ignores.
    /// Throws `NodeSocketClosed` when the socket ends.
    func receive() async throws -> String?
    func send(_ text: String) async throws
    /// A WebSocket ping, answered when the pong comes. Throws when the socket
    /// is gone, and ends early (throwing) when the calling task is cancelled.
    func ping() async throws
    func close()
}

struct NodeSocketClosed: Error {
    /// The close code the Gateway sent, when it sent one.
    let code: Int?
}

/// Opens a socket to a URL with an `Authorization` header and waits until it is open.
typealias NodeSocketFactory = @Sendable (URL, String) async throws -> NodeSocket

@MainActor
@Observable
final class NodeHost {
    enum Status: Equatable {
        case off
        case connecting
        case online
        /// Stopped for good until the app comes to the front again, or the switch is turned off and on.
        case stopped(NodeStop)
    }

    private enum Defaults {
        static let enabled = "nodeEnabled"
        static let health = "nodeHealthEnabled"
    }

    private(set) var status = Status.off
    /// The guardian's switch in Settings: on unless turned off.
    private(set) var isEnabled: Bool
    /// The guardian's "Apple Health" switch: off until turned on. Health data
    /// goes to the Rome and its AI model, so it is the guardian's choice. Off,
    /// the health actions are refused with `health_off`.
    private(set) var isHealthEnabled: Bool
    /// Goes up when a request has been answered, so Settings reloads its list.
    private(set) var requestSerial = 0
    private(set) var recent: [NodeAuditEntry] = []

    @ObservationIgnored private let credentials: NodeCredentials
    @ObservationIgnored private let reader: HealthReading
    @ObservationIgnored private let pingInterval: TimeInterval
    @ObservationIgnored private let pingTimeout: TimeInterval
    @ObservationIgnored private let healthSwitch: HealthSwitch
    @ObservationIgnored private let executor: NodeExecutor
    @ObservationIgnored private let audit: NodeAuditing
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let http: URLSession
    @ObservationIgnored private let connect: NodeSocketFactory
    @ObservationIgnored private let pause: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private let random: @Sendable () -> Double
    @ObservationIgnored private let now: @Sendable () -> Date
    /// Rome Cloud ended the device session: the app signs out.
    @ObservationIgnored var onCredentialRejected: (() -> Void)?

    @ObservationIgnored private var active = false
    /// The account ended; nothing connects until the next sign-in.
    @ObservationIgnored private var accountOver = false
    /// The app is in a signed-in phase: not on the sign-in screen, whatever
    /// credential is still kept. Set by `AppModel` whenever its phase changes.
    @ObservationIgnored private(set) var isSignedIn = true
    @ObservationIgnored private var running: (device: String, account: Int, task: Task<Void, Never>)?
    @ObservationIgnored private var inFlight = 0
    @ObservationIgnored private var drain: Task<Void, Never>?

    init(
        credentials: NodeCredentials,
        audit: NodeAuditing = NodeAuditLog(),
        health: HealthActions = HealthActions(reader: LiveHealth()),
        defaults: UserDefaults = .standard,
        http: URLSession? = nil,
        connect: @escaping NodeSocketFactory = { try await WebSocketTransport.open($0, authorization: $1) },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        now: @escaping @Sendable () -> Date = { Date() },
        name: @escaping @Sendable () async -> String = { await MainActor.run { UIDevice.current.name } },
        pingInterval: TimeInterval = 25,
        pingTimeout: TimeInterval = 10
    ) {
        self.pingInterval = pingInterval
        self.pingTimeout = pingTimeout
        self.credentials = credentials
        reader = health.reader
        let healthOn = defaults.object(forKey: Defaults.health) as? Bool ?? false
        healthSwitch = HealthSwitch(healthOn)
        isHealthEnabled = healthOn
        var health = health
        health.enabled = healthSwitch
        self.audit = audit
        self.defaults = defaults
        self.connect = connect
        self.pause = pause
        self.random = random
        self.now = now
        executor = NodeExecutor(name: name, audit: audit, health: health, now: now)
        isEnabled = defaults.object(forKey: Defaults.enabled) as? Bool ?? true
        if let http {
            self.http = http
        } else {
            self.http = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        }
    }

    // MARK: Control

    /// The guardian's switch.
    func setEnabled(_ on: Bool) {
        isEnabled = on
        defaults.set(on, forKey: Defaults.enabled)
        if on, case .stopped = status { status = .off }
        sync()
    }

    /// The "Apple Health" switch. Turning it on while iOS has never been asked
    /// shows the system sheet at once; once asked, iOS shows nothing more, and
    /// neither does the app. The task is the prompt, for tests.
    @discardableResult
    func setHealthEnabled(_ on: Bool) -> Task<Void, Never>? {
        isHealthEnabled = on
        defaults.set(on, forKey: Defaults.health)
        healthSwitch.set(on)
        guard on else { return nil }
        return Task { [reader] in
            if await reader.shouldRequestAccess() { try? await reader.requestAccess() }
        }
    }

    /// The app is in front (true) or in the background (false). Inactive, as
    /// under the Health sheet, is still in front.
    func setActive(_ value: Bool) {
        active = value
        if value {
            drain?.cancel()
            if case .stopped = status { status = .off }
            sync()
        } else {
            drainThenStop()
        }
    }

    /// A sign-in finished: this account's device connects.
    func accountStarted() {
        accountOver = false
        sync()
    }

    /// The app moved to or from the sign-in screen. A phone that shows signed out
    /// is not a device, whatever Cloud credential it still holds.
    func setSignedIn(_ value: Bool) {
        guard value != isSignedIn else { return }
        isSignedIn = value
        sync()
    }

    /// Signed out, or the sign-in was rejected: disconnect, and stay off.
    func accountEnded() {
        accountOver = true
        stop()
    }

    /// Starts, restarts or stops the connection to match the switch, the
    /// sign-in (a credential, and the app's phase) and the app being in front. Safe to call at any time.
    func sync() {
        guard isEnabled, !accountOver, isSignedIn, let credential = credentials.deviceCredential else {
            stop()
            return
        }
        guard active else { return }
        let account = credentials.accountGeneration
        if let running, running.device == credential.deviceSessionId, running.account == account { return }
        stop()
        if case .stopped = status { return }
        start(credential, account: account)
    }

    private func start(_ credential: CloudCredential, account: Int) {
        status = .connecting
        let task = Task { [weak self] in
            guard let self else { return }
            await self.run(credential, account: account)
        }
        running = (credential.deviceSessionId, account, task)
    }

    /// Closes the connection now. Requests under way are cut off.
    private func stop() {
        drain?.cancel()
        running?.task.cancel()
        running = nil
        if case .stopped = status { return }
        status = .off
    }

    /// The app left the front: requests under way get their replies out, for
    /// up to ten seconds, then the connection closes. iOS suspends the app
    /// soon after, and a suspended socket is dead anyway.
    private func drainThenStop() {
        guard running != nil else { return }
        let hold = BackgroundHold("node-goodbye")
        drain?.cancel()
        drain = Task { [weak self] in
            defer { hold.end() }
            for _ in 0..<100 {
                guard let self, self.inFlight > 0, !Task.isCancelled else { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard let self, !Task.isCancelled, !self.active else { return }
            self.stop()
        }
    }

    func reloadRecent() async {
        recent = await audit.recent(limit: 50)
    }

    // MARK: Connection

    /// Connects, serves, and connects again after a drop, until cancelled or
    /// told to stop.
    private func run(_ credential: CloudCredential, account: Int) async {
        var attempt = 0
        while !Task.isCancelled {
            status = .connecting
            var openedAt: Date?
            let session = NodeSession()
            do {
                // Asked on every connect, as rome-node does: the Gateway may have moved,
                // and Cloud is where a revoked device session shows first.
                let url = try await NodeGatewayConfig.fetch(cloud: credentials.origin, token: credential.accessToken, http: http)
                let socket = try await connect(url, "Bearer \(credential.accessToken)")
                guard !Task.isCancelled else {
                    socket.close()
                    return
                }
                status = .online
                openedAt = now()
                try await serve(socket, session: session)
            } catch is CancellationError {
                session.end()
                return
            } catch NodeConfigError.invalidDeviceSession {
                session.end()
                guard !Task.isCancelled else { return }
                running = nil
                status = .off
                credentials.rejectCredential(credential)
                onCredentialRejected?()
                return
            } catch let closed as NodeSocketClosed {
                if case .stop(let reason) = NodeClose.decision(for: closed.code) {
                    session.end()
                    guard !Task.isCancelled else { return }
                    running = nil
                    status = .stopped(reason)
                    return
                }
            } catch {
                // Cloud or the network failed: try again below.
            }
            session.end()
            guard !Task.isCancelled else { return }
            // A connection that held for 30 seconds starts the backoff over.
            if let openedAt, now().timeIntervalSince(openedAt) >= 30 { attempt = 0 }
            status = .connecting
            do { try await pause(NodeBackoff.delay(attempt: attempt, random: random())) } catch { return }
            attempt += 1
        }
    }

    /// Reads frames until the socket ends, for any reason. The socket is
    /// closed on every way out, so a reconnect never leaves a transport and its
    /// session behind. A ping goes out every `pingInterval`: one that fails or
    /// gets no pong in `pingTimeout` closes the socket, so the read ends and
    /// the backoff takes over, as when a wifi drop leaves a socket half open.
    private func serve(_ socket: NodeSocket, session: NodeSession) async throws {
        let heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.pingInterval ?? 25))
                guard !Task.isCancelled, let self else { return }
                do { try await self.ping(socket) } catch {
                    if !Task.isCancelled { socket.close() }
                    return
                }
            }
        }
        defer {
            heartbeat.cancel()
            socket.close()
        }
        try await withTaskCancellationHandler {
            while true {
                guard let text = try await socket.receive() else { continue }
                answer(text, on: socket, session: session)
            }
        } onCancel: {
            socket.close()
        }
    }

    /// One ping, given `pingTimeout` for its pong.
    private func ping(_ socket: NodeSocket) async throws {
        let timeout = pingTimeout
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await socket.ping() }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                throw NodeSocketClosed(code: nil)
            }
            // The first to finish decides: a pong is fine, the timer is a loss.
            defer { group.cancelAll() }
            try await group.next()
            group.cancelAll()
            _ = try? await group.next()
        }
    }

    private func answer(_ text: String, on socket: NodeSocket, session: NodeSession) {
        inFlight += 1
        Task { [executor] in
            let reply = await executor.respond(to: text, session: session)
            // A connection that ended meanwhile never gets the reply.
            if let reply, session.isLive { try? await socket.send(reply) }
            self.inFlight -= 1
            if reply != nil { self.requestSerial += 1 }
        }
    }
}

// MARK: - WebSocket

/// A continuation URLSession's callback may answer more than once: the first
/// answer resumes it and the rest are ignored. A second `resume` of a
/// checked continuation traps.
final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?

    init(_ continuation: CheckedContinuation<Void, Error>) { self.continuation = continuation }

    /// Resumes with the error, or normally when there is none. A no-op after the first call.
    func resume(_ error: Error?) {
        let held = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            defer { continuation = nil }
            return continuation
        }
        if let error { held?.resume(throwing: error) } else { held?.resume() }
    }
}

/// A `URLSessionWebSocketTask` to the Gateway. The token goes in the
/// `Authorization` header, never in the URL.
final class WebSocketTransport: NSObject, NodeSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var opening: CheckedContinuation<Void, Error>?
    private var closeCode: Int?

    static func open(_ url: URL, authorization: String) async throws -> WebSocketTransport {
        let transport = WebSocketTransport()
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: transport, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        transport.lock.withLock {
            transport.session = session
            transport.task = task
        }
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    transport.lock.withLock { transport.opening = continuation }
                    task.resume()
                }
            } onCancel: {
                transport.close()
            }
        } catch {
            transport.close()
            throw error
        }
        return transport
    }

    private func finishOpening(_ error: Error?) {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            defer { opening = nil }
            return opening
        }
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        finishOpening(nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        lock.withLock { self.closeCode = closeCode.rawValue }
        finishOpening(NodeSocketClosed(code: closeCode.rawValue))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finishOpening(error ?? NodeSocketClosed(code: nil))
    }

    func receive() async throws -> String? {
        guard let task = lock.withLock({ self.task }) else { throw NodeSocketClosed(code: nil) }
        do {
            switch try await task.receive() {
            case .string(let text): return text
            case .data: return nil
            @unknown default: return nil
            }
        } catch {
            // The close code can land just after the receive fails.
            for _ in 0..<5 {
                if let code = lock.withLock({ closeCode }) { throw NodeSocketClosed(code: code) }
                if task.closeCode != .invalid { throw NodeSocketClosed(code: task.closeCode.rawValue) }
                try? await Task.sleep(for: .milliseconds(50))
            }
            throw NodeSocketClosed(code: nil)
        }
    }

    func send(_ text: String) async throws {
        guard let task = lock.withLock({ self.task }) else { throw NodeSocketClosed(code: nil) }
        try await task.send(.string(text))
    }

    func ping() async throws {
        guard let task = lock.withLock({ self.task }) else { throw NodeSocketClosed(code: nil) }
        // A cancelled ping closes the socket, which answers the pong handler with an error.
        try await withTaskCancellationHandler {
            try await Self.awaitPong { pong in task.sendPing(pongReceiveHandler: pong) }
        } onCancel: {
            close()
        }
    }

    /// Waits for the one answer to a ping. `start` hands the pong handler to
    /// URLSession, which may call it twice when the task is cancelled with the
    /// ping still waiting (POSIX 53). Only the first call resumes.
    static func awaitPong(_ start: @Sendable (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = ResumeOnce(continuation)
            start { error in once.resume(error) }
        }
    }

    /// The upgrade request goes only where the Gateway config said, with its
    /// credential: a redirect is refused.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func close() {
        let (task, session) = lock.withLock { (self.task, self.session) }
        task?.cancel(with: .normalClosure, reason: nil)
        session?.finishTasksAndInvalidate()
    }
}

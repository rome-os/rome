import Darwin
import Foundation

final class Admission: @unchecked Sendable {
    private let lock = NSLock()
    private var active = false
    private var hasBinding = false
    private var reason: String?
    private var exiting = false
    private var onStop: (@Sendable () -> Void)?

    func begin() throws {
        try lock.withLock {
            if let reason { throw Failure(reason) }
            guard !active else { throw Failure("busy") }
            active = true
        }
    }

    func check() throws {
        try lock.withLock {
            if let reason { throw Failure(reason) }
        }
    }

    func finish(hasBinding: Bool) {
        lock.withLock {
            self.hasBinding = hasBinding
            active = false
        }
    }

    var needsAccessCheck: Bool { lock.withLock { reason == nil && (active || hasBinding) } }

    func updateBindings(_ hasBinding: Bool) {
        lock.withLock { self.hasBinding = hasBinding }
    }

    func whenStopped(_ handler: @escaping @Sendable () -> Void) {
        let stopped = lock.withLock {
            onStop = handler
            return reason != nil
        }
        if stopped { handler() }
    }

    func stop(_ reason: String = "session_stopped") -> [String: Any] {
        seal(reason, exiting: false)
    }

    func terminate(_ reason: String = "session_stopped") {
        _ = seal(reason, exiting: true)
    }

    private func seal(_ reason: String, exiting: Bool) -> [String: Any] {
        let (status, handler) = lock.withLock {
            let handler = self.reason == nil ? onStop : nil
            self.reason = self.reason ?? reason
            self.exiting = self.exiting || exiting
            return (statusLocked(), handler)
        }
        handler?()
        return status
    }

    var terminating: Bool { lock.withLock { exiting } }

    func status() -> [String: Any] {
        lock.withLock { statusLocked() }
    }

    private func statusLocked() -> [String: Any] {
        var status: [String: Any] = ["stop": reason == nil ? "running" : (active || hasBinding) ? "cancel_requested" : "stop_confirmed"]
        status["reason"] = reason
        return status
    }
}

func socketAddress<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) throws -> T {
    var addr = sockaddr_un()
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { throw Failure("socket_path_limit") }
    addr.sun_family = sa_family_t(AF_UNIX)
    let length = MemoryLayout.offset(of: \sockaddr_un.sun_path)! + bytes.count
    addr.sun_len = UInt8(length)
    withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(length)) }
    }
}

func readBytes(_ fd: Int32, count: Int) throws -> Data {
    var buffer = Data(count: count)
    try buffer.withUnsafeMutableBytes { bytes in
        var offset = 0
        while offset < count {
            let n = read(fd, bytes.baseAddress!.advanced(by: offset), count - offset)
            if n < 0, errno == EINTR { continue }
            guard n > 0 else { throw Failure("connection_closed") }
            offset += n
        }
    }
    return buffer
}

func sendBytes(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { bytes in
        var offset = 0
        let deadline = DispatchTime.now() + .seconds(2)
        while offset < bytes.count {
            guard DispatchTime.now() < deadline else { throw Failure("connection_closed") }
            let count = send(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset, MSG_DONTWAIT)
            if count < 0, errno == EINTR { continue }
            if count < 0, errno == EAGAIN {
                var event = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = poll(&event, 1, 50)
                continue
            }
            guard count > 0 else { throw Failure("connection_closed") }
            offset += count
        }
    }
}

final class Listener: Sendable {
    let state: StateDirectory
    let socket: FileIdentity
    let fd: Int32

    init(state: StateDirectory) throws {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure("socket_unavailable") }
        do {
            let mask = umask(0o177)
            defer { umask(mask) }
            guard state.intact, try socketAddress(state.path + "/helper.sock", { bind(fd, $0, $1) }) == 0 else {
                throw Failure("socket_unavailable")
            }
            guard let socket = state.socketIdentity() else { throw Failure("unsafe_state_directory") }
            guard listen(fd, 1) == 0 else {
                if state.socketIdentity() == socket { unlinkat(state.fd, "helper.sock", 0) }
                throw Failure("socket_unavailable")
            }
            self.state = state
            self.socket = socket
            self.fd = fd
        } catch {
            close(fd)
            throw error
        }
    }

    deinit { close(fd) }

    func removeSocket() {
        if intact { unlinkat(state.fd, "helper.sock", 0) }
    }

    var intact: Bool { state.socketIdentity() == socket }

    func acceptHost(_ host: ProcessIdentity, admission: Admission, signed: Bool) throws -> (Int32, Peer) {
        let deadline = DispatchTime.now() + .seconds(10)
        while DispatchTime.now() < deadline, intact, !admission.terminating {
            try host.verify()
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let n = poll(&event, 1, 100)
            if n == 0 || (n < 0 && errno == EINTR) { continue }
            guard n > 0, event.revents == POLLIN else { break }
            let peer = accept(fd, nil, nil)
            guard peer >= 0 else { continue }
            if let identity = try? Peer.authenticate(peer, expecting: host, signed: signed) { return (peer, identity) }
            close(peer)
        }
        throw Failure("host_unavailable")
    }
}

final class Connection: @unchecked Sendable {
    let fd: Int32
    let listener: Listener
    let peer: Peer
    let admission: Admission
    private let writer = DispatchQueue(label: "rome.computer-use.writer", qos: .userInitiated)
    private let output = NSLock()
    private var pendingBytes = 0
    private var pendingFrames = 0

    init(fd: Int32, listener: Listener, peer: Peer, admission: Admission) throws {
        var enabled: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout.size(ofValue: enabled))) == 0 else {
            close(fd)
            throw Failure("socket_unavailable")
        }
        self.fd = fd
        self.listener = listener
        self.peer = peer
        self.admission = admission
    }

    deinit { close(fd) }

    func end(_ reason: String = "connection_closed") {
        _ = admission.stop(reason)
        shutdown(fd, SHUT_RDWR)
    }

    func verify() throws {
        do { try checkLive() }
        catch {
            end((error as? Failure)?.code ?? "connection_closed")
            throw error
        }
    }

    func checkLive(allowInput: Bool = true) throws {
        try peer.identity.verifyPeer()
        var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard !admission.terminating, listener.intact,
              poll(&event, 1, 0) >= 0, Int32(event.revents) & (POLLHUP | POLLERR | POLLNVAL) == 0 else {
            throw Failure("connection_closed")
        }
        guard event.revents & Int16(POLLIN) != 0 else { return }
        var byte: UInt8 = 0
        let peek = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        guard (allowInput && peek > 0) || (peek < 0 && [EAGAIN, EWOULDBLOCK, EINTR].contains(errno)) else {
            throw Failure("connection_closed")
        }
    }

    func next() throws -> Request {
        let lengths = try Wire.lengths(readBytes(fd, count: 8), request: true)
        return try Wire.request(readBytes(fd, count: lengths.0))
    }

    func sendNow(_ frame: Data) throws {
        try verify()
        try sendBytes(fd, frame)
    }

    func flush() { writer.sync {} }

    func send(_ frame: Data) throws {
        let queued = output.withLock {
            guard pendingFrames < 16, pendingBytes + frame.count <= Wire.imageLimit + 2 * Wire.metadataLimit else { return false }
            pendingBytes += frame.count
            pendingFrames += 1
            return true
        }
        guard queued else {
            end()
            throw Failure("connection_closed")
        }
        writer.async {
            defer {
                self.output.withLock {
                    self.pendingBytes -= frame.count
                    self.pendingFrames -= 1
                }
            }
            do { try self.sendNow(frame) }
            catch { self.end() }
        }
    }
}

// A provider must stop waiting when canContinue returns false.
typealias ConsentProvider = @Sendable (_ peer: Peer, _ canContinue: @escaping @Sendable () -> Bool) -> Bool

func serve(listener: Listener, host: ProcessIdentity, handshake: Handshake,
           admission: Admission, desktop: DesktopSession?, consent: ConsentProvider) throws {
    defer { listener.removeSocket() }
    let (fd, peer) = try listener.acceptHost(host, admission: admission, signed: desktop != nil)
    let connection = try Connection(fd: fd, listener: listener, peer: peer, admission: admission)
    defer { connection.end() }

    let watchdogQueue = DispatchQueue(label: "rome.computer-use.watchdog", qos: .userInitiated)
    func watch(_ check: @escaping @Sendable () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: watchdogQueue)
        timer.setEventHandler(handler: check)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(10))
        timer.resume()
        return timer
    }

    let handshakeDeadline = DispatchTime.now() + .seconds(5)
    let first: Request = try {
        let timer = watch {
            if DispatchTime.now() >= handshakeDeadline { connection.end() }
            else { try? connection.verify() }
        }
        defer {
            timer.cancel()
            // Drain the deadline check before entering the consent phase.
            watchdogQueue.sync {}
        }
        return try connection.next()
    }()

    guard DispatchTime.now() < handshakeDeadline else { throw Failure("connection_closed") }
    guard first.v == 1, first.method == "handshake",
          let rawNonce = first.params?.nonce, let nonce = Data(base64Encoded: rawNonce),
          let rawProof = first.params?.proof, let proof = Data(base64Encoded: rawProof),
          handshake.verifyHost(proof, nonce: nonce) else {
        try connection.sendNow(Wire.failure(first.id, "authentication_failed"))
        return
    }
    let instance = UUID().uuidString
    let helper = getpid()
    let helperProof = handshake.helperProof(helper: helper, nonce: nonce, instance: instance)
    let consentDeadline = DispatchTime.now() + .seconds(60)
    let canContinue: @Sendable () -> Bool = {
        do {
            // Preserve the write side so a peer that half-closes can receive the denial.
            try connection.checkLive(allowInput: false)
            try admission.check()
            return DispatchTime.now() < consentDeadline
        } catch {
            if (error as? Failure)?.code == "process_identity_changed" { connection.end("process_identity_changed") }
            return false
        }
    }
    guard canContinue(), consent(peer, canContinue), canContinue() else {
        _ = admission.stop("consent_denied")
        try? sendBytes(fd, Wire.failure(first.id, "consent_denied"))
        return
    }
    try connection.sendNow(Wire.reply(first.id, result: [
        "instance": instance, "pid": helper, "proof": helperProof.base64EncodedString(),
    ]))
    let watchdog = watch { try? connection.verify() }
    defer { watchdog.cancel() }

    let access = DesktopAccess()
    // A console scan can block without delaying the transport watchdog.
    let accessWatchdog = desktop != nil ? DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated)) : nil
    accessWatchdog?.setEventHandler {
        guard admission.needsAccessCheck else { return }
        do { try access.check() }
        catch { _ = admission.stop((error as? Failure)?.code ?? "session_stopped") }
    }
    accessWatchdog?.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1), leeway: .milliseconds(100))
    accessWatchdog?.resume()
    defer { accessWatchdog?.cancel() }

    let worker = DispatchQueue(label: "rome.computer-use.window", qos: .userInitiated)
    let windows = Windows(worker: worker, access: access, live: {
        try connection.verify()
        try admission.check()
    }, onRevocation: { hasBinding, label in
        admission.updateBindings(hasBinding)
        if let desktop { DispatchQueue.main.async { desktop.updateBinding(label) } }
    })
    admission.whenStopped { [weak windows] in
        worker.async { [weak windows] in
            windows?.stopAll()
            admission.updateBindings(false)
            if let desktop { DispatchQueue.main.async { desktop.updateBinding(nil) } }
        }
    }
    defer {
        _ = admission.stop()
        worker.sync { windows.stopAll() }
    }

    while true {
        let request: Request
        do { request = try connection.next() }
        catch let failure as Failure {
            if failure.code == "invalid_request" {
                try connection.send(Wire.failure(nil, failure.code))
                continue
            }
            if failure.code != "connection_closed" {
                _ = admission.stop()
                try connection.send(Wire.failure(nil, failure.code))
                connection.flush()
            }
            return
        }

        do {
            guard request.v == 1 else { throw Failure("unsupported_version") }
            switch request.method {
            case "status":
                var status = admission.status()
                status["instance"] = instance
                try connection.send(Wire.reply(request.id, result: status))
            case "cancel", "stop":
                let state = admission.stop()
                try connection.send(Wire.reply(request.id, result: state))
            case "windows", "bind", "unbind", "observe", "act":
                guard let desktop else { throw Failure("desktop_disabled") }
                try connection.verify()
                try admission.begin()
                worker.async {
                    let previousLabel = windows.bindingLabel
                    let response: Data?
                    do {
                        let args = request.params
                        let result: [String: Any]
                        var image: Wire.Image?
                        switch request.method {
                        case "windows":
                            result = try windows.list(application: args?.application)
                        case "bind":
                            guard let window = args?.window, window != 0 else { throw Failure("invalid_request") }
                            result = try windows.bind(window)
                        case "unbind":
                            guard let id = args?.binding else { throw Failure("invalid_request") }
                            result = try windows.unbind(id)
                        case "observe":
                            guard let id = args?.binding else { throw Failure("invalid_request") }
                            (result, image) = try windows.observe(id, screenshot: args?.screenshot ?? false)
                        default:
                            guard let args, let id = args.binding, let action = args.action else {
                                throw Failure("invalid_request")
                            }
                            if let input = try WindowInput(action: action, args: args) {
                                result = try windows.input(id, input)
                            } else {
                                guard let ref = args.element else { throw Failure("invalid_request") }
                                result = try windows.act(id, element: ref, action: action, input: args.value)
                            }
                        }
                        response = try Wire.reply(request.id, result: result, image: image)
                    } catch {
                        response = try? Wire.failure(request.id, (error as? Failure)?.code ?? "internal_error")
                    }
                    let label = windows.bindingLabel
                    if label != previousLabel { DispatchQueue.main.async { desktop.updateBinding(label) } }
                    admission.finish(hasBinding: windows.hasBinding)
                    if let response { try? connection.send(response) }
                }
            default:
                throw Failure("method_unavailable")
            }
        } catch let failure as Failure {
            if failure.code == "connection_closed" || failure.code == "process_identity_changed" { return }
            try connection.send(Wire.failure(request.id, failure.code))
        }
    }
}

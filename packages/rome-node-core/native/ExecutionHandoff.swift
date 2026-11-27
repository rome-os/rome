import AppKit
import Darwin
import Foundation
import Security

extension Peer {
    func requireSameHelper() throws {
        var own: SecCode?
        var ownStatic: SecStaticCode?
        var peerStatic: SecStaticCode?
        func signingInfo(_ code: SecStaticCode) -> [String: Any]? {
            var raw: CFDictionary?
            guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &raw) == errSecSuccess else { return nil }
            return raw as? [String: Any]
        }
        var requirement: SecRequirement?
        var other: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: audit] as CFDictionary
        guard signedApp(), identity.executable == Bundle.main.executableURL.flatMap({ canonicalPath($0.path) }),
              signingSummary?.identifier == bundleIdentifier, signingSummary?.isAdHoc == false,
              signingSummary?.teamID != nil, SecCodeCopySelf([], &own) == errSecSuccess, let own,
              SecCodeCopyStaticCode(own, [], &ownStatic) == errSecSuccess, let ownStatic,
              SecCodeCopyDesignatedRequirement(ownStatic, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCopyGuestWithAttributes(nil, attributes, [], &other) == errSecSuccess, let other,
              SecCodeCheckValidity(other, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
              SecCodeCopyStaticCode(other, [], &peerStatic) == errSecSuccess, let peerStatic,
              let ownInfo = signingInfo(ownStatic),
              let team = ownInfo[kSecCodeInfoTeamIdentifier as String] as? String, team == signingSummary?.teamID,
              let hash = ownInfo[kSecCodeInfoUnique as String] as? Data,
              signingInfo(peerStatic)?[kSecCodeInfoUnique as String] as? Data == hash
        else { throw Failure("authentication_failed") }
        try identity.verify()
    }
}

extension Windows {
    func response(to request: Request) throws -> Data {
        let args = request.params
        let result: [String: Any]
        var image: Wire.Image?
        switch request.method {
        case "windows": result = try list(application: args?.application)
        case "bind":
            guard let id = args?.window, id != 0 else { throw Failure("invalid_request") }
            result = try bind(id)
        case "unbind":
            guard let id = args?.binding else { throw Failure("invalid_request") }
            result = try unbind(id)
        case "observe":
            guard let id = args?.binding else { throw Failure("invalid_request") }
            (result, image) = try observe(id, element: args?.element, screenshot: args?.screenshot ?? false)
        case "act":
            guard let args, let id = args.binding, let action = args.action else { throw Failure("invalid_request") }
            if let input = try WindowInput(action: action, args: args) { result = try self.input(id, input) }
            else {
                guard let ref = args.element else { throw Failure("invalid_request") }
                result = try act(id, element: ref, action: action, input: args.value)
            }
        default: throw Failure("method_unavailable")
        }
        return try Wire.reply(request.id, result: result, image: image)
    }
}

final class ExecutionHandoff: Sendable {
    static let greeting = Data("Rome approved execution v1\n".utf8)
    private let channel: Connection
    private let listener: Listener
    private let exited: DispatchSourceProcess
    private let childFinished = DispatchGroup()

    init(channel: Connection, listener: Listener, onExit: @escaping @Sendable () -> Void) {
        self.channel = channel
        self.listener = listener
        exited = DispatchSource.makeProcessSource(identifier: channel.peer.identity.pid, eventMask: .exit,
                                                  queue: .global(qos: .userInitiated))
        childFinished.enter()
        exited.setEventHandler { [childFinished] in
            onExit()
            childFinished.leave()
        }
        exited.resume()
    }

    deinit {
        exited.cancel()
        stop()
        listener.removeSocket()
        if listener.state.intact { rmdir(listener.state.path) }
    }

    static func start(admission: Admission, connection: Connection) throws -> ExecutionHandoff {
        let path = "/private/tmp/rome-execution-" + UUID().uuidString
        guard mkdir(path, 0o700) == 0 else { throw Failure("socket_unavailable") }
        do {
            let listener = try Listener(state: StateDirectory(path))
            do {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.createsNewApplicationInstance = true
                configuration.activates = false
                configuration.addsToRecentItems = false
                configuration.promptsUserIfNeeded = false
                configuration.arguments = ["--execute-approved", path, String(getpid())]
                let launched = DispatchSemaphore(value: 0)
                var childPID: pid_t?
                try admission.check()
                try connection.verify()
                NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { app, _ in
                    childPID = app?.processIdentifier
                    launched.signal()
                }
                guard launched.wait(timeout: .now() + .seconds(5)) == .success, let pid = childPID else {
                    throw Failure("startup_timeout")
                }
                let (fd, peer) = try listener.acceptHost(ProcessIdentity.read(pid), admission: admission, signed: true)
                let channel = try Connection(fd: fd, listener: listener, peer: peer, admission: admission)
                try peer.requireSameHelper()
                try admission.check()
                try connection.verify()
                try channel.sendNow(greeting)
                var timeout = timeval(tv_sec: 3, tv_usec: 0)
                guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
                      try readBytes(fd, count: 1) == Data([1]) else { throw Failure("cancelled") }
                timeout.tv_sec = 0
                guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0
                else { throw Failure("socket_unavailable") }
                // Closing the proxy seals input immediately. Stop confirmation also waits for the child to exit.
                admission.setExecutionHelperRunning(true)
                return ExecutionHandoff(channel: channel, listener: listener) {
                    admission.setExecutionHelperRunning(false)
                    if (try? admission.check()) != nil { connection.end() }
                }
            } catch {
                listener.removeSocket()
                throw error
            }
        } catch {
            rmdir(path)
            throw error
        }
    }

    func stop() { shutdown(channel.fd, SHUT_RDWR) }

    func waitForExit() {
        if childFinished.wait(timeout: .now() + .seconds(2)) == .timedOut,
           (try? channel.peer.identity.verify()) != nil {
            kill(channel.peer.identity.pid, SIGKILL)
            _ = childFinished.wait(timeout: .now() + .seconds(1))
        }
    }

    // The original helper's window worker owns both directions of this stream.
    func execute(_ body: Data) throws -> (Data, Int) {
        try channel.admission.check()
        var length = UInt32(body.count).bigEndian
        try channel.sendNow(withUnsafeBytes(of: &length) { Data($0) } + Data(count: 4) + body)
        let count = Wire.integer(try readBytes(channel.fd, count: 4))
        let header = try readBytes(channel.fd, count: 8)
        let (metadata, binary) = try Wire.lengths(header, request: false)
        return (header + (try readBytes(channel.fd, count: metadata + binary)), count)
    }

    static func watchParent(_ channel: Connection, until finished: DispatchGroup) -> DispatchSourceTimer {
        let watchdog = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        watchdog.setEventHandler {
            do { try channel.checkLive() } catch {
                channel.end()
                // The window worker releases a pressed drag button while the server unwinds.
                if finished.wait(timeout: .now() + .seconds(2)) == .timedOut { exit(0) }
            }
        }
        watchdog.schedule(deadline: .now(), repeating: .milliseconds(100))
        watchdog.resume()
        return watchdog
    }

    static func acceptGreeting(on channel: Connection, check: () throws -> Void) throws {
        let fd = channel.fd
        var timeout = timeval(tv_sec: 8, tv_usec: 0)
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
              try readBytes(fd, count: greeting.count) == greeting else { throw Failure("authentication_failed") }
        try check()
        try channel.sendNow(Data([1]))
        timeout.tv_sec = 0
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0
        else { throw Failure("socket_unavailable") }
    }

    static func checkAccess(_ access: DesktopAccess, trusted: Bool = AXIsProcessTrusted(),
                            recording: Bool = CGPreflightScreenCaptureAccess(),
                            console: @autoclosure () -> Bool = DesktopAccess.consoleAvailable(Windows.onScreen())) throws {
        try DesktopAccess.require(trusted: trusted, console: console())
        try access.recording(granted: recording, required: true)
    }

    static func serve(path: String, parent: pid_t) throws {
        let state = try StateDirectory(path)
        guard let socket = state.socketIdentity() else { throw Failure("socket_unavailable") }
        let host = try ProcessIdentity.read(parent)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure("socket_unavailable") }
        let peer: Peer
        do {
            guard try socketAddress(path + "/helper.sock", { connect(fd, $0, $1) }) == 0 else { throw Failure("connection_closed") }
            peer = try Peer.authenticate(fd, expecting: host, signed: true)
            try peer.requireSameHelper()
        } catch { close(fd); throw error }
        let admission = Admission()
        let channel = try Connection(fd: fd, peer: peer, admission: admission, intact: { state.socketIdentity() == socket })
        let access = DesktopAccess()
        let worker = DispatchQueue(label: "rome.computer-use.approved-window")
        let check = {
            try channel.verify()
            try checkAccess(access)
        }
        let finished = DispatchGroup()
        finished.enter()
        let watchdog = watchParent(channel, until: finished)
        defer { watchdog.cancel(); finished.leave() }
        try acceptGreeting(on: channel, check: check)
        let accessWatchdog = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        accessWatchdog.setEventHandler {
            guard PermissionChecks.system.missing().isEmpty else { channel.end(); return }
            if admission.needsAccessCheck {
                do { try check() } catch { channel.end() }
            }
        }
        accessWatchdog.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        accessWatchdog.resume()
        defer { accessWatchdog.cancel() }
        let windows = Windows(worker: worker, access: access, live: {
            try admission.check()
            try channel.verify()
        }, onRevocation: { count in admission.updateBindings(count != 0) })
        defer { worker.sync { windows.stopAll() } }
        while true {
            let request = try channel.next()
            guard request.v == 1 else { throw Failure("unsupported_version") }
            try worker.sync {
                try check()
                try admission.begin()
                defer { admission.finish(hasBinding: windows.bindingCount != 0) }
                let frame: Data
                do { frame = try windows.response(to: request) }
                catch { frame = try Wire.failure(request.id, (error as? Failure)?.code ?? "internal_error") }
                var count = UInt32(windows.bindingCount).bigEndian
                try channel.sendNow(withUnsafeBytes(of: &count) { Data($0) } + frame)
            }
        }
    }
}

@MainActor
func runApprovedExecution(path: String, parent: pid_t) throws -> Never {
    let app = NSApplication.shared
    try requireAccessoryPolicy(current: app.activationPolicy, set: app.setActivationPolicy)
    DispatchQueue.global(qos: .userInitiated).async {
        do { try ExecutionHandoff.serve(path: path, parent: parent); exit(0) }
        catch let failure as Failure where failure.code == "connection_closed" { exit(0) }
        catch { exit(1) }
    }
    app.run()
    exit(0)
}

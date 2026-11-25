#if SELF_TEST_BUILD
import CoreGraphics
import CryptoKit
import Darwin
import Darwin.libproc
import Darwin.sys.proc_info
import Foundation

final class SelfTest {
    private var assertions = 0

    static func run() throws {
        let test = SelfTest()
        try test.identity()
        try test.windows()
        try test.consent()
        try test.frames()
        try test.admission()
        try test.transport()
        print("{\"ok\":true,\"assertions\":\(test.assertions)}")
    }

    private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw Failure("self-test: \(message)") }
        assertions += 1
    }

    private func rejects(_ code: String, _ body: () throws -> Void) throws {
        do { try body() }
        catch let failure as Failure {
            try expect(failure.code == code, "expected \(code), received \(failure.code)")
            return
        }
        throw Failure("self-test: expected \(code)")
    }

    private func identity() throws {
        let me = try ProcessIdentity.read(getpid())
        try expect(me.pid == getpid() && me.uid == getuid(), "kernel pid and uid")
        try expect(me.executable.hasPrefix("/") && me.seconds > 0 && me.microseconds < 1_000_000, "kernel path and birth time")
        try me.verify()
        try rejects("process_identity_unavailable") { _ = try ProcessIdentity.read(-1) }
        try rejects("process_identity_unavailable") { _ = try ProcessIdentity.read(Int32.max) }
        for fake in [
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds + 1,
                            microseconds: me.microseconds, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds,
                            microseconds: me.microseconds + 1, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid + 1, seconds: me.seconds,
                            microseconds: me.microseconds, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds,
                            microseconds: me.microseconds, executable: "/unknown", generation: me.generation),
        ] {
            try rejects("process_identity_changed") { try fake.verify() }
        }
    }

    private func windows() throws {
        let first = WindowRow(id: 1, pid: 42, bounds: CGRect(x: 1, y: 3, width: 400, height: 300))
        let second = WindowRow(id: 2, pid: 42, bounds: first.bounds.offsetBy(dx: 300, dy: 0))
        let ghost = WindowRow(id: 3, pid: 42, bounds: first.bounds.offsetBy(dx: 700, dy: 0))
        let differentPID = WindowRow(id: 4, pid: 43, bounds: first.bounds)
        let roots = [first.bounds, second.bounds]
        let rows = [first, second, ghost, differentPID]
        try expect(uniqueRoot(first, rows: rows, roots: roots) == 0, "first same-PID window")
        try expect(uniqueRoot(second, rows: rows, roots: roots) == 1, "second same-PID window")
        try expect(uniqueRoot(ghost, rows: rows, roots: roots) == nil, "ghost has no AX root")
        try expect(uniqueRoot(first, rows: rows, roots: [first.bounds, first.bounds]) == nil, "ambiguous AX roots")
        try expect(uniqueRoot(first, rows: rows + [WindowRow(id: 5, pid: 42, bounds: first.bounds)], roots: roots) == nil,
                   "ambiguous CG rows")
        let offscreen = WindowRow(id: 5, pid: 42, bounds: first.bounds, visible: false)
        try expect(uniqueRoot(first, rows: rows + [offscreen], roots: roots) == nil, "offscreen geometry can create ambiguity")
        try expect(uniqueRoot(offscreen, rows: [offscreen], roots: roots) == nil, "offscreen window is ineligible")
        try expect(uniqueRoot(first, rows: [second], roots: roots) == nil, "closed CG window fails revalidation")
        try expect(uniqueRoot(first, rows: rows, roots: [second.bounds]) == nil, "closed AX root fails revalidation")
        try rejects("accessibility_permission_required") {
            try DesktopAccess.require(trusted: false, console: true)
        }
        try rejects("console_unavailable") { try DesktopAccess.require(trusted: true, console: false) }
        let layer = kCGWindowLayer as String
        let cursor = [layer: CGWindowLevelForKey(.cursorWindow), kCGWindowOwnerName as String: "Window Server"] as [String: Any]
        try expect(DesktopAccess.visibleLayersClear([[layer: 0], cursor]), "cursor does not make the console unavailable")
        try expect(!DesktopAccess.visibleLayersClear([[layer: CGShieldingWindowLevel()]]), "shielded console is unavailable")
        try expect(!DesktopAccess.visibleLayersClear(nil), "missing window list fails closed")
        let access = DesktopAccess()
        try access.recording(granted: false, required: false)
        try rejects("screen_recording_permission_required") { try access.recording(granted: false, required: true) }
        try access.recording(granted: true, required: true)
        try rejects("screen_recording_permission_required") { try access.recording(granted: false, required: false) }
    }

    private func consent() throws {
        let prompt = CGRect(x: 140, y: 260, width: 320, height: 220)
        let helper: pid_t = 42
        let server: pid_t = 43
        let other: pid_t = 44
        let cursor = CGWindowLevelForKey(.cursorWindow)
        let layerKey = kCGWindowLayer as String
        func row(_ pid: pid_t, _ bounds: CGRect, layer: Int32 = 0, owner: String = "Other App",
                 alpha: Double = 1) -> [String: Any] {
            [kCGWindowOwnerPID as String: pid, kCGWindowBounds as String: bounds.dictionaryRepresentation,
             layerKey: layer, kCGWindowOwnerName as String: owner, kCGWindowAlpha as String: alpha]
        }
        func clear(_ above: ArraySlice<[String: Any]>?, bounds: CGRect? = prompt) -> Bool {
            ConsentOcclusion.clear(alertBounds: bounds, above: above, helperPID: helper) { $0 == server }
        }
        try expect(ConsentOcclusion.alertLevel > Int(CGWindowLevelForKey(.statusWindow)) &&
                   ConsentOcclusion.alertLevel > Int(CGWindowLevelForKey(.popUpMenuWindow)) &&
                   DesktopAccess.visibleLayersClear([[layerKey: ConsentOcclusion.alertLevel]]),
                   "consent is above menus and status windows without blocking the console")
        try expect(!clear([row(other, prompt)]), "overlapping window from another process blocks consent")
        try expect(!clear([row(other, prompt, alpha: 0)]), "transparent click-through window blocks consent")
        try expect(clear([row(other, prompt.offsetBy(dx: 400, dy: 0))]), "nonoverlapping window leaves consent clear")
        try expect(clear([row(other, .zero), row(helper, prompt)]), "empty and helper-owned windows leave consent clear")
        try expect(clear([row(server, prompt, layer: cursor, owner: "Window Server")]), "system cursor leaves consent clear")
        try expect(!clear([row(server, prompt, owner: "Window Server")]), "other Window Server layers block consent")
        try expect(!clear([row(other, prompt, layer: cursor, owner: "Window Server")]), "cursor exemption requires the Window Server PID")
        try expect(!clear(nil) && !clear([], bounds: nil) && !clear([[kCGWindowOwnerPID as String: other]]),
                   "missing window data fails closed")

        var unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "consent starts locked")
        try expect(!unlock.update(focused: true, at: 0.99), "consent stays locked for the first second")
        try expect(unlock.update(focused: true, at: 1), "consent unlocks after one focused second")
        try expect(!unlock.update(focused: false, at: 1.1), "focus loss relocks consent immediately")
        unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "a new confirmation starts locked")
        try expect(!unlock.update(focused: false, at: 0.8), "focus loss clears the partial delay")
        try expect(!unlock.update(focused: true, at: 1), "regaining focus restarts the delay")
        try expect(!unlock.update(focused: true, at: 1.2), "prior focus time does not count")
        try expect(unlock.update(focused: true, at: 2), "consent unlocks after a full second of renewed focus")
    }

    private func decode(_ data: Data) throws -> ([String: Any], Data) {
        let (json, binary) = try Wire.lengths(data.prefix(8), request: false)
        try expect(data.count == 8 + json + binary, "frame uses both lengths")
        guard let result = try JSONSerialization.jsonObject(with: data[8..<(8 + json)]) as? [String: Any]
        else { throw Failure("self-test: invalid JSON") }
        return (result, data.suffix(binary))
    }

    private func frames() throws {
        let (normal, flat) = try decode(Wire.reply("normal", result: ["ready": true]))
        try expect(normal["v"] as? Int == 1 && normal["id"] as? String == "normal" && normal["ok"] as? Bool == true,
                   "normal envelope")
        try expect(flat.isEmpty, "normal has no binary")
        let (failed, none) = try decode(Wire.failure("failed", "window_unavailable"))
        try expect(failed["ok"] as? Bool == false &&
                   (failed["error"] as? [String: String])?["code"] == "window_unavailable" &&
                   failed["result"] == nil && none.isEmpty, "failure envelope")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=")!
        let image = try Wire.Image(png: png, width: 1, height: 1)
        let screenshot = try Wire.reply("capture", result: ["binding": "a"], image: image)
        let (capture, bytes) = try decode(screenshot)
        let result = capture["result"] as? [String: Any]
        let descriptor = result?["screenshot"] as? [String: Any]
        try expect(capture["ok"] as? Bool == true && result?["binding"] as? String == "a" &&
                   descriptor?["mimeType"] as? String == "image/png" && descriptor?["width"] as? Int == 1 &&
                   descriptor?["height"] as? Int == 1 && descriptor?["bytes"] as? Int == png.count &&
                   bytes == png, "screenshot uses same envelope and raw PNG payload")
        try rejects("frame_limit") { _ = try Wire.lengths(screenshot.prefix(8), request: true) }
        try rejects("invalid_frame") { _ = try Wire.lengths(Data(), request: false) }
        try rejects("frame_limit") { _ = try Wire.lengths(Data([0, 4, 0, 1, 0, 0, 0, 0]), request: false) }
        try rejects("frame_limit") { _ = try Wire.lengths(Data([0, 0, 0, 1, 0, 128, 0, 1]), request: false) }
        try rejects("capture_limit") { _ = try Wire.Image(png: png, width: 2, height: 1) }
        try rejects("capture_limit") { _ = try Wire.Image(png: Data(count: Wire.imageLimit + 1), width: 1, height: 1) }
        try rejects("capture_limit") { try Wire.Image.checkSize(2049, 1) }
        try rejects("capture_limit") { try Wire.Image.checkSize(2048, 1537) }
        try rejects("capture_limit") { try Wire.Image.checkSize(0, 1) }
        let request = try Wire.request(Data(#"{"v":1,"id":"a","method":"act","params":{"value":true}}"#.utf8))
        if case .checked(true) = request.params?.value { assertions += 1 }
        else { throw Failure("self-test: request boolean") }
    }

    private func admission() throws {
        let gate = Admission()
        try expect(!gate.needsAccessCheck, "idle admission needs no console scan")
        try gate.begin()
        try expect(gate.needsAccessCheck, "an active slot needs a console scan")
        gate.finish(hasBinding: true)
        try expect(gate.needsAccessCheck, "a live binding needs a console scan")
        try gate.begin()
        try rejects("busy") { try gate.begin() }
        let cancelled = gate.stop()
        try expect(cancelled["stop"] as? String == "cancel_requested", "cancel while slot is active")
        try expect(!gate.needsAccessCheck, "sealed admission needs no console scan")
        try rejects("session_stopped") { try gate.check() }
        gate.finish(hasBinding: false)
        try expect(gate.status()["stop"] as? String == "stop_confirmed", "confirm once slot retires")
        try rejects("session_stopped") { try gate.begin() }
    }

    private func transport() throws {
        var template = Array("/private/tmp/rome-native.XXXXXX".utf8CString)
        let path = try template.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress, let temporary = mkdtemp(base) else { throw Failure("self-test: mkdtemp") }
            return String(cString: temporary)
        }
        defer { try? FileManager.default.removeItem(atPath: path) }
        let socket = path + "/helper.sock"
        let link = path + "/alias"
        try expect(chmod(path, 0o755) == 0, "set unsafe mode")
        try rejects("unsafe_state_directory") { _ = try StateDirectory(path) }
        try expect(chmod(path, 0o700) == 0, "restore private mode")
        try expect(symlink(path, link) == 0, "make directory alias")
        try rejects("unsafe_state_directory") { _ = try StateDirectory(link) }
        try rejects("unsafe_state_directory") { _ = try StateDirectory(link + "/..") }

        try bootstrap(path)

        var pair: [Int32] = [-1, -1]
        try expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0, "socket pair")
        defer { pair.forEach { close($0) } }
        let me = try ProcessIdentity.read(getpid())
        let other = ProcessIdentity(pid: me.pid + 1, uid: me.uid, seconds: me.seconds,
                                    microseconds: me.microseconds, executable: me.executable, generation: me.generation)
        let first = try Peer.authenticate(pair[0], expecting: me, signed: false)
        let second = try Peer.authenticate(pair[1], expecting: me, signed: false)
        try expect(first.audit == second.audit && first.identity == me, "both endpoints bind to audit identity")
        try rejects("peer_rejected") { _ = try Peer.authenticate(pair[1], expecting: other, signed: false) }

        try runServer(path, socket: socket, mode: .wrongProof)
        try runServer(path, socket: socket, mode: .localStop)
        try runServer(path, socket: socket, mode: .replaceSocket)
        try runServer(path, socket: socket, mode: .disconnect)
        try runServer(path, socket: socket, mode: .terminate)
        try runServer(path, socket: socket, mode: .consentDenied)
        try runServer(path, socket: socket, mode: .consentDisconnect)
        try runServer(path, socket: socket, mode: .consentTerminate)
        try runServer(path, socket: socket, mode: .consentStop)
        try execConnection(path, executable: me.executable)
    }

    private func execConnection(_ path: String, executable: String) throws {
        let admission = Admission()
        let listener = try Listener(state: StateDirectory(path))
        defer { listener.removeSocket() }
        let command = Pipe()
        let ready = Pipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = ["--self-test-exec-peer", path + "/helper.sock"]
        child.standardInput = command
        child.standardOutput = ready
        try child.run()
        defer {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
        func marker(_ expected: UInt8) throws {
            let fd = ready.fileHandleForReading.fileDescriptor
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            try expect(poll(&event, 1, 3_000) > 0, "exec fixture responds")
            try expect(try readBytes(fd, count: 1) == Data([expected]), "exec fixture reaches expected phase")
        }
        try marker(1)
        let original = try ProcessIdentity.read(child.processIdentifier)
        let (fd, peer) = try listener.acceptHost(original, admission: admission, signed: false)
        let connection = try Connection(fd: fd, listener: listener, peer: peer, admission: admission)
        try connection.verify()
        try command.fileHandleForWriting.write(contentsOf: Data([1]))
        try marker(2)
        let current = try ProcessIdentity.read(child.processIdentifier)
        try expect(current.pid == original.pid && current.uid == original.uid &&
                   current.executable == original.executable && current.seconds == original.seconds &&
                   current.microseconds == original.microseconds, "same-path exec preserves the legacy identity")
        try expect(current.generation.idVersion != original.generation.idVersion, "exec advances the audit PID version")
        try rejects("process_identity_changed") { try connection.verify() }
        try rejects("process_identity_changed") { try admission.begin() }
        child.waitUntilExit()
        try expect(child.terminationStatus == 0, "the inherited socket observes the server closing it")
        print("Same-path exec with an inherited socket is rejected.")
    }

    static func execPeer(_ socket: String) throws -> Never {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, try socketAddress(socket, { connect(fd, $0, $1) }) == 0 else {
            throw Failure("self-test: exec fixture connection")
        }
        try FileHandle.standardOutput.write(contentsOf: Data([1]))
        _ = try readBytes(STDIN_FILENO, count: 1)
        let executable = try ProcessIdentity.read(getpid()).executable
        var arguments = [strdup(executable), strdup("--self-test-exec-ready"), strdup(String(fd)), nil]
        defer { arguments.forEach { free($0) } }
        _ = arguments.withUnsafeMutableBufferPointer { execv(executable, $0.baseAddress!) }
        throw Failure("self-test: same-path exec failed")
    }

    static func inheritedSocket(_ fd: Int32) throws {
        var address = sockaddr_un()
        var length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &length) }
        }
        guard connected == 0 else { throw Failure("self-test: missing inherited connection") }
        try FileHandle.standardOutput.write(contentsOf: Data([2]))
        var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        var byte: UInt8 = 0
        guard poll(&event, 1, 3_000) > 0, recv(fd, &byte, 1, MSG_DONTWAIT) == 0 else {
            throw Failure("self-test: inherited connection stayed open")
        }
    }

    private func writeBootstrap(_ path: String, _ data: Data) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure("self-test: create bootstrap") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.close()
    }

    private func bootstrapData(secret: String, pid: pid_t, executable: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["secret": secret, "hostPid": pid, "hostExecutable": executable])
    }

    private func bootstrap(_ path: String) throws {
        let state = try StateDirectory(path)
        let file = path + "/bootstrap.json"
        let alias = path + "/bootstrap-target"
        let host = try ProcessIdentity.read(getpid())
        let secret = String(repeating: "a1", count: 32)
        let valid = try bootstrapData(secret: secret, pid: host.pid, executable: host.executable)

        try writeBootstrap(file, valid)
        try expect(chmod(file, 0o644) == 0, "change bootstrap mode")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(chmod(file, 0o600) == 0, "restore bootstrap mode")
        try expect(link(file, alias) == 0, "make hard link to bootstrap")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(unlink(file) == 0 && symlink(alias, file) == 0, "make symlink to bootstrap")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(FileManager.default.fileExists(atPath: alias), "bootstrap symlink target stays intact")
        try expect(unlink(file) == 0 && unlink(alias) == 0, "clean aliased bootstrap")

        let expired = Process()
        expired.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try expired.run()
        expired.waitUntilExit()
        for invalid in [
            Data("{".utf8),
            Data(count: 16385),
            try bootstrapData(secret: secret.uppercased(), pid: host.pid, executable: host.executable),
            try bootstrapData(secret: secret, pid: host.pid, executable: "/usr/bin/true"),
            try bootstrapData(secret: secret, pid: expired.processIdentifier, executable: "/usr/bin/true"),
        ] {
            try writeBootstrap(file, invalid)
            try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
            try expect(!FileManager.default.fileExists(atPath: file), "consume bootstrap before validating its contents")
        }
        try writeBootstrap(file, valid)
        let bootstrap = try state.consumeBootstrap()
        try expect(bootstrap.host == host, "bootstrap pins the host identity")
        try expect(bootstrap.key.withUnsafeBytes { $0.allSatisfy { $0 == 0xa1 } }, "decode lowercase hex key")
        try expect(!FileManager.default.fileExists(atPath: file), "valid bootstrap is consumed once")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
    }

    static func consentProvider(_ mode: String, path: String) throws -> ConsentProvider {
        switch mode {
        case "allow": return { _, _ in true }
        case "deny": return { _, _ in false }
        case "unexpected": return { _, _ in exit(99) }
        case "wait":
            return { _, canContinue in
                if !FileManager.default.createFile(atPath: path + "/consent-waiting", contents: Data()) { return false }
                while canContinue() { usleep(10_000) }
                return true
            }
        default: throw Failure("self-test: invalid consent fixture")
        }
    }

    private enum Mode {
        case wrongProof, localStop, replaceSocket, disconnect, terminate
        case consentDenied, consentDisconnect, consentTerminate, consentStop

        var provider: String {
            switch self {
            case .wrongProof: "unexpected"
            case .consentDenied: "deny"
            case .consentDisconnect, .consentTerminate, .consentStop: "wait"
            default: "allow"
            }
        }
    }

    private func runServer(_ path: String, socket: String, mode: Mode) throws {
        let key = SymmetricKey(size: .bits256)
        let secret = key.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() }
        let host = try ProcessIdentity.read(getpid())
        let bootstrap = path + "/bootstrap.json"
        try writeBootstrap(bootstrap, bootstrapData(secret: secret, pid: host.pid, executable: host.executable))

        // The launcher is the helper's parent, while this process owns the socket and key.
        let child = Process()
        let pidOutput = Pipe()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", #""$@" >/dev/null & server=$!; printf '%s\n' "$server"; exec >&-; wait "$server""#,
                           "rome-native-test", host.executable, "--self-test-server", path, mode.provider]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = pidOutput
        try child.run()
        var helper: pid_t?
        defer {
            if child.isRunning { kill(helper ?? child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
        guard let output = try pidOutput.fileHandleForReading.read(upToCount: 32),
              let pid = pid_t(String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0 else { throw Failure("self-test: missing helper pid") }
        helper = pid

        let deadline = DispatchTime.now() + .seconds(5)
        var fd: Int32 = -1
        while child.isRunning, DispatchTime.now() < deadline {
            let candidate = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard candidate >= 0 else { throw Failure("self-test: socket") }
            if try socketAddress(socket, { connect(candidate, $0, $1) }) == 0 {
                fd = candidate
                break
            }
            close(candidate)
            usleep(10_000)
        }
        try expect(fd >= 0, "connect to helper for \(mode)")
        defer { if fd >= 0 { close(fd) } }
        try expect(!FileManager.default.fileExists(atPath: bootstrap), "bootstrap removed before handshake")
        if mode == .disconnect {
            let contender = try StateDirectory(path)
            try expect(flock(contender.fd, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK,
                       "helper holds the state directory lock")
        }
        var noSignal: Int32 = 1
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        try expect(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal))) == 0,
                   "suppress SIGPIPE")
        try expect(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
                   "bound test read")
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        try expect(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size &&
                   info.pbi_ppid == UInt32(child.processIdentifier), "host and launcher have different PIDs")
        let target = try ProcessIdentity.read(pid)
        let peer = try Peer.authenticate(fd, expecting: target, signed: false)
        try expect(peer.identity == target, "host verifies helper peer")

        func response(_ method: String) throws -> [String: Any] {
            let (length, binary) = try Wire.lengths(readBytes(fd, count: 8), request: false)
            let data = try readBytes(fd, count: length)
            guard binary == 0, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  result["id"] as? String == method else { throw Failure("self-test: bad \(method) reply") }
            return result
        }

        func rpc(_ method: String, params: [String: Any] = [:]) throws -> [String: Any] {
            try sendBytes(fd, Wire.frame(["v": 1, "id": method, "method": method, "params": params]))
            return try response(method)
        }

        let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        func mac(_ fields: [String]) -> Data {
            let payload = Data((["rome-computer-use-v1"] + fields).joined(separator: "\n").utf8)
            return Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
        }
        let nonceText = nonce.base64EncodedString()
        let proof = mode == .wrongProof ? Data(count: 32) : mac(["host", String(host.pid), nonceText])
        try sendBytes(fd, Wire.frame(["v": 1, "id": "handshake", "method": "handshake", "params": [
            "nonce": nonceText, "proof": proof.base64EncodedString(),
        ]]))
        if mode.provider == "wait" {
            let marker = path + "/consent-waiting"
            let deadline = DispatchTime.now() + .seconds(2)
            while !FileManager.default.fileExists(atPath: marker), DispatchTime.now() < deadline { usleep(10_000) }
            try expect(unlink(marker) == 0, "provider waits after authentication")
            if mode == .consentDisconnect {
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 5_100) == 0, "consent can outlast the five-second handshake deadline")
                try expect(shutdown(fd, SHUT_WR) == 0, "disconnect while retaining the receive side")
            } else {
                try expect(kill(pid, mode == .consentStop ? SIGUSR1 : SIGTERM) == 0, "signal during consent")
            }
        }
        let reply = try response("handshake")
        if mode == .wrongProof {
            try expect((reply["error"] as? [String: String])?["code"] == "authentication_failed", "refuse invalid proof")
        } else if mode.provider != "allow" {
            try expect(reply["v"] as? Int == 1 && reply["ok"] as? Bool == false &&
                       (reply["error"] as? [String: String])?["code"] == "consent_denied", "reject session after \(mode)")
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            var byte: UInt8 = 0
            try expect(poll(&event, 1, 2_000) > 0 && recv(fd, &byte, 1, MSG_DONTWAIT) == 0,
                       "consent denial seals and closes the session")
            print("Consent denial and shutdown verified for \(mode).")
        } else {
            let result = reply["result"] as? [String: Any]
            guard let instance = result?["instance"] as? String, let proofString = result?["proof"] as? String,
                  let proof = Data(base64Encoded: proofString) else { throw Failure("self-test: handshake result") }
            try expect(result?["pid"] as? Int32 == pid, "handshake pid")
            try expect(proof == mac(["helper", String(host.pid), String(pid), nonceText, instance]), "helper proof")
            try expect(proof != mac(["host", String(host.pid), nonceText]), "proofs are role separated")
            let disabled = try rpc("windows")
            try expect((disabled["error"] as? [String: String])?["code"] == "desktop_disabled", "test helper cannot contact desktop")
            if mode == .localStop {
                try expect(kill(pid, SIGUSR1) == 0, "send local stop signal")
                var stopped = false
                let stopDeadline = DispatchTime.now() + .seconds(2)
                while DispatchTime.now() < stopDeadline {
                    let status = try rpc("status")["result"] as? [String: Any]
                    if status?["stop"] as? String == "stop_confirmed" { stopped = true; break }
                    usleep(10_000)
                }
                try expect(stopped, "local stop closes admission")
                let cancel = try rpc("cancel")["result"] as? [String: Any]
                try expect(cancel?["stop"] as? String == "stop_confirmed", "cancel is idempotent")
            } else if mode == .terminate {
                try expect(kill(pid, SIGTERM) == 0, "send terminate signal")
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 2_000) > 0, "terminate closes active socket")
                var byte: UInt8 = 0
                try expect(recv(fd, &byte, 1, 0) == 0, "no data follows terminate")
            } else if mode == .replaceSocket {
                try expect(rename(socket, socket + ".old") == 0, "unlink old socket name")
                let replacement = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
                guard replacement >= 0 else { throw Failure("self-test: replacement socket") }
                defer { close(replacement) }
                let oldMask = umask(0o177)
                defer { umask(oldMask) }
                try expect(try socketAddress(socket, { bind(replacement, $0, $1) }) == 0, "replace socket inode")
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 2_000) > 0, "replacement closes active socket")
                var byte: UInt8 = 0
                try expect(recv(fd, &byte, 1, 0) == 0, "replaced socket does not service requests")
            }
        }

        close(fd)
        fd = -1
        let exitDeadline = DispatchTime.now() + .seconds(3)
        while child.isRunning, DispatchTime.now() < exitDeadline { usleep(10_000) }
        try expect(!child.isRunning && child.terminationStatus == 0, "helper exits after \(mode)")
        if mode == .replaceSocket {
            try expect(FileManager.default.fileExists(atPath: socket), "helper preserves replacement socket")
            try expect(unlink(socket) == 0, "clean replacement test socket")
        } else {
            try expect(!FileManager.default.fileExists(atPath: socket), "helper cleans its socket")
        }
    }
}
#endif

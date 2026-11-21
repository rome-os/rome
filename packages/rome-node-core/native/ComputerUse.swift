import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin

struct NativeFailure: Error {
    let code: String
    let message: String
    let details: [String: Any]
    init(_ code: String, _ message: String? = nil, details: [String: Any] = [:]) {
        self.code = code
        self.message = message ?? code.replacingOccurrences(of: "_", with: " ")
        self.details = details
    }
}

enum Permissions {
    static var requestsAllowed: Bool {
        #if ROME_COMPUTER_USE_UNSIGNED
        return false
        #else
        return Bundle.main.object(forInfoDictionaryKey: "RomeComputerUseUnsigned") as? Bool != true
        #endif
    }
    static func status() -> [String: Any] {
        ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(),
         "postEvents": CGPreflightPostEventAccess(), "inputMonitoring": CGPreflightListenEventAccess()]
    }
}

@MainActor private func makeTerminationPoll(_ block: @escaping @Sendable (Timer) -> Void) -> Timer {
    let timer = Timer(timeInterval: 0.05, repeats: true, block: block)
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.add(timer, forMode: .modalPanel)
    return timer
}

final class RPCServer: @unchecked Sendable {
    let stateDirectory: URL
    let token: String
    let handler: ([String: Any], PeerIdentity) -> [String: Any]
    let onDisconnect: ((PeerIdentity, String?) -> Void)?
    private var listener: Int32 = -1
    private var lockFile: Int32 = -1
    private var socketInode: ino_t = 0
    private let maxFrame = 8 * 1024 * 1024

    init(directory: URL,
         onDisconnect: ((PeerIdentity, String?) -> Void)? = nil,
         handler: @escaping ([String: Any], PeerIdentity) -> [String: Any]) throws {
        stateDirectory = directory
        try NativePath.requireSafeDirectory(directory, privateMode: true, errorCode: "unsafe_state_directory")
        var info = stat()
        let tokenPath = directory.appendingPathComponent("token").path
        let tokenFile = open(tokenPath, O_RDONLY | O_NOFOLLOW)
        guard tokenFile >= 0 else { throw NativeFailure("unsafe_token_file") }
        defer { close(tokenFile) }
        guard fstat(tokenFile, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o777 == 0o600,
              info.st_nlink == 1, info.st_size >= 64, info.st_size <= 66 else { throw NativeFailure("unsafe_token_file") }
        var tokenData = [UInt8](repeating: 0, count: 67)
        let tokenCount = Darwin.read(tokenFile, &tokenData, tokenData.count)
        guard tokenCount >= 64, tokenCount <= 66 else { throw NativeFailure("invalid_token") }
        token = String(decoding: tokenData.prefix(tokenCount), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw NativeFailure("invalid_token")
        }
        self.onDisconnect = onDisconnect
        self.handler = handler
    }

    func start() throws {
        let path = stateDirectory.appendingPathComponent("helper.sock").path
        // A replacement child must not inherit the parent's service lock.
        lockFile = open(stateDirectory.appendingPathComponent("helper.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        var lockInfo = stat()
        guard lockFile >= 0, fstat(lockFile, &lockInfo) == 0, lockInfo.st_uid == getuid(),
              lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_mode & 0o777 == 0o600,
              flock(lockFile, LOCK_EX | LOCK_NB) == 0 else { throw NativeFailure("helper_already_running") }
        var prior = stat()
        if lstat(path, &prior) == 0 {
            guard prior.st_uid == getuid(), prior.st_mode & S_IFMT == S_IFSOCK else {
                throw NativeFailure("unsafe_socket_path")
            }
            // The process lock is held before removing a socket left by this helper's exit.
            guard unlink(path) == 0 else { throw NativeFailure("stale_socket_unavailable") }
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw NativeFailure("socket_path_too_long")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
        }
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0, fcntl(listener, F_SETFD, FD_CLOEXEC) == 0 else { throw NativeFailure("socket_failed") }
        var noSignal: Int32 = 1
        setsockopt(listener, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal)))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw NativeFailure("socket_already_bound") }
        guard chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            throw NativeFailure("socket_listen_failed")
        }
        var socketInfo = stat()
        if lstat(path, &socketInfo) == 0 { socketInode = socketInfo.st_ino }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            while true {
                let connection = accept(listener, nil, nil)
                if connection < 0 { break }
                var uid: uid_t = 0
                var gid: gid_t = 0
                var peerPid: pid_t = 0
                var pidLength = socklen_t(MemoryLayout<pid_t>.size)
                // Darwin sys/un.h: SOL_LOCAL = 0, LOCAL_PEERPID = 0x002.
                guard fcntl(connection, F_SETFD, FD_CLOEXEC) == 0,
                      getpeereid(connection, &uid, &gid) == 0, uid == getuid(),
                      getsockopt(connection, 0, 0x002, &peerPid, &pidLength) == 0, peerPid > 0,
                      let peer = try? PeerIdentity.read(peerPid) else {
                    close(connection)
                    continue
                }
                setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal)))
                DispatchQueue.global(qos: .userInitiated).async { [self] in serve(connection, peer: peer) }
            }
        }
    }

    func stop() {
        if listener >= 0 { close(listener); listener = -1 }
        let path = stateDirectory.appendingPathComponent("helper.sock").path
        var info = stat()
        if lstat(path, &info) == 0, info.st_uid == getuid(), info.st_ino == socketInode {
            _ = unlink(path)
        }
        if lockFile >= 0 { close(lockFile); lockFile = -1 }
    }

    private func readExactly(_ count: Int, from fd: Int32) -> Data? {
        var data = Data(count: count)
        var offset = 0
        let success = data.withUnsafeMutableBytes { buffer -> Bool in
            while offset < count {
                let received = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), count - offset)
                if received <= 0 { return false }
                offset += received
            }
            return true
        }
        return success ? data : nil
    }

    private func writeAll(_ data: Data, to fd: Int32) -> Bool {
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < data.count {
                let written = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), data.count - offset)
                if written <= 0 { return false }
                offset += written
            }
            return true
        }
    }

    private func serve(_ fd: Int32, peer: PeerIdentity) {
        defer { close(fd) }
        while let header = readExactly(4, from: fd) {
            let length = header.enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
            guard length > 0, length <= maxFrame, let body = readExactly(length, from: fd),
                  let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return }
            let sessionId = (request["params"] as? [String: Any])?["sessionId"] as? String
            let reply: [String: Any]
            if request["token"] as? String != token {
                reply = ["id": request["id"] ?? NSNull(), "ok": false,
                         "error": ["code": "unauthorized", "message": "The helper credential is invalid."]]
            } else {
                // Monitor the peer socket independently of the synchronous request worker so a
                // mid-action hangup or host crash latches connection_lost immediately.
                let cancelled = DispatchSemaphore(value: 0)
                let disconnectMonitor = DispatchSource.makeReadSource(
                    fileDescriptor: fd,
                    queue: DispatchQueue.global(qos: .userInitiated)
                )
                disconnectMonitor.setCancelHandler { cancelled.signal() }
                disconnectMonitor.setEventHandler { [weak self] in
                    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    let polled = poll(&pfd, 1, 0)
                    let hungUp = polled > 0 && (pfd.revents & Int16(POLLHUP | POLLERR)) != 0
                    if hungUp || !peer.isAlive() {
                        disconnectMonitor.cancel()
                        self?.onDisconnect?(peer, sessionId)
                    }
                }
                disconnectMonitor.resume()
                reply = handler(request, peer)
                disconnectMonitor.cancel()
                cancelled.wait()
            }
            guard let output = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]),
                  output.count <= maxFrame else { return }
            var size = UInt32(output.count).littleEndian
            let prefix = withUnsafeBytes(of: &size) { Data($0) }
            guard writeAll(prefix + output, to: fd) else {
                onDisconnect?(peer, sessionId)
                return
            }
        }
    }
}

@MainActor final class PermissionWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var status: NSTextField?
    private var timer: Timer?
    private var controls: [NSButton] = []
    private var retryButton: NSButton?
    private var checking = false
    private var nextCheck = 0.0
    private var persistentProbeAllowed = false
    private var checkUntil = 0.0
    private var lastFlags: PermissionFlags?
    private var restartFailed = false
    private var state = PermissionRecoveryState()
    private var detail = ""
    let progress = PermissionProgress()
    var cancel: (() -> Void)?
    var restart: (() -> Void)?

    func show(restarted: Bool = false) {
        persistentProbeAllowed = restarted
        if window == nil { buildWindow() }
        if state.phase == .restarting {
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        state.begin(restarted: restarted)
        progress.update(["phase": "checking", "ready": false])
        checkUntil = ProcessInfo.processInfo.systemUptime + 60
        nextCheck = 0
        if !restartFailed { detail = "Checking access. You can keep Rome open." }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        update()
    }

    private func buildWindow() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 480),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Rome Computer Use Permissions"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let identity = NSTextField(labelWithString: "com.rome.computer-use · signed application identity")
        identity.font = .systemFont(ofSize: 11)
        identity.textColor = .secondaryLabelColor
        identity.frame = NSRect(x: 24, y: 446, width: 552, height: 18)
        let heading = NSTextField(labelWithString: "Allow Rome to control background windows")
        heading.font = .boldSystemFont(ofSize: 17)
        heading.frame = NSRect(x: 24, y: 404, width: 552, height: 28)
        let explanation = NSTextField(wrappingLabelWithString: "Allow Screen Recording and Accessibility for selected background windows. Your agent uses its own cursor while you continue working. Keep Rome open; only the control component restarts if a new grant needs it.")
        explanation.frame = NSRect(x: 24, y: 332, width: 552, height: 65)
        let label = NSTextField(wrappingLabelWithString: "")
        label.frame = NSRect(x: 24, y: 230, width: 552, height: 92)
        status = label
        func button(_ title: String, _ action: Selector, x: CGFloat, y: CGFloat) -> NSButton {
            let button = NSButton(title: title, target: self, action: action)
            button.frame = NSRect(x: x, y: y, width: 272, height: 32)
            button.isEnabled = Permissions.requestsAllowed
            return button
        }
        let persistent = button("Check window access", #selector(selectPersistent), x: 20, y: 102)
        let screen = button("Allow Screen Recording…", #selector(screenPermission), x: 20, y: 144)
        let accessibility = button("Allow Accessibility…", #selector(accessibilityPermission), x: 304, y: 144)
        let retry = button("Check access again", #selector(checkAgain), x: 304, y: 102)
        controls = [persistent, screen, accessibility]
        retryButton = retry
        let stop = button("Stop all computer use", #selector(stopAll), x: 20, y: 24)
        for view in [identity, heading, explanation, label, persistent, screen, accessibility, retry, stop] {
            panel.contentView?.addSubview(view)
        }
        panel.center()
        NotificationCenter.default.addObserver(self, selector: #selector(applicationActivated), name: NSApplication.didBecomeActiveNotification, object: nil)
        window = panel
    }

    private func update() {
        guard window?.isVisible == true else { return }
        guard Permissions.requestsAllowed else {
            status?.stringValue = "Unsigned compile-only build. Privacy permission requests are disabled."
            return
        }
        let flags = PermissionFlags(Permissions.status())
        if let lastFlags, flags != lastFlags, state.phase != .restarting, !restartFailed {
            state.begin(restarted: state.restarted)
            checkUntil = ProcessInfo.processInfo.systemUptime + 60
            nextCheck = 0
        }
        lastFlags = flags
        updateLabel()
        guard !restartFailed else { return }
        if !persistentProbeAllowed {
            detail = "Allow the required permissions, then check window access."
            progress.update(["phase": "needs_permission", "ready": false, "captureMode": "persistent"])
            updateLabel()
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        guard !checking, state.phase != .restarting, state.phase != .error, now < checkUntil, now >= nextCheck else { return }
        checking = true
        nextCheck = now + (state.phase == .ready ? 5 : 3)
        let epoch = state.generation
        let executable = Bundle.main.executableURL
        let allowPersistent = persistentProbeAllowed
        let panelWindowID = window.map { CGWindowID($0.windowNumber) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let readiness = PermissionReadiness.check(allowPersistentCapture: allowPersistent, windowID: panelWindowID)
            let current = PermissionFlags(Permissions.status())
            let ready = readiness["ready"] as? Bool == true
            let fresh = !ready && !current.granted ? executable.flatMap { FreshPermissionProbe.read(executable: $0) } : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.checking = false
                guard self.window?.isVisible == true else { return }
                guard epoch == self.state.generation else { self.update(); return }
                let restart = self.state.complete(ready: ready, current: current, fresh: fresh, epoch: epoch)
                switch self.state.phase {
                case .ready:
                    self.detail = "Ready. Rome can continue without restarting its main app."
                case .restarting:
                    self.detail = "Restarting only the control component. Old control sessions will close."
                case .needsPermission:
                    self.detail = !current.accessibility || !current.postEvents
                        ? "Allow the missing input permissions in System Settings, then return here."
                        : "Allow Screen Recording in System Settings, then return here."
                case .checking:
                    self.detail = "Checking window capture and accessibility."
                case .error:
                    self.detail = "Access is not ready. Review the requested permissions, then check again."
                }
                self.progress.update(readiness.merging(["phase": self.state.phase.rawValue, "checkedAt": Date().timeIntervalSince1970]) { _, new in new })
                self.updateLabel()
                if restart { self.restart?() }
            }
        }
    }

    private func updateLabel() {
        let mode = persistentProbeAllowed ? "Persistent access" : "Not checked yet"
        for control in controls { control.isEnabled = Permissions.requestsAllowed && state.phase != .restarting && !restartFailed }
        retryButton?.isEnabled = Permissions.requestsAllowed && state.phase != .restarting
        let flags = Permissions.status()
        status?.stringValue = "Screen Recording: \(flags["screenCapture"] as? Bool == true ? "Allowed" : "Not allowed")     Accessibility: \(flags["accessibility"] as? Bool == true ? "Allowed" : "Not allowed")\nCapture mode: \(mode)\n\(detail)"
    }

    func recoveryFailed(_ message: String) {
        restartFailed = true
        state.failed()
        detail = message
        progress.update(["phase": "error", "ready": false, "error": "helper_recovery_failed"])
        updateLabel()
    }

    private func beginAuthorization() {
        state.begin()
        progress.update(["phase": "checking", "ready": false])
        checkUntil = ProcessInfo.processInfo.systemUptime + 60
        nextCheck = 0
    }

    @objc private func screenPermission() {
        guard Permissions.requestsAllowed else { return }
        persistentProbeAllowed = true
        beginAuthorization()
        _ = CGRequestScreenCaptureAccess()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
        update()
    }

    @objc private func accessibilityPermission() {
        guard Permissions.requestsAllowed else { return }
        beginAuthorization()
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
        update()
    }

    @objc private func selectPersistent() {
        guard Permissions.requestsAllowed else { return }
        persistentProbeAllowed = true
        beginAuthorization()
        update()
    }

    @objc private func checkAgain() {
        if restartFailed {
            detail = "Retrying the control component restart. Rome will stay open."
            updateLabel()
            restart?()
        } else { beginAuthorization(); update() }
    }
    @objc private func applicationActivated() {
        guard window?.isVisible == true, state.phase != .restarting, !restartFailed else { return }
        checkUntil = ProcessInfo.processInfo.systemUptime + 60
        nextCheck = 0
        update()
    }
    @objc private func stopAll() {
        if state.phase == .restarting { cancel?(); return }
        state.cancel()
        progress.update(["phase": "needs_permission", "ready": false, "error": "control_stopped"])
        checkUntil = 0
        detail = "Computer use stopped. Check access again when you want to continue."
        cancel?()
        updateLabel()
    }

    func windowWillClose(_ notification: Notification) {
        state.cancel()
        timer?.invalidate()
        timer = nil
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private let permissions = PermissionWindow()
    private let instanceId = UUID().uuidString
    private let restartGate = PermissionRestartGate()
    private var server: RPCServer?
    private var engine: NativeEngine?
    private var stateDirectory: URL?
    private var stopPoll: DispatchSourceTimer?
    private var workspaceSleepObservers: [NSObjectProtocol] = []
    private var terminationTimer: Timer?
    private var recoveryTimer: Timer?
    private var recoveryChild: Process?
    private var pendingRelaunch: UUID?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let args = CommandLine.arguments
            guard let executable = Bundle.main.executableURL else { throw NativeFailure("executable_identity_unavailable") }
            let executableSha256 = SHA256.hash(data: try Data(contentsOf: executable)).map { String(format: "%02x", $0) }.joined()
            let implementationSha256 = NativeBuildIdentity.implementationSha256
            guard Bundle.main.object(forInfoDictionaryKey: "RomeComputerUseImplementationSHA256") as? String == implementationSha256 else {
                throw NativeFailure("implementation_identity_unavailable")
            }
            #if arch(arm64)
            let architecture = "arm64"
            #else
            let architecture = "x64"
            #endif
            guard NativeBuildIdentity.architecture == architecture else { throw NativeFailure("architecture_identity_mismatch") }
            let statePath: String?
            if let index = args.firstIndex(of: "--state-dir"), args.indices.contains(index + 1) {
                statePath = args[index + 1]
            } else {
                // System Settings can relaunch an app without its Launch Services arguments.
                statePath = UserDefaults.standard.string(forKey: "stateDirectory")
            }
            if let statePath {
                let directory = URL(fileURLWithPath: statePath, isDirectory: true)
                stateDirectory = directory
                let native = try NativeEngine(stateDirectory: directory)
                engine = native
                let progress = permissions.progress
                permissions.cancel = { native.cancelAll() }
                permissions.restart = { [weak self] in self?.restartControlComponent() }
                let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "1"
                let instance = instanceId
                let gate = restartGate
                server = try RPCServer(directory: directory, onDisconnect: { [weak native] peer, sessionId in
                    guard let native else { return }
                    if !peer.isAlive() {
                        native.ownerDisconnected(peer)
                    } else if let sessionId {
                        native.disconnectSession(sessionId, owner: peer)
                    }
                }) { [weak self] request, peer in
                    let id = request["id"] ?? NSNull()
                    do {
                        guard let method = request["method"] as? String else { throw NativeFailure("invalid_method") }
                        let result: [String: Any]
                        if method == "hello" || method == "info" {
                            result = ["protocolVersion": 1, "version": version, "bundleId": "com.rome.computer-use",
                                      "implementationSha256": implementationSha256, "architecture": architecture,
                                      "executableSha256": executableSha256, "activeSessions": native.activeSessionCount,
                                      "permissions": Permissions.status(), "capabilities": native.capabilities,
                                      "instanceId": instance, "permissionRecovery": progress.read(),
                                      "execution": ["busy": native.isBusy], "focus": native.focusDiagnostics,
                                      "pid": ProcessInfo.processInfo.processIdentifier]
                        } else if method == "requestPermissions" || method == "shutdown" {
                            result = try DispatchQueue.main.sync {
                                guard let self else { throw NativeFailure("helper_stopping") }
                                return try self.handle(request)
                            }
                        } else {
                            guard !gate.active || ["cancel", "end", "stop_status", "verify"].contains(method) else {
                                throw NativeFailure("helper_restarting", details: ["terminalCause": "host_stopped"])
                            }
                            guard let params = request["params"] as? [String: Any] else { throw NativeFailure("invalid_params") }
                            // Each connection has a worker. Stop admission may close while the input lane is still busy.
                            result = try native.handle(method, params: params, owner: peer)
                        }
                        return ["id": id, "ok": true, "result": result]
                    } catch let failure as NativeFailure {
                        var details = failure.details
                        if details["effectStatus"] == nil { details["effectStatus"] = "not_dispatched" }
                        return ["id": id, "ok": false, "error": ["code": failure.code, "message": failure.message, "details": details]]
                    } catch {
                        return ["id": id, "ok": false, "error": ["code": "native_error", "message": String(describing: error)]]
                    }
                }
                let workspaceNotifications = NSWorkspace.shared.notificationCenter
                workspaceSleepObservers = [
                    workspaceNotifications.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak native] _ in
                        native?.workspaceSleepChanged(true)
                    },
                    workspaceNotifications.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak native] _ in
                        native?.workspaceSleepChanged(false)
                    }
                ]
                try server?.start()
                UserDefaults.standard.set(directory.path, forKey: "stateDirectory")
                let poll = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "rome.computer-use.focus-poll", qos: .userInitiated))
                poll.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
                // The serial dispatch source coalesces ticks during a slow AX read.
                poll.setEventHandler { [weak native] in native?.pollStops() }
                stopPoll = poll
                poll.resume()
            }
            if args.contains("--permissions") { permissions.show(restarted: args.contains("--permission-recovery-attempt")) }
            #if ROME_COMPUTER_USE_SELF_TEST
            if args.contains("--self-test-permission-recovery") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.restartControlComponent() }
            }
            #endif
        } catch {
            FileHandle.standardError.write(Data("Rome Computer Use: \(error)\n".utf8))
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopPoll?.cancel()
        let workspaceNotifications = NSWorkspace.shared.notificationCenter
        for observer in workspaceSleepObservers { workspaceNotifications.removeObserver(observer) }
        engine?.cancelAll(reason: "host_stopped")
        server?.stop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let engine else { return .terminateNow }
        engine.beginPermissionRecovery()
        if resourcesDrained(engine) { return .terminateNow }
        let deadline = ProcessInfo.processInfo.systemUptime + 6
        terminationTimer = makeTerminationPoll { [weak self] timer in
            MainActor.assumeIsolated {
                guard self?.resourcesDrained(engine) == true || ProcessInfo.processInfo.systemUptime >= deadline else { return }
                timer.invalidate()
                self?.terminationTimer = nil
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    private func resourcesDrained(_ engine: NativeEngine) -> Bool {
        !engine.isBusy && engine.allCapturesStopped && engine.checkpointStopsIfIdle()
    }

    private func restartControlComponent() {
        guard recoveryTimer == nil, pendingRelaunch == nil, let engine, let stateDirectory else {
            permissions.recoveryFailed("The control component cannot restart right now. Check access again.")
            return
        }
        restartGate.close()
        engine.beginPermissionRecovery()
        let until = ProcessInfo.processInfo.systemUptime + 6
        recoveryTimer = makeTerminationPoll { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                if self.resourcesDrained(engine) {
                    timer.invalidate()
                    self.recoveryTimer = nil
                    self.launchReplacement(stateDirectory: stateDirectory)
                } else if ProcessInfo.processInfo.systemUptime >= until {
                    timer.invalidate()
                    self.recoveryTimer = nil
                    self.permissions.recoveryFailed("The control component has not stopped safely. No replacement was started. Check access again.")
                }
            }
        }
    }

    private func launchReplacement(stateDirectory: URL) {
        guard let executable = Bundle.main.executableURL else {
            permissions.recoveryFailed("The signed control component could not be found.")
            return
        }
        let attempt = UUID()
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["--wait-for-helper-exit", String(getpid()), "--state-dir", stateDirectory.path,
                             "--permissions", "--permission-recovery-attempt", attempt.uuidString]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { permissions.recoveryFailed("The control component could not restart. Check access again."); return }
        recoveryChild = process
        pendingRelaunch = attempt
        // The child acknowledges its parent before waiting; only then may this process release the service lock and exit.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self, self.pendingRelaunch == attempt else { return }
                self.pendingRelaunch = nil
                let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard data.count <= 256, receipt?["waiting"] as? Bool == true, process.isRunning else {
                    if process.isRunning { process.terminate() }
                    self.permissions.recoveryFailed("The replacement control component did not become ready to start.")
                    return
                }
                NSApp.terminate(nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.pendingRelaunch == attempt else { return }
            self.pendingRelaunch = nil
            if process.isRunning { process.terminate() }
            self.permissions.recoveryFailed("The replacement control component did not respond. Check access again.")
        }
    }

    private func handle(_ request: [String: Any]) throws -> [String: Any] {
        switch request["method"] as? String {
        case "hello", "info":
            return ["protocolVersion": 1, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "1",
                    "bundleId": "com.rome.computer-use", "permissions": Permissions.status(),
                    "instanceId": instanceId, "permissionRecovery": permissions.progress.read(),
                    "capabilities": ["actions": []], "pid": ProcessInfo.processInfo.processIdentifier]
        case "requestPermissions":
            permissions.show()
            return Permissions.status()
        case "shutdown":
            guard engine?.isBusy != true else { throw NativeFailure("input_busy") }
            engine?.cancelAll()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
            return ["stopping": true]
        default:
            throw NativeFailure("unsupported_method")
        }
    }
}

@main struct ComputerUseMain {
    @MainActor static func main() {
        umask(0o077)
        if CommandLine.arguments.contains("--permission-probe") {
            let result: [String: Any] = ["bundleId": Bundle.main.bundleIdentifier ?? "",
                                        "implementationSha256": NativeBuildIdentity.implementationSha256,
                                        "permissions": Permissions.status()]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data + Data([10]))
            }
            return
        }
        if let index = CommandLine.arguments.firstIndex(of: "--wait-for-helper-exit") {
            let args = CommandLine.arguments
            guard args.indices.contains(index + 1), let parent = pid_t(args[index + 1]), parent > 1, parent == getppid(),
                  let attempt = args.firstIndex(of: "--permission-recovery-attempt"), args.indices.contains(attempt + 1),
                  UUID(uuidString: args[attempt + 1]) != nil else { exit(1) }
            FileHandle.standardOutput.write(Data("{\"waiting\":true}\n".utf8))
            try? FileHandle.standardOutput.close()
            let until = ProcessInfo.processInfo.systemUptime + 10
            while getppid() == parent && ProcessInfo.processInfo.systemUptime < until { usleep(50_000) }
            guard getppid() != parent else { exit(1) }
        }
        if CommandLine.arguments.contains("--install-staged-app") {
            do {
                let result = try NativeInstaller.install(arguments: CommandLine.arguments)
                let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                FileHandle.standardOutput.write(data + Data([10]))
                return
            } catch let failure as NativeFailure {
                FileHandle.standardError.write(Data("\(failure.code): \(failure.message)\n".utf8))
                exit(1)
            } catch {
                FileHandle.standardError.write(Data("install_application_failed\n".utf8))
                exit(1)
            }
        }
        #if ROME_COMPUTER_USE_SELF_TEST
        if let index = CommandLine.arguments.firstIndex(of: "--self-test"),
           CommandLine.arguments.indices.contains(index + 1) {
            do {
                let assertions = try NativeEngine.selfCheck(directory: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
                print("{\"ok\":true,\"assertions\":\(assertions)}")
                return
            } catch {
                FileHandle.standardError.write(Data("Native self-check failed: \(error)\n".utf8))
                exit(1)
            }
        }
        #endif
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = ApplicationDelegate()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

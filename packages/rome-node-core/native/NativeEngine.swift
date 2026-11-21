import AppKit
import CoreGraphics
import ScreenCaptureKit

final class NativeEngine: @unchecked Sendable {
    private let stateLock = NSLock()
    private let lane = NSLock()
    private var busy = false
    private var permissionRecovery = false
    private var workspaceSuspended = false
    private var workspaceEpoch: UInt64 = 0
    private var focusCleanupScheduled = false
    private var ownerWatchers: [PeerIdentity: DispatchSourceProcess] = [:]
    private let stopDirectory: URL
    private let windowControl: NativeWindow

    init(stateDirectory: URL) throws {
        try NativePath.requireSafeDirectory(stateDirectory, privateMode: true, errorCode: "unsafe_state_directory")
        stopDirectory = stateDirectory.appendingPathComponent("native-stops", isDirectory: true)
        if !FileManager.default.fileExists(atPath: stopDirectory.path) {
            try FileManager.default.createDirectory(at: stopDirectory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
        }
        try NativePath.requireSafeDirectory(stopDirectory, privateMode: true, errorCode: "unsafe_stop_directory")
        windowControl = NativeWindow(stopDirectory: stopDirectory)
    }

    var isBusy: Bool { stateLock.lock(); defer { stateLock.unlock() }; return busy }
    var activeSessionCount: Int { windowControl.activeCount }
    var allCapturesStopped: Bool { windowControl.allCapturesStopped }

    func beginPermissionRecovery() {
        stateLock.lock(); permissionRecovery = true; stateLock.unlock()
        cancelAll(reason: "host_stopped")
    }

    private func admissionEpoch() throws -> UInt64 {
        try stateLock.withLock {
            guard !permissionRecovery else { throw NativeFailure("helper_restarting") }
            guard !workspaceSuspended else {
                throw NativeFailure("system_sleep", details: ["terminalCause": "system_sleep"])
            }
            return workspaceEpoch
        }
    }

    private func checkAdmission(_ epoch: UInt64) throws {
        guard try admissionEpoch() == epoch else {
            throw NativeFailure("system_sleep", details: ["terminalCause": "system_sleep"])
        }
    }

    func workspaceSleepChanged(_ sleeping: Bool) {
        let epoch = stateLock.withLock {
            workspaceSuspended = true
            workspaceEpoch &+= 1
            return workspaceEpoch
        }
        cancelAll(reason: "system_sleep")
        if !sleeping {
            stateLock.withLock {
                if workspaceEpoch == epoch { workspaceSuspended = false }
            }
        }
    }

    var capabilities: [String: Any] {
        let actions = Permissions.requestsAllowed ? NativeWindow.actions : []
        return ["actions": actions, "desktop": false, "web": false,
                "windowSelectionRequired": true, "realPointer": false, "atomic": false,
                "screenshots": CGPreflightScreenCaptureAccess(),
                "scopes": ["background": actions],
                "background": NativeWindow.capabilities.merging(["actions": actions,
                    "screenshots": CGPreflightScreenCaptureAccess(), "web": false]) { _, value in value }]
    }

    var focusDiagnostics: [String: Any] {
        let sessions = windowControl.diagnostics
        let pointers = sessions.filter { $0["terminalCause"] is NSNull }.compactMap { $0["virtualPointer"] as? [String: Any] }
        let latest = pointers.max {
            ($0["lastInteractionUptime"] as? Double ?? 0) < ($1["lastInteractionUptime"] as? Double ?? 0)
        }
        var diagnostic: [String: Any] = ["at": Date().timeIntervalSince1970,
            "uptime": ProcessInfo.processInfo.systemUptime, "virtualPointer": latest ?? ["visible": false, "phase": "hidden"],
            "sessions": sessions]
        if let point = CGEvent(source: nil)?.location, point.x.isFinite, point.y.isFinite {
            diagnostic["pointer"] = ["x": Double(point.x), "y": Double(point.y)]
        }
        do {
            let focus = try NativeFocus.state()
            diagnostic["frontPID"] = focus.front
            diagnostic["keyFocusPID"] = focus.key
            diagnostic["console"] = try NativeFocus.consoleState()
        } catch let failure as NativeFailure { diagnostic["error"] = failure.code }
        catch { diagnostic["error"] = "focus_telemetry_unavailable" }
        return diagnostic
    }

    private func withLane<T>(_ operation: () throws -> T) throws -> T {
        guard lane.try() else { throw NativeFailure("input_busy") }
        stateLock.lock(); busy = true; stateLock.unlock()
        defer {
            stateLock.lock(); busy = false; stateLock.unlock()
            lane.unlock()
        }
        return try operation()
    }

    private func stopWindow(_ params: [String: Any], completing: Bool) throws -> [String: Any] {
        guard let id = params["sessionId"] as? String else { throw NativeFailure("invalid_session") }
        let requested = params["reason"] as? String ?? "cancelled"
        let reason = completing ? "completed" :
            (["cancelled", "connection_lost", "host_stopped"].contains(requested) ? requested : "cancelled")
        let stop = try windowControl.stop(id, reason: reason)
        requestFocusCleanup()
        var result = stop.receipt()
        if result["stopConfirmed"] as? Bool == true { return result }
        let deadline = ProcessInfo.processInfo.systemUptime + (completing ? 0.25 : 0)
        var confirmed = false
        repeat {
            // Cancellation closes admission immediately. Only the drained input lane
            // can confirm that cleanup and all submissions for this session have ended.
            if lane.try() {
                confirmed = stop.checkpoint()
                lane.unlock()
                if confirmed { break }
            }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { break }
            usleep(useconds_t(min(0.01, remaining) * 1_000_000))
            requestFocusCleanup()
        } while true
        result = stop.receipt()
        result["stopConfirmed"] = confirmed
        if confirmed { result["localFocusCleanupPending"] = false }
        return result
    }

    private func stopStatus(_ params: [String: Any]) throws -> [String: Any] {
        guard let id = params["sessionId"] as? String else { throw NativeFailure("invalid_session") }
        return try windowControl.stopStatus(id)
    }

    func cancelAll(reason: String = "cancelled") {
        let watchers = stateLock.withLock {
            let current = Array(ownerWatchers.values)
            ownerWatchers.removeAll()
            return current
        }
        for watcher in watchers { watcher.cancel() }
        windowControl.cancelAll(reason: reason)
        requestFocusCleanup()
    }

    func watchOwner(_ owner: PeerIdentity) {
        let source: DispatchSourceProcess? = stateLock.withLock {
            guard ownerWatchers[owner] == nil else { return nil }
            let watcher = DispatchSource.makeProcessSource(
                identifier: owner.pid,
                eventMask: .exit,
                queue: DispatchQueue.global(qos: .userInitiated)
            )
            watcher.setEventHandler { [weak self] in
                self?.ownerDisconnected(owner)
            }
            ownerWatchers[owner] = watcher
            return watcher
        }
        if let source {
            source.resume()
            if !owner.isAlive() { ownerDisconnected(owner) }
        }
    }

    func ownerDisconnected(_ owner: PeerIdentity) {
        let watcher = stateLock.withLock { ownerWatchers.removeValue(forKey: owner) }
        watcher?.cancel()
        if windowControl.stopOwnedBy(owner, reason: "connection_lost") > 0 {
            requestFocusCleanup()
        }
    }

    func disconnectSession(_ sessionId: String, owner: PeerIdentity) {
        if windowControl.stopIfOwned(sessionId, owner: owner, reason: "connection_lost") {
            requestFocusCleanup()
        }
    }

    private func pruneOwnerWatchers() {
        let stale: [DispatchSourceProcess] = stateLock.withLock {
            var removed: [DispatchSourceProcess] = []
            for (owner, watcher) in ownerWatchers where !windowControl.hasActiveSessions(ownedBy: owner) {
                ownerWatchers.removeValue(forKey: owner)
                removed.append(watcher)
            }
            return removed
        }
        for watcher in stale { watcher.cancel() }
    }

    func pollStops() {
        windowControl.poll()
        pruneOwnerWatchers()
        requestFocusCleanup()
        checkpointStopsIfIdle()
    }

    @discardableResult func checkpointStopsIfIdle() -> Bool {
        guard lane.try() else { return false }
        defer { lane.unlock() }
        windowControl.checkpointStops()
        return true
    }

    private func requestFocusCleanup() {
        guard windowControl.needsFocusCleanup else { return }
        stateLock.lock()
        guard !focusCleanupScheduled else { stateLock.unlock(); return }
        focusCleanupScheduled = true
        stateLock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            lane.lock()
            defer { lane.unlock() }
            stateLock.lock(); focusCleanupScheduled = false; stateLock.unlock()
            windowControl.releaseStoppedFocus()
        }
    }

    func handle(_ method: String, params: [String: Any], owner: PeerIdentity? = nil) throws -> [String: Any] {
        guard !["bind", "preempt"].contains(method) || (params["windowRef"] as? String)?.isEmpty == false else {
            throw NativeFailure("window_selection_required", "Select a background window. Global desktop input is disabled.")
        }
        guard Permissions.requestsAllowed else { throw NativeFailure("unsigned_helper") }
        if method == "cancel" || method == "end" { return try stopWindow(params, completing: method == "end") }
        if method == "stop_status" { return try stopStatus(params) }
        return try withLane {
            let epoch = try admissionEpoch()
            switch method {
            case "windows":
                let result = try windowControl.windows(epoch: epoch)
                try checkAdmission(epoch)
                return result
            case "bind", "preempt":
                let result = try windowControl.bind(params, epoch: epoch, checkEpoch: { try checkAdmission(epoch) },
                    preempt: method == "preempt", owner: owner)
                if let owner {
                    watchOwner(owner)
                    if !owner.isAlive() {
                        ownerDisconnected(owner)
                        throw NativeFailure("connection_lost", details: ["terminalCause": "connection_lost"])
                    }
                }
                do { try checkAdmission(epoch) }
                catch {
                    cancelAll(reason: (error as? NativeFailure)?.code == "system_sleep" ? "system_sleep" : "host_stopped")
                    throw error
                }
                return result
            case "observe", "act", "verify", "renew": return try windowControl.handle(method, params: params)
            default: throw NativeFailure("unsupported_method")
            }
        }
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck(directory: URL) throws -> Int {
        var assertions = 0
        func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
            guard value() else { throw NativeFailure("self_check_failed", message) }
            assertions += 1
        }
        let engine = try NativeEngine(stateDirectory: directory)
        for unsafeStop in [false, true] {
            let path = directory.appendingPathComponent("unsafe-permissions-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let changed = unsafeStop ? path.appendingPathComponent("native-stops", isDirectory: true) : path
            if unsafeStop { try FileManager.default.createDirectory(at: changed, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
            guard chmod(changed.path, 0o755) == 0 else { throw NativeFailure("self_check_failed", "Could not prepare unsafe directory permissions.") }
            do {
                _ = try NativeEngine(stateDirectory: path)
                throw NativeFailure("self_check_failed", "An unsafe native directory was admitted.")
            } catch let error as NativeFailure {
                try check(error.code == (unsafeStop ? "unsafe_stop_directory" : "unsafe_state_directory"), "Native state and stop directories must remain private.")
            }
        }
        for unsafeStop in [false, true] {
            let path = directory.appendingPathComponent("unsafe-symlink-" + UUID().uuidString, isDirectory: true)
            if unsafeStop { try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
            let link = unsafeStop ? path.appendingPathComponent("native-stops", isDirectory: true) : path
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: engine.stopDirectory)
            do {
                _ = try NativeEngine(stateDirectory: path)
                throw NativeFailure("self_check_failed", "A symlinked native directory was admitted.")
            } catch let error as NativeFailure {
                try check(error.code == (unsafeStop ? "unsafe_stop_directory" : "unsafe_state_directory"), "Native directories must reject symlink substitutions.")
            }
        }
        for params: [String: Any] in [[:], ["windowRef": NSNull()], ["windowRef": ""]] {
            do {
                _ = try engine.handle("bind", params: params)
                throw NativeFailure("self_check_failed", "An unscoped binding admitted global desktop input.")
            } catch let error as NativeFailure {
                try check(error.code == "window_selection_required", "An unscoped binding must refuse before any permission or input API.")
            }
        }
        try check(engine.activeSessionCount == 0 && !engine.isBusy, "A refused binding must not create a session or occupy the lane.")
        let session = NativeSessionStop(id: UUID().uuidString, directory: engine.stopDirectory)
        session.recordEvent(); session.recordEvent(); session.actionContext("self-check-action")
        try check(session.stop("takeover", diagnostic: ["stage": "self-check"]) == "takeover", "The initial terminal cause must latch.")
        try check(session.stop("cancelled") == "takeover", "Cancellation must not replace takeover.")
        let restarted = NativeSessionStop(id: session.id, directory: engine.stopDirectory)
        try check(restarted.stop("cancelled") == "takeover", "The durable terminal cause must survive reconstruction.")
        let record = try JSONSerialization.jsonObject(with: Data(contentsOf: session.path)) as? [String: Any]
        let diagnostic = record?["diagnostic"] as? [String: Any]
        try check(diagnostic?["stage"] as? String == "self-check" && diagnostic?["eventsPosted"] as? Int == 2
                  && diagnostic?["actionId"] as? String == "self-check-action", "The first durable receipt must retain its dispatch context.")
        var stopInfo = stat()
        try check(lstat(session.path.path, &stopInfo) == 0 && stopInfo.st_uid == getuid()
                  && stopInfo.st_mode & S_IFMT == S_IFREG && stopInfo.st_mode & 0o777 == 0o600, "Terminal receipts must remain private regular files.")
        let group = DispatchGroup()
        let concurrent = NativeSessionStop(id: UUID().uuidString, directory: engine.stopDirectory)
        for index in 0..<32 {
            group.enter()
            DispatchQueue.global().async {
                concurrent.stop(index.isMultiple(of: 2) ? "cancelled" : "takeover")
                group.leave()
            }
        }
        group.wait()
        let accepted = concurrent.terminal
        try check(accepted == "takeover" || accepted == "cancelled", "A concurrent stop must accept one cause.")
        try check(concurrent.stop("unknown") == accepted, "A later unknown outcome must not replace the accepted stop.")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        group.enter()
        DispatchQueue.global().async {
            try? engine.withLane { entered.signal(); release.wait() }
            group.leave()
        }
        entered.wait()
        try check(engine.isBusy, "The native lane must remain busy while a worker runs.")
        do {
            _ = try engine.withLane { true }
            throw NativeFailure("self_check_failed", "A second worker entered the native lane.")
        } catch let error as NativeFailure { try check(error.code == "input_busy", "Concurrent input must be refused.") }
        try check(concurrent.stop("cancelled") == accepted, "The stop path must not wait for the input lane.")
        release.signal(); group.wait()
        try check(!engine.isBusy, "The lane must clear only after worker completion.")
        do {
            try engine.withLane { throw NativeFailure("self-check-worker-error") }
        } catch let error as NativeFailure { try check(error.code == "self-check-worker-error", "Worker failures must preserve their cause.") }
        try check(!engine.isBusy, "A failed worker must release the lane.")

        let awakeEpoch = try engine.admissionEpoch()
        engine.workspaceSleepChanged(true)
        do {
            _ = try engine.admissionEpoch()
            throw NativeFailure("self_check_failed", "Sleep left input admission open.")
        } catch let error as NativeFailure {
            try check(error.code == "system_sleep", "Sleeping must close native admission.")
        }
        engine.workspaceSleepChanged(false)
        let wakeEpoch = try engine.admissionEpoch()
        try check(wakeEpoch != awakeEpoch, "Wake must retire the old window generation.")
        do {
            try engine.checkAdmission(awakeEpoch)
            throw NativeFailure("self_check_failed", "An operation from before sleep returned after wake.")
        } catch let error as NativeFailure {
            try check(error.code == "system_sleep", "Work from an older wake epoch must stay stopped.")
        }
        #if ROME_COMPUTER_USE_UNSIGNED
        try check(!Permissions.requestsAllowed, "Unsigned compile-time builds must never allow live permissions.")
        #endif
        let canonicalTmp = URL(fileURLWithPath: "/private/tmp/rome-cu-canon-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: canonicalTmp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: canonicalTmp) }
        try NativePath.requireSafeDirectory(canonicalTmp, privateMode: true, errorCode: "unsafe_state_directory")
        assertions += 1
        let symlinkedTmp = URL(fileURLWithPath: "/tmp/" + canonicalTmp.lastPathComponent, isDirectory: true)
        do {
            try NativePath.requireSafeDirectory(symlinkedTmp, privateMode: true, errorCode: "unsafe_state_directory")
            throw NativeFailure("self_check_failed", "A symlinked /tmp alias was admitted.")
        } catch let error as NativeFailure {
            try check(error.code == "unsafe_state_directory", "Non-canonical symlink aliases must be rejected.")
        }

        // Verify host-crash cleanup runs independently of a busy input lane and isolates unrelated clients.
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { kill(child.processIdentifier, SIGKILL); child.waitUntilExit() } }
        let childPeer = try PeerIdentity.read(child.processIdentifier)
        let selfPeer = try PeerIdentity.read(getpid())
        let ownedId = try engine.windowControl.selfTestRegisterSession(owner: childPeer, windowID: 901)
        let unrelatedId = try engine.windowControl.selfTestRegisterSession(owner: selfPeer, windowID: 902)
        engine.watchOwner(childPeer)
        let busyEntered = DispatchSemaphore(value: 0)
        let busyRelease = DispatchSemaphore(value: 0)
        group.enter()
        DispatchQueue.global().async {
            try? engine.withLane { busyEntered.signal(); busyRelease.wait() }
            group.leave()
        }
        busyEntered.wait()
        kill(child.processIdentifier, SIGKILL)
        child.waitUntilExit()
        let stopDeadline = ProcessInfo.processInfo.systemUptime + 2.0
        while engine.windowControl.selfTestTerminal(ownedId) == nil && ProcessInfo.processInfo.systemUptime < stopDeadline {
            usleep(10_000)
        }
        try check(engine.windowControl.selfTestTerminal(ownedId) == "connection_lost",
                  "Killing an owning host must latch connection_lost even while the input lane is busy.")
        try check(engine.windowControl.selfTestTerminal(unrelatedId) == nil,
                  "Disconnecting one host must not stop an unrelated host's session.")
        busyRelease.signal()
        group.wait()

        engine.beginPermissionRecovery()
        do {
            _ = try engine.admissionEpoch()
            throw NativeFailure("self_check_failed", "Permission recovery left input admission open.")
        } catch let error as NativeFailure { try check(error.code == "helper_restarting", "Permission recovery must close native admission.") }
        try check(engine.activeSessionCount == 0 && engine.allCapturesStopped,
                  "Permission recovery must terminate old sessions before restart.")
        return assertions + (try WindowAXState.selfCheck()) + (try WindowAXInvalidation.selfCheck())
            + (try WindowEventFactory.selfCheck()) + (try WindowAction.selfCheck()) + (try WindowEventDispatcher.selfCheck())
            + (try NativeWindow.selfCheck(stopDirectory: engine.stopDirectory)) + (try PointerMotion.selfCheck()) + (try VirtualPointer.selfCheck())
            + (try ControlCapture.selfCheck()) + (try PermissionRecoveryState.selfCheck())
    }
    #endif
}

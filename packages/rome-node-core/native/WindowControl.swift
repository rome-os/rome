import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import ScreenCaptureKit

private func transientWindowRead(_ failure: NativeFailure, pid: pid_t) -> Bool {
    failure.code == "window_binding_changed" && failure.details["windowError"] as? Int32 == AXError.cannotComplete.rawValue
        && failure.details["actualWindow"] as? UInt32 == 0 && failure.details["ownerError"] as? Int32 == 0
        && failure.details["actualPID"] as? Int32 == pid
}

private enum WindowFocusDisposition { case allowed, transitioning, takeover, unresolved }

private func windowFocusDisposition(semanticOnly: Bool, pid: pid_t, window: CGWindowID,
                                    front: pid_t, key: pid_t, focusedWindow: CGWindowID?) -> WindowFocusDisposition {
    if front != pid && key != pid { return .allowed }
    if key != pid { return .transitioning }
    guard semanticOnly else { return .takeover }
    guard let focusedWindow, focusedWindow > 0, focusedWindow != window else { return .takeover }
    return front == pid ? .allowed : .transitioning
}

private struct WindowFocusTransition {
    struct StopRequest {
        let reason: String
        let details: [String: Any]
    }

    private var latestSample: TimeInterval = -.infinity
    private var started: TimeInterval?
    private(set) var stopRequest: StopRequest?
    var isTransitioning: Bool { started != nil }

    @discardableResult mutating func latchStop(_ reason: String, details: [String: Any]) -> StopRequest {
        if let stopRequest { return stopRequest }
        let request = StopRequest(reason: reason, details: details)
        stopRequest = request
        return request
    }

    mutating func check(_ sample: WindowFocusDisposition, sampledAt: TimeInterval, checkedAt: TimeInterval,
                        details: [String: Any] = [:]) -> NativeFailure? {
        if stopRequest != nil { return NativeFailure("session_stopped") }
        let code: String, reason: String
        switch record(sample, sampledAt: sampledAt, checkedAt: checkedAt) {
        case .allowed: return nil
        case .transitioning: return NativeFailure("focus_transitioning", details: details)
        case .takeover: code = "target_takeover"; reason = "takeover"
        case .unresolved: code = "focus_transition_unresolved"; reason = "session_unavailable"
        }
        latchStop(reason, details: details.merging(["code": code]) { _, code in code })
        return NativeFailure(code, details: details)
    }

    private mutating func record(_ sample: WindowFocusDisposition, sampledAt: TimeInterval,
                                 checkedAt: TimeInterval) -> WindowFocusDisposition {
        if sample == .takeover { return .takeover }
        // A concurrent AX read can finish after a newer poll has observed a transition.
        if sampledAt >= latestSample {
            latestSample = sampledAt
            started = sample == .allowed ? nil : started ?? sampledAt
        }
        if let started, checkedAt - started >= 0.35 { return .unresolved }
        return started == nil ? sample : .transitioning
    }
}

private struct WindowIdentity: Hashable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executable: String
    let window: CGWindowID

    init(_ binding: ProcessBinding, window: CGWindowID) {
        pid = binding.pid
        startSeconds = binding.startSeconds
        startMicroseconds = binding.startMicroseconds
        executable = binding.executable
        self.window = window
    }

    var storageKey: String {
        let fields = [String(pid), String(startSeconds), String(startMicroseconds), executable, String(window)]
        return SHA256.hash(data: Data(fields.joined(separator: "\0").utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

private struct DirectedCandidate {
    let binding: ProcessBinding
    let window: CGWindowID
    let allowOffscreen: Bool
    var epoch: UInt64 = 0
    let created = ProcessInfo.processInfo.systemUptime
    var identity: WindowIdentity { WindowIdentity(binding, window: window) }
}

private func verifyUnminimizedWindow(_ root: AXUIElement, pid: pid_t) throws {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isHidden, !app.isTerminated else {
        throw NativeFailure("window_application_hidden_or_unavailable")
    }
    AXUIElementSetMessagingTimeout(root, 0.04)
    var raw: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(root, kAXMinimizedAttribute as CFString, &raw)
    guard error == .success, let raw, CFGetTypeID(raw) == CFBooleanGetTypeID(), (raw as? Bool) == false else {
        throw NativeFailure("window_minimized_or_unavailable", details: ["axError": error.rawValue])
    }
}

private struct WindowViewport: Equatable {
    let bounds: CGRect
    let width: Int
    let height: Int
    var sx: CGFloat { CGFloat(width) / bounds.width }
    var sy: CGFloat { CGFloat(height) / bounds.height }
    init(bounds: CGRect, scale: CGFloat) throws {
        guard [bounds.minX, bounds.minY, bounds.width, bounds.height, scale].allSatisfy(\.isFinite),
              bounds.width > 0, bounds.height > 0, bounds.width <= 32768, bounds.height <= 32768, scale > 0, scale <= 8 else {
            throw NativeFailure("invalid_window_geometry")
        }
        let ratio = min(1, min(2048 / (bounds.width * scale), 1536 / (bounds.height * scale)))
        self.bounds = bounds
        width = max(1, Int((bounds.width * scale * ratio).rounded(.up)))
        height = max(1, Int((bounds.height * scale * ratio).rounded(.up)))
    }
    func point(_ x: Double, _ y: Double) throws -> CGPoint {
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(width), y < Double(height) else {
            throw NativeFailure("window_coordinate_out_of_bounds")
        }
        return CGPoint(x: x / Double(sx), y: y / Double(sy))
    }
    func imageFrame(_ frame: CGRect) -> [Double] {
        guard !frame.isNull else { return [] }
        return [Double((frame.minX - bounds.minX) * sx), Double((frame.minY - bounds.minY) * sy),
                Double(frame.width * sx), Double(frame.height * sy)]
    }
    func globalPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y)
    }
    func observationRegion(_ value: Any) throws -> (region: WindowAXRegion, pixels: [String: Any]) {
        guard let raw = value as? [String: Any],
              Set(raw.keys).isSubset(of: ["x", "y", "width", "height", "fromEnd"]) else {
            throw NativeFailure("invalid_observation_region")
        }
        func integer(_ key: String, maximum: Int) throws -> Int {
            guard let number = raw[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue >= 0, number.doubleValue <= Double(maximum),
                  number.doubleValue.rounded() == number.doubleValue else {
                throw NativeFailure("invalid_observation_region")
            }
            return Int(number.doubleValue)
        }
        let x = try integer("x", maximum: width), y = try integer("y", maximum: height)
        let w = try integer("width", maximum: width), h = try integer("height", maximum: height)
        guard w > 0, h > 0, x + w <= width, y + h <= height else { throw NativeFailure("invalid_observation_region") }
        let fromEnd: Bool
        if let raw = raw["fromEnd"] {
            guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw NativeFailure("invalid_observation_region")
            }
            fromEnd = number.boolValue
        } else { fromEnd = false }
        let frame = CGRect(x: bounds.minX + CGFloat(x) / sx, y: bounds.minY + CGFloat(y) / sy,
                           width: CGFloat(w) / sx, height: CGFloat(h) / sy)
        var pixels: [String: Any] = ["x": x, "y": y, "width": w, "height": h]
        if fromEnd { pixels["fromEnd"] = true }
        return (WindowAXRegion(bounds: frame, pixels: CGRect(x: x, y: y, width: w, height: h), fromEnd: fromEnd), pixels)
    }
    var metadata: [String: Any] {
        ["coordinateSpace": "window_image_pixels", "width": width, "height": height,
         "scaleX": Double(sx), "scaleY": Double(sy),
         "windowBounds": [bounds.minX, bounds.minY, bounds.width, bounds.height].map(Double.init)]
    }
}

private final class DirectedAction {
    let kind: String
    let node: WindowAXNode?
    let expectation: [String: String]?
    let value: String?
    var method: String
    var range: CFRange?
    var events = 0
    var operations = 0
    var proof: [String: Any] = [:]
    init(kind: String, node: WindowAXNode?, raw: [String: Any], expectation: [String: String]?) {
        self.kind = kind; self.node = node; self.expectation = expectation; value = raw["value"] as? String
        switch kind {
        case "setValue": method = "ax_set_value"
        case "selectText": method = "ax_select_text"
        case "press": method = "ax_press"
        case "performAction": method = "ax_perform_action"
        default: method = "window_pid_events"
        }
    }
    var dispatched: Bool { events > 0 || operations > 0 }
}

private struct WindowLease {
    static let idleTimeoutMs = 30_000
    static let renewAfterMs = 10_000
    static let maximumLifetimeSeconds: Int64 = 600
    private let maximumEnd: ContinuousClock.Instant
    private(set) var end: ContinuousClock.Instant

    init(started: ContinuousClock.Instant) {
        maximumEnd = started.advanced(by: .seconds(Self.maximumLifetimeSeconds))
        end = started.advanced(by: .milliseconds(Self.idleTimeoutMs))
    }

    mutating func extend(at now: ContinuousClock.Instant) {
        end = min(maximumEnd, now.advanced(by: .milliseconds(Self.idleTimeoutMs)))
    }

    func metadata(at now: ContinuousClock.Instant) -> [String: Int] {
        let remaining = now.duration(to: end).components
        let milliseconds = remaining.seconds * 1_000 + remaining.attoseconds / 1_000_000_000_000_000
        return ["idleTimeoutMs": Self.idleTimeoutMs, "renewAfterMs": Self.renewAfterMs,
                "remainingMs": Int(max(0, milliseconds))]
    }
}

private final class DirectedSession: @unchecked Sendable {
    private struct AdmissionStopped: Error {
        let reason: String
        let code: String
    }

    let state: NativeSessionStop
    let owner: PeerIdentity?
    let pointer = VirtualPointer()
    let binding: ProcessBinding
    let window: CGWindowID
    let windowIdentity: WindowIdentity
    private let targetIdentity: String
    let preemptToken = "preempt-" + UUID().uuidString.lowercased()
    let root: AXUIElement
    let semanticOnly: Bool
    let foregroundNavigationFallback: Bool
    private var activatingFrom: pid_t?
    private var activationStarted = 0.0
    private var foregroundConfirmed = false
    private var confirmedAt = 0.0
    var usingForeground: Bool { lock.withLock { foregroundConfirmed } }
    let allowOffscreen: Bool
    let deadline = Date().timeIntervalSince1970 + 600
    let until = ProcessInfo.processInfo.systemUptime + 600
    let marker = Int64.random(in: 1...Int64.max)
    private let lock = NSLock()
    private var capture: ControlCapture?
    private var screenshotsInFlight = 0
    private var invalidation: WindowAXInvalidation?
    private var focusHeld = false
    private var stopApplied = false
    private var inputStopUnconfirmed = false
    private var focusCleanup: [String: Any] = [:]
    private var focusTransition = WindowFocusTransition()
    private var lease: WindowLease?
    // Only NativeEngine's lane accesses AX state, observations and actions.
    let ax = WindowAXState()
    var stopCheckpointed = false
    var snapshot: WindowAXSnapshot?
    var lastObservationUsedForeground = false
    var viewport: WindowViewport
    var observationID: String?
    var observedAt = 0.0
    var observedUptime = 0.0
    var consumed = true
    var actions: [String: DirectedAction] = [:]

    init(id: String, candidate: DirectedCandidate, root: AXUIElement, viewport: WindowViewport, directory: URL,
         semanticOnly: Bool, foregroundNavigationFallback: Bool = false, leased: Bool = false,
         owner: PeerIdentity? = nil, started: ContinuousClock.Instant = .now) {
        state = NativeSessionStop(id: id, directory: directory)
        self.owner = owner
        binding = candidate.binding; window = candidate.window; self.root = root; self.viewport = viewport; self.semanticOnly = semanticOnly
        self.foregroundNavigationFallback = foregroundNavigationFallback && !semanticOnly && !candidate.allowOffscreen
        allowOffscreen = candidate.allowOffscreen
        let identity = candidate.identity
        windowIdentity = identity
        targetIdentity = identity.storageKey
        lease = leased ? WindowLease(started: started) : nil
    }
    func indicateRead() {
        guard !allowOffscreen else { return }
        pointer.indicateRead(sessionID: state.id, pid: binding.pid, windowID: window,
                             bounds: viewport.bounds, active: { [state] in state.terminal == nil })
    }

    func attach(_ value: ControlCapture) throws {
        lock.lock(); defer { lock.unlock() }
        guard focusTransition.stopRequest == nil else { value.stop(); throw NativeFailure("session_stopped") }
        capture = value
    }
    var captureDiagnostics: [String: Any] { lock.lock(); let value = capture; lock.unlock(); return value?.diagnostics ?? [:] }
    var capturesStopped: Bool {
        let (capture, screenshots) = lock.withLock { (self.capture, screenshotsInFlight) }
        return screenshots == 0 && (capture == nil || capture?.diagnostics["stopConfirmed"] as? Bool == true)
    }
    func beginScreenshot() throws {
        try alive(requireSettledFocus: true) { screenshotsInFlight += 1 }
    }
    func finishScreenshot() {
        lock.withLock { screenshotsInFlight -= 1 }
    }
    // Check only in the native lane, after the last in-flight input worker has left.
    var stopConfirmed: Bool {
        state.terminal != nil && lock.withLock { stopApplied && !focusHeld && !inputStopUnconfirmed } && capturesStopped
    }
    func markInputStopUnconfirmed() {
        lock.withLock { inputStopUnconfirmed = true }
    }
    var observer: WindowAXInvalidation? { lock.lock(); defer { lock.unlock() }; return invalidation }
    var localFocusHeld: Bool { lock.lock(); defer { lock.unlock() }; return focusHeld }
    func localFocus(_ held: Bool, cleanup: [String: Any] = [:]) {
        lock.lock(); focusHeld = held; focusCleanup = cleanup; lock.unlock()
    }
    var localFocusDiagnostics: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["held": focusHeld, "cleanup": focusCleanup]
    }
    func attach(_ value: WindowAXInvalidation) throws {
        lock.lock(); defer { lock.unlock() }
        guard focusTransition.stopRequest == nil else { value.stop(); throw NativeFailure("session_stopped") }
        invalidation = value
    }
    @discardableResult func invalidateDestroyed() throws -> Bool {
        guard let observer else { return false }
        guard !observer.requiresFullInvalidation else {
            ax.invalidate()
            throw NativeFailure("window_ax_invalidation_overflow", details: ["terminalCause": stop("invalidated")])
        }
        let destroyed = observer.drain()
        ax.retire(destroyed)
        return !destroyed.isEmpty
    }
    @discardableResult func stop(_ reason: String, details: [String: Any] = [:]) -> String {
        let (request, value, invalidation) = lock.withLock {
            (focusTransition.latchStop(reason, details: details), capture, self.invalidation)
        }
        let cause = state.stop(request.reason, diagnostic: request.details)
        pointer.hide(sessionID: state.id)
        value?.stop(); invalidation?.stop()
        lock.withLock { stopApplied = true }
        return cause
    }
    func closeAdmission(_ reason: String) {
        lock.withLock { _ = focusTransition.latchStop(reason, details: [:]) }
    }
    func stopReceipt(cause: String) -> [String: Any] {
        ["sessionId": state.id, "scope": "background", "status": cause, "terminalCause": cause,
         "effectVerified": false, "replayAllowed": false, "eventsPosted": state.eventsPosted,
         "localFocusCleanupPending": localFocusHeld]
    }
    private func admitted<T>(requireSettledFocus: Bool, _ admit: (ContinuousClock.Instant) throws -> T) throws -> T {
        do {
            return try lock.withLock {
                if let request = focusTransition.stopRequest {
                    throw AdmissionStopped(reason: request.reason, code: "session_stopped")
                }
                let now = ContinuousClock.now
                if ProcessInfo.processInfo.systemUptime >= until || (lease.map { now >= $0.end } ?? false) {
                    focusTransition.latchStop("expired", details: [:])
                    throw AdmissionStopped(reason: "expired", code: "session_expired")
                }
                if requireSettledFocus && focusTransition.isTransitioning { throw NativeFailure("focus_transitioning") }
                return try admit(now)
            }
        } catch let stopping as AdmissionStopped {
            throw NativeFailure(stopping.code, details: ["terminalCause": stop(stopping.reason)])
        }
    }
    func alive(requireSettledFocus: Bool = false, admit: () throws -> Void = {}) throws {
        try admitted(requireSettledFocus: requireSettledFocus) { _ in try admit() }
    }
    func leaseReceipt(renew: Bool = false) throws -> [String: Int] {
        // Expiry and renewal share admission's lock and the same continuous clock sample.
        try admitted(requireSettledFocus: true) { now in
            guard var current = lease else { throw NativeFailure("window_lease_not_enabled") }
            if renew {
                current.extend(at: now)
                lease = current
            }
            return current.metadata(at: now)
        }
    }
    func activateForNavigation(from originalFront: pid_t) throws {
        try checkFocus()
        guard foregroundNavigationFallback, !localFocusHeld,
              let app = NSRunningApplication(processIdentifier: binding.pid),
              try AXSnapshotReader.focusedWindow(pid: binding.pid) == window,
              try identity() == viewport.bounds else { throw NativeFailure("foreground_window_unavailable") }
        let previous = try NativeFocus.state()
        guard previous.front == originalFront, previous.key == originalFront, previous.front != binding.pid else { throw NativeFailure("focus_transitioning") }
        try alive(requireSettledFocus: true) {
            activatingFrom = previous.front
            activationStarted = ProcessInfo.processInfo.systemUptime
            guard app.activate(options: []) else {
                throw NativeFailure("window_activation_failed")
            }
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.9
        repeat {
            do { try checkFocus(); if usingForeground { return } }
            catch let failure as NativeFailure where failure.code == "focus_transitioning" {}
            usleep(10_000)
        } while ProcessInfo.processInfo.systemUptime < deadline
        throw NativeFailure("window_activation_unconfirmed")
    }
    func checkFocus() throws {
        try alive()
        do {
            let sampledAt = ProcessInfo.processInfo.systemUptime
            let mayOwnForeground = lock.withLock { activatingFrom != nil }
            let focus = try NativeFocus.state()
            let details = ["frontPID": focus.front, "keyPID": focus.key]
            let focused: CGWindowID?
            do {
                focused = (semanticOnly || mayOwnForeground) && focus.key == binding.pid
                    ? try AXSnapshotReader.focusedWindow(pid: binding.pid) : nil
            } catch let failure as NativeFailure {
                let diagnostic = failure.details.merging(["stage": "focused_window_proof", "frontPID": focus.front, "keyPID": focus.key]) { current, _ in current }
                throw NativeFailure(failure.code, failure.message, details: diagnostic)
            }
            let sample = windowFocusDisposition(semanticOnly: semanticOnly, pid: binding.pid, window: window,
                                               front: focus.front, key: focus.key, focusedWindow: focused)
            // Publish a stop before an older read can pass the same lock.
            if let failure = lock.withLock({
                if let from = activatingFrom {
                    if !mayOwnForeground || sampledAt < activationStarted { return NativeFailure("focus_transitioning") }
                    if foregroundConfirmed && sampledAt < confirmedAt { return NativeFailure("focus_transitioning") }
                    if focus.front == binding.pid && focus.key == binding.pid && focused == window {
                        if !foregroundConfirmed { confirmedAt = sampledAt }
                        foregroundConfirmed = true
                        return focusTransition.check(.allowed, sampledAt: sampledAt, checkedAt: ProcessInfo.processInfo.systemUptime, details: details)
                    }
                    if !foregroundConfirmed && sampledAt - activationStarted < 0.9 &&
                        [from, binding.pid].contains(focus.front) && [from, binding.pid].contains(focus.key) {
                        return NativeFailure("focus_transitioning", details: details)
                    }
                    return focusTransition.check(.takeover, sampledAt: sampledAt, checkedAt: ProcessInfo.processInfo.systemUptime, details: details)
                }
                return focusTransition.check(sample, sampledAt: sampledAt,
                                      checkedAt: ProcessInfo.processInfo.systemUptime, details: details)
            }) {
                if failure.code == "focus_transitioning" { try alive() }
                throw failure
            }
        } catch let failure as NativeFailure where failure.code != "focus_transitioning" {
            let diagnostic = failure.details.merging(["code": failure.code]) { _, code in code }
            let cause = stop(failure.code == "target_takeover" ? "takeover" : "session_unavailable", details: diagnostic)
            throw NativeFailure(failure.code, failure.message, details: failure.details.merging(["terminalCause": cause]) { _, b in b })
        }
        try alive(requireSettledFocus: true)
    }
    func geometry() throws -> CGRect {
        do {
            try binding.verify()
            let values = try AXSnapshotReader.cgBounds(pid: binding.pid, window: window, allowOffscreen: allowOffscreen)
            if allowOffscreen { try verifyUnminimizedWindow(root, pid: binding.pid) }
            return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        } catch let failure as NativeFailure {
            let cause = stop("invalidated", details: ["code": failure.code])
            throw NativeFailure(failure.code, failure.message, details: failure.details.merging(["terminalCause": cause]) { _, b in b })
        }
    }
    func identity() throws -> CGRect {
        let bounds = try geometry()
        for attempt in 0..<3 {
            try alive()
            AXUIElementSetMessagingTimeout(root, 0.04)
            do {
                try AXSnapshotReader.verifyExactWindow(root, pid: binding.pid, window: window)
                guard try geometry() == bounds else { throw NativeFailure("window_geometry_changed") }
                return bounds
            } catch let failure as NativeFailure {
                let unavailable = transientWindowRead(failure, pid: binding.pid)
                if unavailable && attempt < 2 { usleep(5_000); continue }
                if failure.code == "window_binding_changed" && !unavailable { stop("invalidated", details: failure.details) }
                throw failure
            }
        }
        throw NativeFailure("window_identity_unavailable")
    }
    var diagnostics: [String: Any] {
        ["sessionId": state.id, "scope": "background", "targetPID": binding.pid, "targetWindowId": window, "targetIdentity": targetIdentity,
         "terminalCause": state.terminal as Any? ?? NSNull(), "eventsPosted": state.eventsPosted,
         "firstStop": state.terminalDiagnostic, "controlCapture": captureDiagnostics, "virtualPointer": pointer.diagnostics,
         "localFocus": localFocusDiagnostics, "inputIsolation": semanticOnly ? "window_semantics" : "background_application",
         "axInvalidation": observer?.diagnostics ?? ["available": false]]
    }
}

// Explicit window bindings share one input lane across Node and Electron callers.
final class NativeWindow: @unchecked Sendable {
    static let actions = ["move", "click", "drag", "scroll", "key", "type", "press", "setValue", "selectText", "performAction"]
    private static let semanticActions = ["click", "press", "setValue", "selectText"]
    private static let foregroundPointerActions = ["move", "click", "scroll"]
    // A live hit can be deeper than the observation even when its enclosing control is in the tree.
    private static let receiverAncestorLimit = 64
    private let directory: URL
    private let occupancy: NativeWindowOccupancy
    private let lock = NSLock()
    private var sessions: [String: DirectedSession] = [:]
    private var lastSessionByWindow: [WindowIdentity: String] = [:]
    private var stoppedReceipts: [String: [String: Any]] = [:]
    private var stoppedReceiptOrder: [String] = []
    private var candidates: [String: DirectedCandidate] = [:]
    // Only the native lane reads or changes app-local focus ownership.
    private var focusOwners: [pid_t: DirectedSession] = [:]

    init(stopDirectory: URL) {
        directory = stopDirectory
        occupancy = NativeWindowOccupancy(directory: stopDirectory)
    }
    static var capabilities: [String: Any] {
        ["actions": actions, "coordinateSpace": "window_image_pixels", "realPointer": false,
         "windowSelectionRequired": true, "partialObservations": true, "observationRegion": true, "maxValueLength": 16384,
         "foregroundNavigationFallback": true, "sessionEnd": true, "windowLease": true, "windowPreemption": true, "sessionRecovery": true,
         "durableWindowOccupancy": true,
         "maxTextLength": 4096, "verification": "independent_ax_postcondition", "atomic": false,
         "transport": "ax_and_window_directed_events", "requiresBackgroundApplication": true,
         "foregroundApplicationActions": semanticActions]
    }
    private static func capabilities(semanticOnly: Bool) -> [String: Any] {
        capabilities.merging(semanticOnly ? ["foregroundNavigationFallback": false, "actions": semanticActions, "transport": "ax_only",
            "requiresBackgroundApplication": false, "requiresBackgroundWindow": true, "inputIsolation": "window_semantics"]
            : ["inputIsolation": "background_application"]) { _, value in value }
    }
    private var current: [DirectedSession] { lock.lock(); defer { lock.unlock() }; return Array(sessions.values) }
    var activeCount: Int { current.filter { $0.state.terminal == nil }.count }
    var needsFocusCleanup: Bool { current.contains { $0.state.terminal != nil && $0.localFocusHeld } }
    var allCapturesStopped: Bool {
        current.allSatisfy { $0.capturesStopped && ($0.state.terminal == nil || !$0.localFocusHeld) }
    }
    var diagnostics: [[String: Any]] { current.map(\.diagnostics) }
    func contains(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return sessions[id] != nil }
    private func session(_ params: [String: Any]) throws -> DirectedSession {
        guard let id = params["sessionId"] as? String else { throw NativeFailure("invalid_session") }
        lock.lock(); let value = sessions[id]; lock.unlock()
        guard let value else { throw NativeFailure("session_not_found") }
        return value
    }
    func stop(_ id: String, reason: String) throws -> (receipt: () -> [String: Any], checkpoint: () -> Bool) {
        let (value, cached) = lock.withLock { (sessions[id], stoppedReceipts[id]) }
        guard let value else {
            if let receipt = try cached ?? occupancy.confirmation(id)?.confirmedReceipt { return ({ receipt }, { true }) }
            throw NativeFailure("session_not_found")
        }
        let cause = value.stop(reason)
        return ({ value.stopReceipt(cause: cause) }, { [self] in checkpoint(value) })
    }
    func stopStatus(_ id: String) throws -> [String: Any] {
        let (value, cached) = lock.withLock { (sessions[id], stoppedReceipts[id]) }
        if let cached { return cached }
        guard let value else {
            if let history = try occupancy.history(id) { return history }
            throw NativeFailure("session_not_found")
        }
        if let receipt = try occupancy.confirmation(id)?.confirmedReceipt { return receipt }
        guard let cause = value.state.terminal else {
            return ["sessionId": id, "status": "active", "stopConfirmed": false]
        }
        var result = value.stopReceipt(cause: cause)
        result["stopConfirmed"] = false
        return result
    }
    // Called within the input lane, after the pending worker and cleanup have stopped.
    private func checkpoint(_ value: DirectedSession) -> Bool {
        if value.stopCheckpointed { return true }
        guard let cause = value.state.terminal, value.stopConfirmed else { return false }
        do {
            try occupancy.confirm(value.windowIdentity.storageKey, sessionId: value.state.id, cause: cause)
            value.stopCheckpointed = true
        } catch { return false }
        return true
    }
    func checkpointStops() {
        for value in current where !value.stopCheckpointed && value.state.terminal != nil {
            _ = checkpoint(value)
        }
    }
    func cancelAll(reason: String) {
        let values = current
        for value in values { value.closeAdmission(reason) }
        for value in values { value.stop(reason) }
    }
    @discardableResult func stopOwnedBy(_ owner: PeerIdentity, reason: String) -> Int {
        let matching = current.filter { $0.owner == owner && $0.state.terminal == nil }
        for value in matching { value.closeAdmission(reason) }
        for value in matching { value.stop(reason) }
        return matching.count
    }
    @discardableResult func stopIfOwned(_ id: String, owner: PeerIdentity, reason: String) -> Bool {
        let value = lock.withLock { sessions[id] }
        guard let value, value.owner == owner, value.state.terminal == nil else { return false }
        value.closeAdmission(reason)
        value.stop(reason)
        return true
    }
    func hasActiveSessions(ownedBy owner: PeerIdentity) -> Bool {
        current.contains { $0.owner == owner && $0.state.terminal == nil }
    }
    func poll() {
        for value in current where value.state.terminal == nil {
            if let owner = value.owner, !owner.isAlive() {
                value.closeAdmission("connection_lost")
                value.stop("connection_lost")
                continue
            }
            try? value.checkFocus()
        }
    }

    // Cancellation latches first. Its app-local cleanup runs after the current input worker leaves the lane.
    func releaseStoppedFocus(sessionID: String? = nil) {
        for value in Array(focusOwners.values) where value.state.terminal != nil {
            if let sessionID, value.state.id != sessionID { continue }
            var diagnostic: [String: Any] = ["eventsPosted": 0]
            do {
                try value.binding.verify()
                let focus = try NativeFocus.state()
                if focus.front == value.binding.pid || focus.key == value.binding.pid {
                    diagnostic["skipped"] = "user_owns_target_focus"
                } else {
                    let factory = try WindowEventFactory(target: WindowInputTarget(pid: value.binding.pid,
                        windowID: value.window, bounds: value.viewport.bounds), marker: value.marker)
                    var count = 0
                    for event in try factory.localFocus(active: false) {
                        try value.binding.verify()
                        try factory.post(event, check: {}, posted: { count += 1; value.state.recordEvent() }, cleanup: true)
                    }
                    diagnostic = ["eventsPosted": count, "status": "posted_unverified"]
                }
            } catch let failure as NativeFailure { diagnostic["skipped"] = failure.code }
            catch { diagnostic["skipped"] = "local_focus_cleanup_unavailable" }
            if let skipped = diagnostic["skipped"] as? String,
               skipped != "user_owns_target_focus", skipped != "process_identity_changed" {
                value.markInputStopUnconfirmed()
            }
            value.localFocus(false, cleanup: diagnostic)
            focusOwners.removeValue(forKey: value.binding.pid)
        }
    }

    private enum OnScreenAXResolution {
        case exact(Set<CGWindowID>)
        case transientFailure
        case unavailable
    }

    private func resolveOnScreenAXWindows(pid: pid_t, deadline: TimeInterval) -> OnScreenAXResolution {
        let initialRemaining = deadline - ProcessInfo.processInfo.systemUptime
        guard initialRemaining > 0 else { return .transientFailure }
        do {
            let roots = try readWindowRoots(pid: pid, allowOffscreen: false, timeout: Float(min(0.08, initialRemaining)))
            var mapped: [CGWindowID] = []
            mapped.reserveCapacity(roots.count)
            for root in roots {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { return .transientFailure }
                AXUIElementSetMessagingTimeout(root, Float(min(0.04, remaining)))
                do {
                    mapped.append(try AXSnapshotReader.verifyExactWindow(root, pid: pid))
                } catch let failure as NativeFailure {
                    if failure.details["windowError"] as? Int32 == AXError.cannotComplete.rawValue ||
                       failure.details["ownerError"] as? Int32 == AXError.cannotComplete.rawValue {
                        return .transientFailure
                    }
                } catch {}
            }
            let unique = Set(Dictionary(grouping: mapped, by: { $0 }).compactMap { $0.value.count == 1 ? $0.key : nil })
            return .exact(unique)
        } catch let failure as NativeFailure {
            if failure.details["axError"] as? Int32 == AXError.cannotComplete.rawValue {
                return .transientFailure
            }
            return .unavailable
        } catch {
            return .unavailable
        }
    }

    func windows(epoch: UInt64) throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw NativeFailure("accessibility_permission_required") }
        _ = try NativeFocus.consoleState()
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] else {
            throw NativeFailure("window_list_unavailable")
        }
        let now = ProcessInfo.processInfo.systemUptime
        candidates = candidates.filter { $0.value.epoch == epoch && now - $0.value.created <= 15 }
        guard candidates.count < 896 else { throw NativeFailure("window_reference_limit") }
        var result: [[String: Any]] = []
        func add(_ row: [String: Any], binding: ProcessBinding, window: CGWindowID, frame: [Double], allowOffscreen: Bool) {
            let ref = UUID().uuidString.lowercased()
            candidates[ref] = DirectedCandidate(binding: binding, window: window, allowOffscreen: allowOffscreen, epoch: epoch)
            // The host publishes negotiated bind options. An older host can pass these rows through.
            var windowCapabilities = Self.capabilities(semanticOnly: allowOffscreen)
            windowCapabilities.removeValue(forKey: "foregroundNavigationFallback")
            let app = NSRunningApplication(processIdentifier: binding.pid)
            let bundleName = app?.bundleURL?.deletingPathExtension().lastPathComponent ?? ""
            var item: [String: Any] = [
                "windowRef": ref, "title": row[kCGWindowName as String] as? String ?? "",
                "appName": app?.localizedName ?? "",
                "bundleId": binding.bundleId, "frame": frame, "capabilities": windowCapabilities,
            ]
            if !bundleName.isEmpty { item["bundleName"] = bundleName }
            result.append(item)
        }
        var axWindowsByPID: [pid_t: OnScreenAXResolution] = [:]
        let onScreenDeadline = ProcessInfo.processInfo.systemUptime + 0.5
        for row in rows {
            guard result.count < 128,
                  (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != getpid(),
                  let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let frame = try? AXSnapshotReader.onScreenBounds(row),
                  let binding = try? ProcessBinding.read(pid) else { continue }
            let resolution: OnScreenAXResolution
            if let cached = axWindowsByPID[pid] {
                resolution = cached
            } else if ProcessInfo.processInfo.systemUptime < onScreenDeadline {
                resolution = resolveOnScreenAXWindows(pid: pid, deadline: onScreenDeadline)
                axWindowsByPID[pid] = resolution
            } else {
                resolution = .transientFailure
            }
            switch resolution {
            case .exact(let ids): guard ids.contains(number) else { continue }
            case .unavailable: continue
            case .transientFailure: break
            }
            add(row, binding: binding, window: number, frame: frame, allowOffscreen: false)
        }
        if result.count < 128 {
            let onScreenIDs = Set(rows.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
            for (row, binding, window, frame) in offscreenWindows(excluding: onScreenIDs, limit: 128 - result.count) {
                add(row, binding: binding, window: window, frame: frame, allowOffscreen: true)
            }
        }
        return ["windows": result]
    }

    private func offscreenWindows(excluding onScreenIDs: Set<CGWindowID>, limit: Int)
        -> [([String: Any], ProcessBinding, CGWindowID, [Double])] {
        guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], 0) as? [[String: Any]] else { return [] }
        var byOwner: [pid_t: [CGWindowID: [String: Any]]] = [:]
        for row in rows {
            guard (row[kCGWindowIsOnscreen as String] as? Bool) != true,
                  (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != getpid(),
                  let window = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, !onScreenIDs.contains(window) else { continue }
            byOwner[pid, default: [:]][window] = row
        }
        var found: [([String: Any], ProcessBinding, CGWindowID, [Double])] = []
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        for app in NSWorkspace.shared.runningApplications {
            guard found.count < limit, ProcessInfo.processInfo.systemUptime < deadline else { break }
            let pid = app.processIdentifier
            guard let rows = byOwner[pid], !app.isHidden, app.activationPolicy != .prohibited,
                  let binding = try? ProcessBinding.read(pid),
                  let roots = try? readWindowRoots(pid: pid, allowOffscreen: true) else { continue }
            let mapped = roots.compactMap { root in
                (try? AXSnapshotReader.verifyExactWindow(root, pid: pid)).map { ($0, root) }
            }
            for (id, matches) in Dictionary(grouping: mapped, by: { $0.0 }) {
                guard found.count < limit, ProcessInfo.processInfo.systemUptime < deadline else { break }
                guard let row = rows[id], matches.count == 1,
                      (try? verifyUnminimizedWindow(matches[0].1, pid: pid)) != nil,
                      let frame = try? AXSnapshotReader.cgBounds(pid: pid, window: id, allowOffscreen: true) else { continue }
                found.append((row, binding, id, frame))
            }
        }
        return found
    }

    private func root(_ candidate: DirectedCandidate) throws -> AXUIElement {
        let roots = try AXSnapshotReader.retryUnavailableRead("window_ax_root_unavailable") {
            try candidate.binding.verify()
            return try readWindowRoots(pid: candidate.binding.pid, allowOffscreen: candidate.allowOffscreen)
        }
        let matches = roots.filter { (try? AXSnapshotReader.verifyExactWindow($0, pid: candidate.binding.pid, window: candidate.window)) != nil }
        guard matches.count == 1 else { throw NativeFailure("window_ax_root_ambiguous") }
        if candidate.allowOffscreen { try verifyUnminimizedWindow(matches[0], pid: candidate.binding.pid) }
        return matches[0]
    }

    private func readWindowRoots(pid: pid_t, allowOffscreen: Bool, timeout: Float = 0.08) throws -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        if allowOffscreen {
            // Some apps return an empty AXWindows list in another Space while retaining their main window.
            AXUIElementSetMessagingTimeout(app, 0.04)
            let names = [kAXWindowsAttribute, kAXMainWindowAttribute, kAXFocusedWindowAttribute]
            var raw: CFArray?
            let error = AXUIElementCopyMultipleAttributeValues(app, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
            guard error == .success, let values = raw as? [CFTypeRef], values.count == names.count else {
                throw NativeFailure("window_ax_root_unavailable", details: ["stage": "offscreen_window_roots", "axError": error.rawValue])
            }
            let listed = values[0] as? [CFTypeRef] ?? []
            guard listed.count <= 128 else { throw NativeFailure("window_ax_root_unavailable") }
            var roots: [AXUIElement] = []
            for value in listed + Array(values.dropFirst()) where CFGetTypeID(value) == AXUIElementGetTypeID() {
                let root = value as! AXUIElement
                if !roots.contains(where: { CFEqual($0, root) }) { roots.append(root) }
            }
            return roots
        }
        AXUIElementSetMessagingTimeout(app, max(0.005, timeout))
        var count: CFIndex = 0, raw: CFArray?
        let countError = AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count)
        guard countError == .success, count > 0, count <= 128 else {
            throw NativeFailure("window_ax_root_unavailable", details: ["stage": "window_count", "axError": countError.rawValue])
        }
        let listError = AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &raw)
        guard listError == .success, let values = raw as? [CFTypeRef], values.count == count,
              values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
            throw NativeFailure("window_ax_root_unavailable", details: ["stage": "window_roots", "axError": listError.rawValue])
        }
        return values.map { $0 as! AXUIElement }
    }

    private func shareable(_ binding: ProcessBinding, _ id: CGWindowID, allowOffscreen: Bool) throws -> SCWindow {
        guard CGPreflightScreenCaptureAccess() else { throw NativeFailure("screen_capture_permission_required") }
        let ready = DispatchSemaphore(value: 0)
        var content: SCShareableContent?, failure: Error?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: !allowOffscreen) { found, error in
            content = found; failure = error; ready.signal()
        }
        guard ready.wait(timeout: .now() + 3) == .success, failure == nil,
              let window = content?.windows.first(where: { $0.windowID == id && $0.windowLayer == 0 && (allowOffscreen || $0.isOnScreen)
                  && $0.owningApplication?.processID == binding.pid && $0.owningApplication?.bundleIdentifier == binding.bundleId }) else {
            throw NativeFailure("screen_capture_window_unavailable")
        }
        try binding.verify()
        return window
    }

    private func lastSession(_ candidate: DirectedCandidate) -> DirectedSession? {
        lock.withLock {
            lastSessionByWindow[candidate.identity].flatMap { sessions[$0] }
        }
    }
    private func store(_ value: DirectedSession) {
        lock.withLock {
            sessions[value.state.id] = value
            lastSessionByWindow[value.windowIdentity] = value.state.id
        }
    }
    private func windowOccupant(_ candidate: DirectedCandidate) -> DirectedSession? {
        guard let value = lastSession(candidate), !checkpoint(value) else { return nil }
        return value
    }
    private func preemptionTarget(_ candidate: DirectedCandidate, token: String) throws -> DirectedSession {
        guard let value = lastSession(candidate), value.preemptToken == token else { throw NativeFailure("stale_preemption") }
        return value
    }
    private func preempt(_ value: DirectedSession, wait: TimeInterval = 0.25) throws -> [String: Any] {
        let id = value.state.id, cause = value.stop("preempted")
        releaseStoppedFocus(sessionID: id)
        let deadline = ProcessInfo.processInfo.systemUptime + wait
        repeat {
            if checkpoint(value) {
                return ["terminalCause": cause, "stopConfirmed": true]
            }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { break }
            usleep(useconds_t(min(0.01, remaining) * 1_000_000))
        } while true
        throw NativeFailure("preemption_pending", details: ["preemptToken": value.preemptToken,
            "terminalCause": cause, "stopConfirmed": false])
    }
    private func reclaimConfirmedSessions() {
        for (id, value) in sessions where checkpoint(value) {
            guard let cause = value.state.terminal else { continue }
            var receipt = value.stopReceipt(cause: cause)
            receipt["stopConfirmed"] = true
            stoppedReceipts[id] = receipt
            stoppedReceiptOrder.append(id)
            if lastSessionByWindow[value.windowIdentity] == id { lastSessionByWindow.removeValue(forKey: value.windowIdentity) }
            sessions.removeValue(forKey: id)
        }
        while stoppedReceiptOrder.count > 128 {
            stoppedReceipts.removeValue(forKey: stoppedReceiptOrder.removeFirst())
        }
    }

    private func bindingTarget(_ candidate: DirectedCandidate) throws -> (AXUIElement, Bool) {
        try candidate.binding.verify()
        let focus = try NativeFocus.state()
        let ownsFront = focus.front == candidate.binding.pid, ownsKey = focus.key == candidate.binding.pid
        guard ownsFront == ownsKey else { throw NativeFailure("focus_transitioning") }
        let semanticOnly = ownsFront || candidate.allowOffscreen
        let focused = ownsKey ? try AXSnapshotReader.focusedWindow(pid: candidate.binding.pid) : nil
        guard windowFocusDisposition(semanticOnly: semanticOnly, pid: candidate.binding.pid, window: candidate.window,
                                     front: focus.front, key: focus.key, focusedWindow: focused) == .allowed else {
            throw NativeFailure("target_must_be_background")
        }
        return (try root(candidate), semanticOnly)
    }

    // Only the native lane admits bindings and starts workers for existing bindings.
    func bind(_ params: [String: Any], epoch: UInt64, checkEpoch: () throws -> Void, preempt shouldPreempt: Bool = false,
              owner: PeerIdentity? = nil) throws -> [String: Any] {
        guard let ref = params["windowRef"] as? String, let candidate = candidates[ref],
              candidate.epoch == epoch, ProcessInfo.processInfo.systemUptime - candidate.created <= 15,
              let id = params["sessionId"] as? String,
              NativeWindowOccupancy.validSessionId(id) else { throw NativeFailure("invalid_window_binding") }
        let replacing: DirectedSession?
        if shouldPreempt {
            guard let token = params["preemptToken"] as? String, token.utf8.count == 44, id != token,
                  token.range(of: "^preempt-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
                throw NativeFailure("invalid_preempt_token")
            }
            replacing = try preemptionTarget(candidate, token: token)
        } else {
            guard params["preemptToken"] == nil else { throw NativeFailure("invalid_args") }
            replacing = nil
        }
        let leased: Bool
        if let raw = params["lease"] {
            guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw NativeFailure("invalid_args") }
            leased = flag.boolValue
        } else { leased = false }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw NativeFailure("input_permission_required") }
        let used = lock.withLock { sessions[id] != nil || stoppedReceipts[id] != nil }
        guard !used, !FileManager.default.fileExists(atPath: directory.appendingPathComponent(id + ".json").path) else { throw NativeFailure("session_id_used") }
        try checkEpoch()
        var target = try bindingTarget(candidate)
        var replacementReceipt: [String: Any]?
        if let replacing {
            guard CFEqual(replacing.root, target.0) else { throw NativeFailure("stale_preemption") }
            try checkEpoch()
            replacementReceipt = try preempt(replacing)
            try checkEpoch()
            target = try bindingTarget(candidate)
            guard CFEqual(replacing.root, target.0) else { throw NativeFailure("stale_preemption") }
        } else {
            poll()
            releaseStoppedFocus()
            if let occupant = windowOccupant(candidate) {
                let details = CFEqual(occupant.root, target.0) ? ["preemptToken": occupant.preemptToken] : [:]
                throw NativeFailure("busy", details: details)
            }
        }
        let (root, semanticOnly) = target
        let hasRoom = lock.withLock {
            if sessions.count >= 64 { reclaimConfirmedSessions() }
            return sessions.count < 64
        }
        guard hasRoom else { throw NativeFailure("session_limit") }
        let rows = try AXSnapshotReader.cgBounds(pid: candidate.binding.pid, window: candidate.window, allowOffscreen: candidate.allowOffscreen)
        let bounds = CGRect(x: rows[0], y: rows[1], width: rows[2], height: rows[3])
        let window = try shareable(candidate.binding, candidate.window, allowOffscreen: candidate.allowOffscreen)
        let viewport = try WindowViewport(bounds: bounds, scale: CGFloat(SCContentFilter(desktopIndependentWindow: window).pointPixelScale))
        let value = DirectedSession(id: id, candidate: candidate, root: root, viewport: viewport, directory: directory,
                                    semanticOnly: semanticOnly, foregroundNavigationFallback: params["foregroundNavigationFallback"] as? Bool == true,
                                    leased: leased, owner: owner)
        try checkEpoch()
        // Failed and in-flight bindings still own resources that shutdown must wait for.
        try occupancy.claim(candidate.identity.storageKey, sessionId: id)
        store(value)
        var result: [String: Any] = ["sessionId": id, "scope": "background", "status": "bound",
            "expiresAt": value.deadline, "capabilities": Self.capabilities(semanticOnly: value.semanticOnly).merging(["foregroundNavigationFallback": value.foregroundNavigationFallback]) { _, active in active }]
        if let replacementReceipt, let replacing {
            result["preemption"] = replacementReceipt
            result["preemptedSessionId"] = replacing.state.id
        }
        do {
            try checkEpoch()
            if let observer = try? WindowAXInvalidation(pid: candidate.binding.pid, root: root, onRootDestroyed: { [weak value] in value?.stop("invalidated") }) {
                try value.attach(observer)
                try observer.update(elements: [root]) { try value.alive() }
            }
            let capture = try ControlCapture(window: window) { [weak value] in value?.stop("screen_capture_stopped") }
            try value.attach(capture)
            try capture.start { try value.checkFocus() }
            try value.checkFocus()
            guard try value.identity() == bounds else { throw NativeFailure("window_geometry_changed") }
            if leased { result["lease"] = try value.leaseReceipt() }
            try checkEpoch()
        } catch {
            value.stop((error as? NativeFailure)?.code == "system_sleep" ? "system_sleep" : "binding_failed")
            throw error
        }
        value.indicateRead()
        return result
    }

    func handle(_ method: String, params: [String: Any]) throws -> [String: Any] {
        let value = try session(params)
        switch method {
        case "renew":
            return ["sessionId": value.state.id, "status": "renewed", "lease": try value.leaseReceipt(renew: true)]
        case "observe": return try observe(value, params)
        case "act": return try act(value, params)
        case "verify": return try verify(value, params)
        default: throw NativeFailure("unsupported_method")
        }
    }

    private func screenshot(_ value: DirectedSession, window: SCWindow) throws -> [String: Any] {
        let configuration = SCStreamConfiguration()
        configuration.width = value.viewport.width; configuration.height = value.viewport.height
        configuration.showsCursor = false; configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        let ready = DispatchSemaphore(value: 0)
        var image: CGImage?, failure: Error?
        try value.beginScreenshot()
        SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration) { found, error in
            image = found; failure = error
            value.finishScreenshot()
            ready.signal()
        }
        guard ready.wait(timeout: .now() + 3) == .success, failure == nil, let image,
              image.width == value.viewport.width, image.height == value.viewport.height,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 5 * 1024 * 1024 else {
            throw NativeFailure("window_screenshot_unavailable")
        }
        try value.checkFocus()
        return value.viewport.metadata.merging(["mimeType": "image/png", "data": png.base64EncodedString()]) { _, b in b }
    }

    private func observe(_ value: DirectedSession, _ params: [String: Any]) throws -> [String: Any] {
        value.consumed = true; value.observationID = nil
        try value.checkFocus()
        try value.invalidateDestroyed()
        let bounds = try value.identity(), previous = value.viewport
        let needsImage = params["screenshot"] as? Bool == true
        var window: SCWindow?
        if needsImage || bounds != previous.bounds {
            let shareableWindow = try shareable(value.binding, value.window, allowOffscreen: value.allowOffscreen)
            window = shareableWindow
            value.viewport = try WindowViewport(bounds: bounds, scale: CGFloat(SCContentFilter(desktopIndependentWindow: shareableWindow).pointPixelScale))
        }
        let requested = try params["region"].map { try value.viewport.observationRegion($0) }
        let image = needsImage ? try window.map { try screenshot(value, window: $0) } : nil
        let started = ProcessInfo.processInfo.systemUptime, wall = Date().timeIntervalSince1970
        let snapshot = try value.ax.read(root: value.root, pid: value.binding.pid, bounds: bounds, region: requested?.region) { try value.alive() }
        try value.observer?.update(elements: snapshot.nodes.map(\.element)) { try value.alive() }
        guard try value.invalidateDestroyed() == false else { throw NativeFailure("window_observation_invalidated") }
        try value.checkFocus()
        guard try value.identity() == bounds else { throw NativeFailure("window_geometry_changed") }
        value.indicateRead()
        let foreground = value.usingForeground
        let internalDelta = snapshot.delta
        let incremental = params["full"] as? Bool != true && previous == value.viewport
            && foreground == value.lastObservationUsedForeground
            && internalDelta["mode"] as? String == "delta"
            && params["baseVersion"] as? Int == internalDelta["baseVersion"] as? Int
        let added = incremental ? internalDelta["added"] as? [[String: Any]] ?? [] : snapshot.nodes.map(\.metadata)
        let changed = incremental ? internalDelta["changed"] as? [[String: Any]] ?? [] : []
        let records = (added + changed).map { row -> [String: Any] in
            var row = row
            if let ref = row["ref"] as? String, let node = value.ax.node(ref: ref) {
                row["imageFrame"] = value.viewport.imageFrame(node.frame)
                row["axActions"] = value.semanticOnly || foreground ? [] : Self.availableAXActions(node)
                let actions = Self.nodeActions(node, semanticOnly: value.semanticOnly)
                row["actions"] = foreground ? actions.filter(Self.foregroundPointerActions.contains) : actions
            }
            return row
        }
        let delta: [String: Any] = ["mode": incremental ? "delta" : "full", "lineageId": internalDelta["lineageId"]!,
            "baseVersion": incremental ? internalDelta["baseVersion"]! : NSNull(), "version": snapshot.version,
            "complete": snapshot.complete, "added": added.compactMap { $0["ref"] as? String },
            "changed": changed.compactMap { $0["ref"] as? String }, "removed": incremental ? internalDelta["removed"]! : []]
        value.snapshot = snapshot; value.observationID = UUID().uuidString.lowercased()
        value.lastObservationUsedForeground = foreground
        value.observedUptime = started; value.observedAt = wall; value.consumed = false
        var capabilities = Self.capabilities(semanticOnly: value.semanticOnly)
        capabilities["foregroundNavigationFallback"] = value.foregroundNavigationFallback
        if foreground { capabilities["actions"] = Self.foregroundPointerActions }
        var result: [String: Any] = ["sessionId": value.state.id, "scope": "background", "status": "observed",
            "observationId": value.observationID!, "stateVersion": snapshot.version, "complete": snapshot.complete,
            "elements": records, "delta": delta, "viewport": value.viewport.metadata,
            "capabilities": capabilities, "sampling": snapshot.diagnostics,
            "axInvalidation": value.observer?.diagnostics ?? ["available": false],
            "validity": ["observedAt": wall, "expiresAt": min(wall + 15, value.deadline), "maxAgeSeconds": 15, "clock": "remote_wall_time"]]
        if let image { result["screenshot"] = image }
        if let requested { result["region"] = requested.pixels }
        return result
    }

    private static func allowedAXAction(_ name: String, receiverRole: String? = nil) -> Bool {
        // AXRaise changes real foreground ordering and is never an implicit fallback.
        !name.isEmpty && name.utf8.count <= 128 && !name.contains("\0") && name != kAXRaiseAction && name != kAXShowMenuAction
            && (name != kAXPressAction || receiverRole != "AXGroup")
    }
    private static func availableAXActions(_ node: WindowAXNode) -> [String] {
        menuControl(node) || node.metadata["regionAncestorOnly"] as? Bool == true ? [] : node.actions.filter { allowedAXAction($0, receiverRole: node.role) }
    }
    private static func menuControl(_ node: WindowAXNode) -> Bool {
        AXSnapshotReader.isMenuRole(node.role) || node.metadata["menuAncestor"] as? Bool == true
    }
    private static func keyboardRole(_ role: String) -> Bool { !role.isEmpty && role != "AXSecureTextField" && !AXSnapshotReader.isMenuRole(role) }
    private static func nodeActions(_ node: WindowAXNode, semanticOnly: Bool = false) -> [String] {
        guard node.metadata["regionAncestorOnly"] as? Bool != true else { return [] }
        if semanticOnly {
            guard node.enabled, node.metadata["secure"] as? Bool != true, node.metadata["roleTruncated"] as? Bool != true,
                  !menuControl(node) else { return [] }
            var result = nodeActions(node).filter { ["setValue", "selectText"].contains($0) }
            if ["AXButton", "AXCheckBox", "AXRadioButton"].contains(node.role), node.actions.contains(kAXPressAction) {
                if !node.frame.isNull { result.append("click") }
                result.append("press")
            }
            return result
        }
        guard node.enabled, node.metadata["secure"] as? Bool != true, node.metadata["roleTruncated"] as? Bool != true else { return [] }
        let menu = menuControl(node)
        var result = node.frame.isNull ? [] : menu ? ["move"] : ["move", "click", "drag", "scroll"]
        let text = ["AXTextField", "AXTextArea", "AXComboBox"].contains(node.role)
        if !menu && (text || node.metadata["focused"] as? Bool == true) { result.append("key") }
        if text && !menu { result.append("type") }
        let axActions = availableAXActions(node)
        if axActions.contains(kAXPressAction) { result.append("press") }
        let valueType = node.metadata["valueType"] as? String
        if node.valueSettable && (valueType == "string" || valueType == "missing" && ["AXTextField", "AXTextArea", "AXComboBox"].contains(node.role)) {
            result.append("setValue")
        }
        if node.metadata["selectionSettable"] as? Bool == true, node.metadata["valueTruncated"] as? Bool == false {
            result.append("selectText")
        }
        if !axActions.isEmpty { result.append("performAction") }
        return result
    }

    private func read(_ element: AXUIElement, _ key: String) throws -> CFTypeRef {
        AXUIElementSetMessagingTimeout(element, 0.04)
        var raw: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, key as CFString, &raw)
        guard status == .success, let raw else { throw NativeFailure("window_ax_read_failed", details: ["attribute": key, "axError": status.rawValue]) }
        return raw
    }
    private func member(_ element: AXUIElement, _ value: DirectedSession) throws {
        if CFEqual(element, value.root) { return }
        if let window = try? read(element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID(), CFEqual(window, value.root) { return }
        var current = element, visited: [AXUIElement] = []
        let until = ProcessInfo.processInfo.systemUptime + 0.12
        for _ in 0...Self.receiverAncestorLimit {
            guard ProcessInfo.processInfo.systemUptime < until, !visited.contains(where: { CFEqual($0, current) }) else { break }
            visited.append(current)
            let raw = try read(current, kAXParentAttribute)
            guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { break }
            current = raw as! AXUIElement
            if CFEqual(current, value.root) { return }
        }
        throw NativeFailure("window_receiver_changed")
    }
    private func focused(_ value: DirectedSession) throws -> AXUIElement {
        let raw = try read(AXUIElementCreateApplication(value.binding.pid), kAXFocusedUIElementAttribute)
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw NativeFailure("keyboard_receiver_unavailable") }
        let element = raw as! AXUIElement
        try checkNonMenuReceiver(element, value)
        let role = try read(element, kAXRoleAttribute) as? String
        guard let role, Self.keyboardRole(role) else { throw NativeFailure("secure_or_unknown_keyboard_receiver") }
        var rawSubrole: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &rawSubrole)
        guard (error == .success || error == .noValue || error == .attributeUnsupported), rawSubrole as? String != "AXSecureTextField" else {
            throw NativeFailure("secure_or_unknown_keyboard_receiver")
        }
        return element
    }
    private func actualKeyboard(_ element: AXUIElement, _ value: DirectedSession) throws -> ProcessBinding {
        typealias ActualPID = @convention(c) (AXUIElement, UnsafeMutablePointer<pid_t>) -> AXError
        guard let get = NativeFocus.symbol("_AXUIElementGetActualPid", ActualPID.self) else { throw NativeFailure("keyboard_receiver_spi_unavailable") }
        var pid: pid_t = 0
        guard get(element, &pid) == .success, pid > 0 else { throw NativeFailure("keyboard_receiver_unavailable") }
        try member(element, value)
        return try ProcessBinding.read(pid)
    }

    private func pointerReceiver(_ point: CGPoint, _ value: DirectedSession, expectedTarget: WindowAXNode?) throws -> AXUIElement {
        let global = value.viewport.globalPoint(point)
        if value.snapshot?.nodes.contains(where: { Self.menuControl($0) && $0.frame.contains(global) }) == true {
            throw NativeFailure("unsupported_background_menu")
        }
        let application = AXUIElementCreateApplication(value.binding.pid)
        AXUIElementSetMessagingTimeout(application, 0.04)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(global.x), Float(global.y), &hit) == .success, let hit else {
            throw NativeFailure("pointer_receiver_unavailable")
        }
        try checkNonMenuReceiver(hit, value, expectedTarget: expectedTarget?.element)
        return hit
    }

    private func overlappingPressFrames(_ snapshot: WindowAXSnapshot?, state: WindowAXState, target: WindowAXNode,
                                        matches: (CGRect) -> Bool) -> [CGRect] {
        func contains(_ ref: String, from node: WindowAXNode) -> Bool {
            var current: WindowAXNode? = node
            while let item = current {
                if item.ref == ref { return true }
                current = item.parentRef.flatMap { state.node(ref: $0) }
            }
            return false
        }
        // An AX hit can disagree with the renderer when unrelated controls overlap.
        return snapshot?.nodes.compactMap { node in
            guard node.enabled, node.actions.contains(kAXPressAction), matches(node.frame),
                  !contains(target.ref, from: node), !contains(node.ref, from: target) else { return nil }
            return node.frame
        } ?? []
    }

    private func checkCoordinateClick(_ raw: [String: Any], point: CGPoint, in value: DirectedSession) throws {
        let viewport = value.viewport
        guard let x = raw["x"] as? NSNumber, let y = raw["y"] as? NSNumber else { throw NativeFailure("invalid_args") }
        let pixel = try viewport.observationRegion(["x": x.intValue, "y": y.intValue, "width": 1, "height": 1]).region
        // Keep the caller's references intact while checking the layers at this pixel.
        let state = WindowAXState()
        let snapshot = try state.read(root: value.root, pid: value.binding.pid, bounds: viewport.bounds, region: pixel) {
            try value.alive()
        }
        let global = viewport.globalPoint(point)
        // Parents precede their children, so the last hit has no matching descendant.
        if let last = snapshot.nodes.last(where: { $0.enabled && $0.actions.contains(kAXPressAction) && $0.frame.contains(global) }),
           !overlappingPressFrames(snapshot, state: state, target: last, matches: { $0.contains(global) }).isEmpty {
            throw NativeFailure("pointer_target_ambiguous", "Multiple controls overlap this pixel. Observe their toolbar and use the intended control's advertised press action with its reference.")
        }
        guard snapshot.complete else {
            throw NativeFailure("pointer_receiver_unavailable", "The controls at this pixel could not be fully inspected. Observe the intended control and use its reference.")
        }
    }

    private func checkPointerReceiver(_ point: CGPoint, _ value: DirectedSession, expectedTarget: WindowAXNode? = nil,
                                      sameReceiver: WindowAXNode? = nil) throws {
        let hit = try pointerReceiver(point, value, expectedTarget: expectedTarget)
        if let sameReceiver, !CFEqual(hit, sameReceiver.element) {
            throw NativeFailure("pointer_target_mismatch", "The click point no longer resolves to the intended control.")
        }
        guard let target = sameReceiver ?? expectedTarget else { return }
        let global = value.viewport.globalPoint(point)
        guard overlappingPressFrames(value.snapshot, state: value.ax, target: target, matches: { $0.contains(global) }).isEmpty else {
            throw NativeFailure("pointer_target_ambiguous", "Another control overlaps the click point. Observe again and choose a point that identifies only the intended control.")
        }
    }

    private static func uncoveredClickPoint(near preferred: CGPoint, inside area: CGRect, blockedBy: [CGRect]) -> CGPoint? {
        guard !area.isNull, !blockedBy.isEmpty, blockedBy.count <= 32 else { return nil }
        let clips = blockedBy.map { area.intersection($0) }.filter { !$0.isNull && !$0.isEmpty }
        let columns = Set([area.minX, area.maxX] + clips.flatMap { [$0.minX, $0.maxX] }).sorted()
        let rows = Set([area.minY, area.maxY] + clips.flatMap { [$0.minY, $0.maxY] }).sorted()
        var nearest: CGPoint?
        var distance = CGFloat.infinity
        for (left, right) in zip(columns, columns.dropFirst()) where right - left >= 2 {
            for (top, bottom) in zip(rows, rows.dropFirst()) where bottom - top >= 2 {
                let point = CGPoint(x: (left + right) / 2, y: (top + bottom) / 2)
                let dx = point.x - preferred.x, dy = point.y - preferred.y
                let squaredDistance = dx * dx + dy * dy
                if squaredDistance < distance, !clips.contains(where: { $0.contains(point) }) {
                    nearest = point
                    distance = squaredDistance
                }
            }
        }
        return nearest
    }

    private func alternateClickPoint(_ point: CGPoint, _ value: DirectedSession, target: WindowAXNode)
        -> (CGPoint, WindowAXNode)? {
        guard let snapshot = value.snapshot, snapshot.complete else { return nil }
        let global = value.viewport.globalPoint(point)
        let scope = snapshot.region?.bounds ?? value.viewport.bounds
        guard scope.contains(global),
              !overlappingPressFrames(snapshot, state: value.ax, target: target, matches: { $0.contains(global) }).isEmpty,
              let hit = try? pointerReceiver(point, value, expectedTarget: target),
              let receiver = snapshot.nodes.first(where: { CFEqual($0.element, hit) }),
              receiver.frame.contains(global) else { return nil }
        let area = scope.intersection(target.frame).intersection(receiver.frame)
        let blockers = overlappingPressFrames(snapshot, state: value.ax, target: receiver, matches: { $0.intersects(area) })
        guard let alternate = Self.uncoveredClickPoint(near: global, inside: area, blockedBy: blockers) else { return nil }
        return (CGPoint(x: alternate.x - value.viewport.bounds.minX, y: alternate.y - value.viewport.bounds.minY), receiver)
    }

    private func checkNonMenuReceiver(_ element: AXUIElement, _ value: DirectedSession, expectedTarget: AXUIElement? = nil) throws {
        var current = element, visited: [AXUIElement] = []
        var matchedTarget = expectedTarget == nil
        let until = ProcessInfo.processInfo.systemUptime + 0.12
        for _ in 0...Self.receiverAncestorLimit {
            guard ProcessInfo.processInfo.systemUptime < until, !visited.contains(where: { CFEqual($0, current) }) else { break }
            visited.append(current)
            guard let role = try read(current, kAXRoleAttribute) as? String, !role.isEmpty,
                  !AXSnapshotReader.isMenuRole(role) else {
                throw NativeFailure("unsupported_background_menu")
            }
            if let expectedTarget, CFEqual(current, expectedTarget) { matchedTarget = true }
            if CFEqual(current, value.root) {
                guard matchedTarget else {
                    throw NativeFailure("pointer_target_mismatch", "The click point resolves to a different control. Observe again and choose a point that hits the intended element.")
                }
                return
            }
            let parent = try read(current, kAXParentAttribute)
            guard CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = parent as! AXUIElement
        }
        throw NativeFailure("window_receiver_unavailable")
    }

    // This renderer exposes the topic breadcrumb as static text under a pressable group.
    // Scope its repeatable navigation to the qualified build and detail-page component.
    private func isTopicBreadcrumb(_ node: WindowAXNode, in value: DirectedSession) -> Bool {
        guard value.binding.bundleId == "com.electron.lark",
              ["AXStaticText", "AXGroup"].contains(node.role),
              let url = NSRunningApplication(processIdentifier: value.binding.pid)?.bundleURL,
              Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "7727.149" else { return false }
        var element = node.element
        for depth in 0...3 {
            let classes = (try? read(element, "AXDOMClassList")) as? [String] ?? []
            let controlDepth = node.role == "AXStaticText" ? 1 : 0
            if depth == controlDepth && !(classes.contains("_1b55655") && classes.contains("eb5618e5")) { return false }
            if depth == controlDepth + 2 { return classes.contains("groupDetail_content--TopicDetailPage") }
            guard let parent = try? read(element, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            element = parent as! AXUIElement
        }
        return false
    }

    // Navigation declares that reaching the same destination twice is harmless and removes the source.
    private func sourceStillVisible(_ source: WindowAXNode, receiver: AXUIElement, at point: CGPoint, in value: DirectedSession) throws -> Bool {
        try value.checkFocus()
        guard try value.identity() == value.viewport.bounds else { throw NativeFailure("window_geometry_changed") }
        guard let hit = try? pointerReceiver(point, value, expectedTarget: source), CFEqual(hit, receiver),
              let fresh = try? value.ax.refresh(node: source, pid: value.binding.pid, bounds: value.viewport.bounds, check: { try value.alive() })
        else { return false }
        return fresh.enabled && fresh.frame == source.frame && fresh.role == source.role &&
            fresh.title == source.title && fresh.value == source.value && fresh.identifier == source.identifier
    }

    private func act(_ value: DirectedSession, _ params: [String: Any]) throws -> [String: Any] {
        try value.checkFocus()
        try value.invalidateDestroyed()
        guard let id = params["actionId"] as? String, !id.isEmpty, id.utf8.count <= 128, !id.contains("\0"),
              value.actions[id] == nil, value.actions.count < 128,
              params["observationId"] as? String == value.observationID,
              params["stateVersion"] as? Int == value.snapshot?.version, !value.consumed,
              let raw = params["action"] as? [String: Any], let kind = raw["type"] as? String, Self.actions.contains(kind) else { throw NativeFailure("stale_or_unsupported_action") }
        try Self.checkObservationAge(since: value.observedUptime)
        guard !value.semanticOnly || Self.semanticActions.contains(kind) else { throw NativeFailure("unsupported_window_semantics") }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw NativeFailure("input_permission_required") }
        if value.usingForeground && !Self.foregroundPointerActions.contains(kind) {
            throw NativeFailure("unsupported_foreground_action")
        }
        let node: WindowAXNode?
        if let ref = params["ref"] as? String {
            guard let found = value.ax.node(ref: ref), Self.nodeActions(found, semanticOnly: value.semanticOnly).contains(kind) else { throw NativeFailure("invalid_element_ref") }
            node = found
        } else { node = nil }
        if value.semanticOnly, node == nil { throw NativeFailure("invalid_element_ref") }
        if ["press", "setValue", "selectText", "performAction"].contains(kind), node == nil { throw NativeFailure("invalid_element_ref") }
        let expectation: [String: String]?
        if let supplied = params["expect"] {
            guard let found = supplied as? [String: String], !found.isEmpty,
                  Set(found.keys).isSubset(of: ["role", "identifier", "title", "value", "contains"]),
                  found.values.allSatisfy({ !$0.contains("\0") && $0.utf16.count <= 4096 }) else { throw NativeFailure("invalid_expectation") }
            expectation = found
        } else { expectation = nil }
        var point: CGPoint?, destination: CGPoint?
        func coordinate(_ x: String, _ y: String) throws -> CGPoint? {
            if raw[x] == nil && raw[y] == nil { return nil }
            guard let a = raw[x] as? NSNumber, let b = raw[y] as? NSNumber,
                  CFGetTypeID(a) != CFBooleanGetTypeID(), CFGetTypeID(b) != CFBooleanGetTypeID() else { throw NativeFailure("invalid_args") }
            return try value.viewport.point(a.doubleValue, b.doubleValue)
        }
        point = try coordinate("x", "y"); destination = try coordinate("toX", "toY")
        if let node, !node.frame.isNull, !value.allowOffscreen {
            if let point {
                let global = value.viewport.globalPoint(point)
                guard node.frame.contains(global) else { throw NativeFailure("conflicting_element_coordinate") }
            } else {
                let clipped = node.frame.intersection(value.viewport.bounds)
                if !clipped.isNull, clipped.width > 0, clipped.height > 0 {
                    point = CGPoint(x: clipped.midX - value.viewport.bounds.minX, y: clipped.midY - value.viewport.bounds.minY)
                    if let raw = try? read(node.element, "AXActivationPoint"), CFGetTypeID(raw) == AXValueGetTypeID() {
                        var activation = CGPoint.zero
                        if AXValueGetValue(raw as! AXValue, .cgPoint, &activation), activation.x.isFinite, activation.y.isFinite,
                           node.frame.contains(activation), value.viewport.bounds.contains(activation) {
                            point = CGPoint(x: activation.x - value.viewport.bounds.minX, y: activation.y - value.viewport.bounds.minY)
                        }
                    }
                }
            }
        }
        let repeatableNavigation = kind == "click" && value.foregroundNavigationFallback &&
            (params["navigation"] as? Bool ?? node.map { isTopicBreadcrumb($0, in: value) } ?? false)
        let semanticClick = !repeatableNavigation && (node.map { Self.pressClick(role: $0.role, actions: $0.actions, raw: raw) } ?? false)
        var samePointerReceiver: WindowAXNode?
        if !value.semanticOnly, !value.allowOffscreen, !semanticClick, Self.implicitPrimaryClick(raw),
           let node, let preferred = point, let (alternate, receiver) = alternateClickPoint(preferred, value, target: node) {
            point = alternate
            samePointerReceiver = receiver
        }
        let input = !value.allowOffscreen && ["move", "click", "drag", "scroll", "key", "type"].contains(kind)
            ? try WindowAction.parse(raw, bounds: value.viewport.bounds, point: point, destination: destination) : nil
        if ["press", "setValue", "selectText", "performAction"].contains(kind) { try Self.validateSemantic(raw) }
        if kind == "performAction", let name = raw["action"] as? String,
           !Self.availableAXActions(node!).contains(name) { throw NativeFailure("unsupported_ax_action") }
        if value.semanticOnly, kind == "click", !semanticClick {
            throw NativeFailure("unsupported_window_semantics")
        }
        if kind == "click", node != nil, !semanticClick, let point, let region = value.snapshot?.region,
           !region.bounds.contains(value.viewport.globalPoint(point)) {
            throw NativeFailure("click_outside_observation_region", "Observe a region containing the click point or the whole window before choosing another click.")
        }
        if let point, !value.allowOffscreen {
            try value.pointer.move(sessionID: value.state.id, pid: value.binding.pid, windowID: value.window,
                             bounds: value.viewport.bounds, destination: point, active: { [state = value.state] in state.terminal == nil }) { try value.checkFocus() }
        }
        value.consumed = true
        let record = DirectedAction(kind: kind, node: node, raw: raw, expectation: expectation)
        if semanticClick { record.method = "ax_press" }
        value.actions[id] = record; value.state.actionContext(id)
        defer { value.state.actionContext(nil) }
        let factory: WindowEventFactory? = value.semanticOnly ? nil : try WindowEventFactory(target: WindowInputTarget(pid: value.binding.pid, windowID: value.window, bounds: value.viewport.bounds), marker: value.marker)
        func cleanupIdentity() throws {
            let focus = try NativeFocus.state()
            do {
                if value.usingForeground {
                    guard focus.front == value.binding.pid, focus.key == value.binding.pid,
                          try AXSnapshotReader.focusedWindow(pid: value.binding.pid) == value.window else { throw NativeFailure("cleanup_receiver_changed") }
                } else if focus.front == value.binding.pid || focus.key == value.binding.pid { throw NativeFailure("cleanup_receiver_changed") }
                guard try value.geometry() == value.viewport.bounds else { throw NativeFailure("cleanup_receiver_changed") }
            } catch let failure as NativeFailure {
                throw NativeFailure(failure.code, failure.message, details: failure.details.merging(["stage": "cleanup_guard"]) { _, b in b })
            }
        }
        func posted() { record.events += 1; value.state.recordEvent() }
        var axCompletionUnconfirmed = false
        do {
            var liveNode: WindowAXNode?
            let proof = ProcessInfo.processInfo.systemUptime
            try value.checkFocus()
            try Self.checkObservationAge(since: value.observedUptime)
            guard try value.identity() == value.viewport.bounds else { throw NativeFailure("window_geometry_changed") }
            if let node {
                try member(node.element, value)
                let fresh = try value.ax.refresh(node: node, pid: value.binding.pid, bounds: value.viewport.bounds) { try value.alive() }
                liveNode = fresh
                guard Self.liveElementMatches(fresh, observed: node, kind: kind, semanticOnly: value.semanticOnly,
                                              rawAction: raw["action"] as? String) else {
                    throw NativeFailure("element_changed")
                }
                if ["key", "type"].contains(kind), let selection = node.metadata["selectedTextRange"] as? [Int],
                   fresh.metadata["selectedTextRange"] as? [Int] != selection { throw NativeFailure("selection_changed") }
            }
            let pointerTarget = kind == "click" && !semanticClick ? liveNode : nil
            var navigationSource: (AXUIElement, pid_t)?
            if repeatableNavigation, !value.usingForeground,
               let pointerTarget, let point, input?.clicks == 1, input?.button == .left {
                let focus = try NativeFocus.state()
                if focus.front == focus.key && focus.front != value.binding.pid {
                    navigationSource = (try pointerReceiver(point, value, expectedTarget: pointerTarget), focus.front)
                }
            }
            if ["click", "drag", "scroll"].contains(kind) && !semanticClick {
                if kind == "click", pointerTarget == nil, let point { try checkCoordinateClick(raw, point: point, in: value) }
                if let point { try checkPointerReceiver(point, value, expectedTarget: pointerTarget, sameReceiver: samePointerReceiver) }
                if let destination { try checkPointerReceiver(destination, value) }
            }
            try value.checkFocus()
            guard ProcessInfo.processInfo.systemUptime - proof <= 0.2 else { throw NativeFailure("receiver_proof_expired") }
            record.proof = ["proofAgeMs": (ProcessInfo.processInfo.systemUptime - proof) * 1000, "sameWindow": true, "sameAXObject": node != nil]
            if point != nil && pointerTarget != nil { record.proof["pointerTargetMatched"] = true }
            if samePointerReceiver != nil { record.proof["alternateClickPoint"] = true }
            let check = {
                try value.checkFocus()
                do {
                    guard try value.geometry() == value.viewport.bounds else { throw NativeFailure("window_geometry_changed") }
                } catch let failure as NativeFailure {
                    throw NativeFailure(failure.code, failure.message, details: failure.details.merging(["stage": "input_guard"]) { _, b in b })
                }
                try value.alive(requireSettledFocus: true)
            }
            func admitAX() throws {
                try check()
                // Reserve the call under the same lock that publishes a stop.
                try value.alive(requireSettledFocus: true) {
                    guard ProcessInfo.processInfo.systemUptime - proof <= 0.2 else { throw NativeFailure("receiver_proof_expired") }
                    record.operations += 1
                    axCompletionUnconfirmed = true
                }
            }
            if ["key", "type"].contains(kind) {
                let factory = factory!
                if node == nil { _ = try focused(value) }
                for (index, event) in try factory.localFocus(active: true, point: point).enumerated() {
                    try factory.post(event, check: check, posted: posted)
                    if index == 0 {
                        focusOwners[value.binding.pid]?.localFocus(false)
                        focusOwners[value.binding.pid] = value
                        value.localFocus(true)
                    }
                }
                usleep(20_000)
                let alreadyFocused = node.map { node in (try? focused(value)).map({ CFEqual($0, node.element) }) == true } ?? true
                let preserveRange = ["key", "type"].contains(kind) ? liveNode?.metadata["selectedTextRange"] as? [Int] : nil
                let prepareKeyWindow = kind == "key" && preserveRange?.count == 2 && liveNode?.metadata["selectionSettable"] as? Bool == true
                if let node, !alreadyFocused || prepareKeyWindow {
                    guard let point else { throw NativeFailure("keyboard_focus_point_unavailable") }
                    try WindowEventDispatcher.prepareFocus(at: point, factory: factory, check: check, posted: posted, cleanupIdentity: cleanupIdentity)
                    usleep(20_000)
                    if let preserveRange, preserveRange.count == 2, let liveNode,
                       liveNode.metadata["selectionSettable"] as? Bool == true {
                        if liveNode.metadata["valueTruncated"] as? Bool == false,
                           try read(node.element, kAXValueAttribute) as? String != liveNode.value { throw NativeFailure("keyboard_selection_changed") }
                        var range = CFRange(location: preserveRange[0], length: preserveRange[1])
                        guard let encoded = AXValueCreate(.cfRange, &range) else { throw NativeFailure("invalid_selection") }
                        try check()
                        record.operations += 1
                        axCompletionUnconfirmed = true
                        guard AXUIElementSetAttributeValue(node.element, kAXSelectedTextRangeAttribute as CFString, encoded) == .success else {
                            throw NativeFailure("keyboard_selection_outcome_unknown")
                        }
                        axCompletionUnconfirmed = false
                        record.proof["localSelectionPreserved"] = true
                    }
                }
                let receiver = try focused(value)
                if let node { guard CFEqual(receiver, node.element) else { throw NativeFailure("keyboard_receiver_changed") } }
                let receiverBinding = try actualKeyboard(receiver, value)
                if let input {
                    let keys = try WindowEventFactory(target: WindowInputTarget(pid: receiverBinding.pid, windowID: value.window, bounds: value.viewport.bounds), marker: value.marker)
                    let checkKeyboard = {
                        try check(); try receiverBinding.verify()
                        guard CFEqual(try self.focused(value), receiver) else { throw NativeFailure("keyboard_receiver_changed") }
                        try value.alive(requireSettledFocus: true)
                    }
                    try WindowEventDispatcher.perform(input, factory: keys, check: check, checkKeyboard: checkKeyboard, posted: posted,
                        cleanupIdentity: { try cleanupIdentity(); try receiverBinding.verify() })
                }
            }
            var confirmedAX = false
            if kind == "selectText" {
                let node = node!, range = try Self.selection(raw, text: node.value)
                var mutable = range
                guard let encoded = AXValueCreate(.cfRange, &mutable) else { throw NativeFailure("invalid_selection") }
                record.range = range
                try admitAX()
                guard AXUIElementSetAttributeValue(node.element, kAXSelectedTextRangeAttribute as CFString, encoded) == .success else { throw NativeFailure("ax_selection_outcome_unknown") }
                axCompletionUnconfirmed = false
                confirmedAX = true
            } else if kind == "setValue" || kind == "press" || kind == "performAction" || semanticClick {
                let node = node!
                let error: AXError
                if kind == "setValue" {
                    var settable: DarwinBoolean = false
                    AXUIElementSetMessagingTimeout(node.element, 0.04)
                    let readStarted = ProcessInfo.processInfo.systemUptime
                    var readError = AXError.failure, readAttempt = 0
                    while true {
                        settable = false
                        readError = AXUIElementIsAttributeSettable(node.element, kAXValueAttribute as CFString, &settable)
                        guard AXSnapshotReader.retryTransientRead(readError, attempt: readAttempt,
                            elapsed: ProcessInfo.processInfo.systemUptime - readStarted) else { break }
                        readAttempt += 1
                        usleep(5_000)
                    }
                    guard readError == .success, settable.boolValue else {
                        throw NativeFailure("ax_value_not_settable", details: ["axError": readError.rawValue,
                            "readAttempts": readAttempt + 1, "settable": settable.boolValue])
                    }
                    AXUIElementSetMessagingTimeout(node.element, 0.8)
                    try admitAX()
                    error = AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, record.value! as CFString)
                } else {
                    try checkNonMenuReceiver(node.element, value)
                    AXUIElementSetMessagingTimeout(node.element, 0.8)
                    try admitAX()
                    error = AXUIElementPerformAction(node.element, (kind == "press" || semanticClick ? kAXPressAction : raw["action"] as! String) as CFString)
                }
                guard error == .success else { throw NativeFailure("ax_outcome_unknown", details: ["axError": error.rawValue]) }
                axCompletionUnconfirmed = false
                confirmedAX = true
            } else if let input, !["key", "type"].contains(kind) {
                try WindowEventDispatcher.perform(input, factory: factory!, check: check, checkKeyboard: check, posted: posted,
                    cleanupIdentity: cleanupIdentity, visualProgress: { position in
                        value.pointer.follow(sessionID: value.state.id, pid: value.binding.pid, windowID: value.window,
                            bounds: value.viewport.bounds, position: position, active: { [state = value.state] in state.terminal == nil })
                    })
            }
            if let (receiver, originalFront) = navigationSource, let node, let point, let input, let factory,
               record.events == 2 {
                var unchanged = true
                for delay: UInt32 in [180_000, 320_000] {
                    usleep(delay)
                    if try !sourceStillVisible(node, receiver: receiver, at: point, in: value) { unchanged = false; break }
                }
                if unchanged, expectation != nil {
                    let readback = try verify(value, ["actionId": id])
                    unchanged = readback["matchedElements"] as? Int == 0
                }
                if unchanged {
                    try Self.checkObservationAge(since: value.observedUptime)
                    try checkPointerReceiver(point, value, expectedTarget: node, sameReceiver: samePointerReceiver)
                    try value.activateForNavigation(from: originalFront)
                    record.proof["foregroundActivated"] = true
                    if try sourceStillVisible(node, receiver: receiver, at: point, in: value) {
                        try checkPointerReceiver(point, value, expectedTarget: node, sameReceiver: samePointerReceiver)
                        try WindowEventDispatcher.perform(input, factory: factory, check: check, checkKeyboard: check,
                            posted: posted, cleanupIdentity: cleanupIdentity, visualProgress: { _ in })
                        record.proof["foregroundRetry"] = true
                    }
                }
            }
            if try Self.dispatchFeedbackAllowed(confirmedAX: confirmedAX, check: value.checkFocus) {
                if !value.allowOffscreen { value.pointer.feedback(sessionID: value.state.id) }
            } else {
                try value.alive()
            }
            return ["sessionId": value.state.id, "scope": "background", "actionId": id, "status": "dispatched_unverified",
                "effectVerified": false, "verificationRequired": true, "replayAllowed": false, "eventsPosted": record.events,
                "operationsDispatched": record.operations, "method": record.method, "dispatchChecks": [record.proof]]
        } catch let failure as NativeFailure {
            if axCompletionUnconfirmed || failure.code == "window_release_unconfirmed" { value.markInputStopUnconfirmed() }
            if record.dispatched { value.stop("unknown") }
            releaseStoppedFocus()
            var details = failure.details
            details["effectStatus"] = record.dispatched ? "possibly_dispatched" : "not_dispatched"
            details["eventsPosted"] = record.events; details["operationsDispatched"] = record.operations; details["replayAllowed"] = false
            if let cause = value.state.terminal { details["terminalCause"] = cause }
            throw NativeFailure(failure.code, failure.message, details: details)
        }
    }

    private static func checkObservationAge(since observed: TimeInterval, now: TimeInterval = ProcessInfo.processInfo.systemUptime) throws {
        guard now - observed <= 15 else {
            throw NativeFailure("stale_observation", "Observe the window again before choosing another action.",
                                details: ["effectStatus": "not_dispatched"])
        }
    }

    private static func liveElementMatches(_ fresh: WindowAXNode, observed node: WindowAXNode,
                                           kind: String, semanticOnly: Bool, rawAction: String?) -> Bool {
        guard CFEqual(fresh.element, node.element), fresh.enabled, fresh.role == node.role,
              fresh.identifier == node.identifier, fresh.title == node.title, fresh.frame == node.frame,
              fresh.value == node.value, fresh.metadata["valueType"] as? String == node.metadata["valueType"] as? String,
              nodeActions(fresh, semanticOnly: semanticOnly).contains(kind), fresh.metadata["secure"] as? Bool != true else {
            return false
        }
        if kind == "performAction" {
            guard let action = rawAction else { return false }
            return availableAXActions(fresh).contains(action)
        }
        return true
    }

    private static func dispatchFeedbackAllowed(confirmedAX: Bool, check: () throws -> Void) throws -> Bool {
        do {
            try check()
            return true
        } catch let failure as NativeFailure where confirmedAX && failure.code == "focus_transitioning" {
            // The AX call returned success. Verification can wait for a settled sample.
            return false
        }
    }

    private static func validateSemantic(_ raw: [String: Any]) throws {
        let type = raw["type"] as! String
        let allowed: Set<String>
        switch type {
        case "press": allowed = ["type"]
        case "setValue": allowed = ["type", "value"]
        case "performAction": allowed = ["type", "action"]
        default: allowed = ["type", "text", "prefix", "suffix", "selectionType"]
        }
        guard Set(raw.keys).isSubset(of: allowed) else { throw NativeFailure("invalid_args") }
        if type == "setValue" {
            guard let value = raw["value"] as? String, value.utf16.count <= 16384, !value.contains("\0") else { throw NativeFailure("invalid_value") }
        } else if type == "performAction" {
            guard let name = raw["action"] as? String, allowedAXAction(name) else { throw NativeFailure("unsupported_ax_action") }
        } else if type == "selectText" {
            guard let text = raw["text"] as? String, !text.isEmpty, text.utf16.count <= 4096, !text.contains("\0") else { throw NativeFailure("invalid_selection") }
            for key in ["prefix", "suffix"] where raw[key] != nil {
                guard let value = raw[key] as? String, value.utf16.count <= 4096, !value.contains("\0") else { throw NativeFailure("invalid_selection") }
            }
            if let mode = raw["selectionType"] { guard let mode = mode as? String, ["text", "cursor_before", "cursor_after"].contains(mode) else { throw NativeFailure("invalid_selection") } }
        }
    }
    private static func implicitPrimaryClick(_ raw: [String: Any]) -> Bool {
        guard raw["type"] as? String == "click", Set(raw.keys).isSubset(of: ["type", "button", "clickCount"]),
              raw["button"] == nil || raw["button"] as? String == "left" else { return false }
        guard let rawCount = raw["clickCount"] else { return true }
        guard let count = rawCount as? NSNumber, CFGetTypeID(count) != CFBooleanGetTypeID() else { return false }
        return count.doubleValue == 1
    }
    private static func pressClick(role: String, actions: [String], raw: [String: Any]) -> Bool {
        implicitPrimaryClick(raw) && allowedAXAction(kAXPressAction, receiverRole: role)
            && actions.contains(kAXPressAction) && !["AXPopUpButton", "AXMenuButton", "AXComboBox"].contains(role)
    }
    private static func selection(_ raw: [String: Any], text: String) throws -> CFRange {
        let string = text as NSString, query = raw["text"] as! String
        var range = NSRange(location: 0, length: string.length), matches: [NSRange] = []
        while range.length > 0 {
            let found = string.range(of: query, options: .literal, range: range)
            if found.location == NSNotFound { break }
            let prefix = string.substring(to: found.location), suffix = string.substring(from: NSMaxRange(found))
            if (raw["prefix"] as? String).map({ prefix.hasSuffix($0) }) != false && (raw["suffix"] as? String).map({ suffix.hasPrefix($0) }) != false { matches.append(found) }
            let next = found.location + 1; range = NSRange(location: next, length: string.length - next)
        }
        guard matches.count == 1 else { throw NativeFailure("selection_not_unique") }
        let match = matches[0], mode = raw["selectionType"] as? String ?? "text"
        return CFRange(location: mode == "cursor_after" ? NSMaxRange(match) : match.location, length: mode == "text" ? match.length : 0)
    }

    private func verify(_ value: DirectedSession, _ params: [String: Any]) throws -> [String: Any] {
        guard let id = params["actionId"] as? String, let action = value.actions[id] else { throw NativeFailure("action_not_found") }
        if let cause = value.state.terminal {
            return ["sessionId": value.state.id, "actionId": id, "status": "not_verified", "effectVerified": false, "terminalCause": cause, "replayAllowed": false]
        }
        try value.checkFocus()
        guard try value.identity() == value.viewport.bounds else { throw NativeFailure("window_geometry_changed") }
        var verified = false, checkable = false
        var matchCount: Int?
        let method: String
        if let expectation = action.expectation {
            let reader = WindowAXState()
            let snapshot = try reader.read(root: value.root, pid: value.binding.pid, bounds: value.viewport.bounds) { try value.alive() }
            let matches = snapshot.nodes.map { Self.match($0.metadata, expectation) }
            checkable = snapshot.complete && !matches.contains(0)
            matchCount = checkable ? matches.filter { $0 == 1 }.count : nil
            verified = action.dispatched && matchCount == 1
            method = "independent_ax_postcondition"
        } else if let node = action.node, action.kind == "setValue" || action.kind == "selectText" {
            try member(node.element, value)
            let fresh = try value.ax.refresh(node: node, pid: value.binding.pid, bounds: value.viewport.bounds) { try value.alive() }
            checkable = fresh.metadata["valueTruncated"] as? Bool == false && fresh.metadata["valueType"] as? String == "string"
            if action.kind == "setValue" { verified = checkable && action.dispatched && fresh.value == action.value }
            else if let range = action.range, let selected = fresh.metadata["selectedTextRange"] as? [Int] {
                verified = checkable && action.dispatched && fresh.value == node.value && selected == [range.location, range.length]
            }
            method = "independent_ax_readback"
        } else { method = "postcondition_required" }
        try value.checkFocus()
        guard try value.identity() == value.viewport.bounds else { throw NativeFailure("window_geometry_changed") }
        if !value.allowOffscreen { value.pointer.feedback(sessionID: value.state.id, verified: checkable ? verified : nil) }
        var result: [String: Any] = ["sessionId": value.state.id, "scope": "background", "actionId": id,
            "status": checkable ? (verified ? "verified" : "not_verified") : "unverifiable", "effectVerified": verified,
            "verificationMethod": method, "eventsPosted": action.events, "operationsDispatched": action.operations,
            "replayAllowed": false]
        if let matchCount { result["matchedElements"] = matchCount }
        return result
    }

    // Unknown properties can still match a postcondition; they never establish uniqueness.
    private static func match(_ metadata: [String: Any], _ expectation: [String: String]) -> Int {
        var unknown = false
        for (key, expected) in expectation {
            let field = key == "contains" ? "value" : key
            guard metadata[field + "Truncated"] as? Bool != true, let actual = metadata[field] as? String else { unknown = true; continue }
            if key == "contains" ? !actual.contains(expected) : actual != expected { return -1 }
        }
        return unknown ? 0 : 1
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck(stopDirectory: URL) throws -> Int {
        var count = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("window_control_self_check_failed", details: ["assertion": count + 1]) }
            count += 1
        }
        try checkObservationAge(since: 10, now: 25)
        do {
            try checkObservationAge(since: 10, now: 25.001)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure where error.code == "stale_observation" {
            try check(error.details["effectStatus"] as? String == "not_dispatched")
        }
        let viewport = try WindowViewport(bounds: CGRect(x: -300, y: -100, width: 1000, height: 500), scale: 2)
        let regionPixels: [String: Any] = ["x": 100, "y": 50, "width": 400, "height": 200]
        let forward = try viewport.observationRegion(regionPixels.merging(["fromEnd": false]) { _, new in new })
        try check(forward.region.bounds == CGRect(x: -250, y: -75, width: 200, height: 100))
        try check(forward.region.bounds.contains(viewport.globalPoint(try viewport.point(100, 50))))
        try check(!forward.region.bounds.contains(viewport.globalPoint(try viewport.point(99, 50))))
        try check(!forward.region.fromEnd && forward.pixels["fromEnd"] == nil)
        let reverse = try viewport.observationRegion(regionPixels.merging(["fromEnd": true]) { _, new in new })
        try check(reverse.region.fromEnd && reverse.pixels["fromEnd"] as? Bool == true)
        for (field, invalid) in [("x", -1), ("y", true), ("width", 3.5), ("height", 0),
                                 ("x", 1999), ("fromEnd", 1), ("extra", 1)] as [(String, Any)] {
            do {
                _ = try viewport.observationRegion(regionPixels.merging([field: invalid]) { _, new in new })
                throw NativeFailure("window_control_self_check_failed")
            } catch let failure as NativeFailure where failure.code == "invalid_observation_region" {
                count += 1
            }
        }
        let boundsRow: [String: Any] = [kCGWindowIsOnscreen as String: true,
            kCGWindowBounds as String: ["X": -300, "Y": -100, "Width": 1000, "Height": 500]]
        let listedBounds = try AXSnapshotReader.onScreenBounds(boundsRow)
        try check(listedBounds == [-300, -100, 1000, 500])
        for (row, code) in [
            (boundsRow.merging([kCGWindowIsOnscreen as String: false]) { _, b in b }, "window_not_onscreen"),
            ([kCGWindowIsOnscreen as String: true], "window_bounds_unavailable"),
        ] {
            do {
                _ = try AXSnapshotReader.onScreenBounds(row)
                try check(false)
            } catch let failure as NativeFailure {
                try check(failure.code == code)
            }
        }
        let binding = ProcessBinding(pid: getpid(), startSeconds: 1, startMicroseconds: 2,
                                     executable: "/self-check", bundleId: "com.rome.self-check")
        let candidate = DirectedCandidate(binding: binding, window: 501, allowOffscreen: false)
        let offscreen = DirectedCandidate(binding: binding, window: candidate.window, allowOffscreen: true)
        let differentWindow = DirectedCandidate(binding: binding, window: 502, allowOffscreen: false)
        let differentProcess = DirectedCandidate(binding: ProcessBinding(pid: binding.pid, startSeconds: 2,
            startMicroseconds: binding.startMicroseconds, executable: binding.executable, bundleId: binding.bundleId),
            window: candidate.window, allowOffscreen: false)
        let control = NativeWindow(stopDirectory: stopDirectory)
        let root = AXUIElementCreateApplication(binding.pid)
        let active = DirectedSession(id: UUID().uuidString, candidate: candidate, root: root, viewport: viewport,
                                     directory: stopDirectory, semanticOnly: false)
        let targetIdentity = active.diagnostics["targetIdentity"] as? String
        try check(targetIdentity == candidate.identity.storageKey)
        try check(targetIdentity?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
        control.store(active)
        try check(control.windowOccupant(candidate) === active)
        try check(control.windowOccupant(offscreen) === active)
        try check(control.windowOccupant(differentWindow) == nil)
        try check(control.windowOccupant(differentProcess) == nil)
        active.localFocus(true)
        try active.beginScreenshot()
        let stop = try control.stop(active.state.id, reason: "completed")
        try check(stop.receipt()["terminalCause"] as? String == "completed" && !stop.checkpoint())
        try check(control.windowOccupant(candidate) === active)
        active.localFocus(false)
        try check(!stop.checkpoint())
        active.finishScreenshot()
        try check(active.stopConfirmed)
        try check(control.windowOccupant(candidate) == nil)
        control.reclaimConfirmedSessions()
        let replay = try control.stop(active.state.id, reason: "cancelled")
        try check(control.sessions.isEmpty && replay.checkpoint() && replay.receipt()["stopConfirmed"] as? Bool == true)
        try check(replay.receipt()["terminalCause"] as? String == "completed")
        let uncertain = DirectedSession(id: UUID().uuidString, candidate: candidate, root: root, viewport: viewport,
                                        directory: stopDirectory, semanticOnly: false)
        control.store(uncertain)
        uncertain.markInputStopUnconfirmed()
        let unconfirmed = try control.stop(uncertain.state.id, reason: "cancelled")
        try check(!unconfirmed.checkpoint() && control.windowOccupant(candidate) === uncertain)
        control.reclaimConfirmedSessions()
        try check(control.sessions[uncertain.state.id] != nil)
        try check(capabilities["windowLease"] as? Bool == true)
        try check(capabilities(semanticOnly: true)["windowLease"] as? Bool == true)
        let started = ContinuousClock.now
        var lease = WindowLease(started: started)
        try check(lease.metadata(at: started) == ["idleTimeoutMs": 30_000, "renewAfterMs": 10_000, "remainingMs": 30_000])
        for seconds in stride(from: 20, to: 600, by: 20) {
            let now = started.advanced(by: .seconds(seconds))
            try check(now < lease.end)
            lease.extend(at: now)
        }
        let nearMaximum = started.advanced(by: .seconds(595))
        lease.extend(at: nearMaximum)
        try check(lease.end == started.advanced(by: .seconds(600)))
        try check(lease.metadata(at: nearMaximum)["remainingMs"] == 5_000)
        do {
            _ = try uncertain.leaseReceipt(renew: true)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.details["terminalCause"] as? String == "cancelled") }
        let legacy = DirectedSession(id: UUID().uuidString, candidate: differentWindow, root: root, viewport: viewport,
                                     directory: stopDirectory, semanticOnly: false)
        do {
            _ = try legacy.leaseReceipt(renew: true)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "window_lease_not_enabled" && legacy.state.terminal == nil) }
        let renewable = DirectedSession(id: UUID().uuidString, candidate: differentWindow, root: root, viewport: viewport,
                                        directory: stopDirectory, semanticOnly: true, leased: true,
                                        started: started.advanced(by: .seconds(-20)))
        control.store(renewable)
        try check(try renewable.leaseReceipt()["remainingMs"]! <= 10_000)
        let renewed = try control.handle("renew", params: ["sessionId": renewable.state.id])
        try check(renewed["sessionId"] as? String == renewable.state.id && renewed["status"] as? String == "renewed")
        try check((renewed["lease"] as? [String: Int])?["remainingMs"] == 30_000)
        let expired = DirectedSession(id: UUID().uuidString, candidate: differentProcess, root: root, viewport: viewport,
                                      directory: stopDirectory, semanticOnly: true, leased: true,
                                      started: started.advanced(by: .seconds(-31)))
        control.store(expired)
        let rejected = NSLock()
        var rejectionCount = 0
        DispatchQueue.concurrentPerform(iterations: 8) { index in
            do {
                if index.isMultiple(of: 2) { try expired.alive() }
                else { _ = try expired.leaseReceipt(renew: true) }
            } catch let error as NativeFailure where error.details["terminalCause"] as? String == "expired" {
                rejected.withLock { rejectionCount += 1 }
            } catch {}
        }
        try check(rejectionCount == 8 && expired.state.terminal == "expired" && expired.stopConfirmed)
        try check(control.windowOccupant(differentProcess) == nil)
        try check(capabilities["windowPreemption"] as? Bool == true && capabilities["sessionRecovery"] as? Bool == true)
        let generations = NativeWindow(stopDirectory: stopDirectory)
        let prior = DirectedSession(id: UUID().uuidString, candidate: candidate, root: root, viewport: viewport,
                                    directory: stopDirectory, semanticOnly: true)
        generations.store(prior)
        try check(prior.preemptToken.utf8.count == 44 && prior.preemptToken != prior.state.id)
        let initial = try generations.stopStatus(prior.state.id)
        try check(initial["status"] as? String == "active" && initial["stopConfirmed"] as? Bool == false
                  && initial["terminalCause"] == nil && prior.state.terminal == nil)
        for (proposed, token) in [(differentWindow, prior.preemptToken), (differentProcess, prior.preemptToken),
                                  (candidate, "preempt-" + UUID().uuidString.lowercased())] {
            do {
                _ = try generations.preemptionTarget(proposed, token: token)
                throw NativeFailure("window_control_self_check_failed")
            } catch let error as NativeFailure { try check(error.code == "stale_preemption" && prior.state.terminal == nil) }
        }
        try check(try generations.preemptionTarget(candidate, token: prior.preemptToken) === prior)
        try prior.beginScreenshot()
        do {
            _ = try generations.preempt(prior, wait: 0)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure {
            try check(error.code == "preemption_pending" && error.details["preemptToken"] as? String == prior.preemptToken
                      && error.details["stopConfirmed"] as? Bool == false && error.details["terminalCause"] as? String == "preempted")
        }
        let pending = try generations.stopStatus(prior.state.id)
        try check(pending["terminalCause"] as? String == "preempted" && pending["stopConfirmed"] as? Bool == false)
        prior.finishScreenshot()
        let selected = try generations.preemptionTarget(candidate, token: prior.preemptToken)
        let replaced = try generations.preempt(selected, wait: 0)
        try check(replaced["stopConfirmed"] as? Bool == true && replaced["terminalCause"] as? String == "preempted")
        let replacement = DirectedSession(id: UUID().uuidString, candidate: candidate, root: root, viewport: viewport,
                                          directory: stopDirectory, semanticOnly: true, leased: true)
        generations.store(replacement)
        do {
            _ = try generations.preemptionTarget(candidate, token: prior.preemptToken)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "stale_preemption" && replacement.state.terminal == nil) }
        generations.reclaimConfirmedSessions()
        let cachedStop = try generations.stopStatus(prior.state.id)
        try check(cachedStop["stopConfirmed"] as? Bool == true && cachedStop["terminalCause"] as? String == "preempted")
        try check(try generations.preemptionTarget(candidate, token: replacement.preemptToken) === replacement)
        generations.cancelAll(reason: "system_sleep")
        generations.checkpointStops()
        let slept = try generations.stopStatus(replacement.state.id)
        try check(slept["stopConfirmed"] as? Bool == true && slept["terminalCause"] as? String == "system_sleep")
        do {
            _ = try replacement.leaseReceipt(renew: true)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.details["terminalCause"] as? String == "system_sleep") }
        let firstId = UUID().uuidString
        let secondId = UUID().uuidString
        let windowKey = candidate.identity.storageKey
        let otherKey = differentProcess.identity.storageKey
        try check(windowKey != otherKey && windowKey != differentWindow.identity.storageKey)
        let beforeCrash = NativeWindowOccupancy(directory: stopDirectory)
        try beforeCrash.claim(windowKey, sessionId: firstId)
        let afterCrash = NativeWindowOccupancy(directory: stopDirectory)
        try check(try afterCrash.confirmation(firstId) == nil)
        let pendingAfterCrash = try NativeWindow(stopDirectory: stopDirectory).stopStatus(firstId)
        try check(pendingAfterCrash["status"] as? String == "stop_pending" && pendingAfterCrash["stopConfirmed"] as? Bool == false)
        do {
            try afterCrash.claim(windowKey, sessionId: secondId)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure {
            try check(error.code == "window_stop_unconfirmed" && error.details["stopConfirmed"] as? Bool == false)
        }
        do {
            try afterCrash.claim(otherKey, sessionId: firstId)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "session_id_used") }
        try afterCrash.claim(otherKey, sessionId: secondId)
        try check(try afterCrash.confirmation(secondId) == nil)
        try beforeCrash.confirm(windowKey, sessionId: firstId, cause: "completed")
        let reloaded = NativeWindow(stopDirectory: stopDirectory)
        let recovered = try reloaded.stopStatus(firstId)
        try check(recovered["stopConfirmed"] as? Bool == true && recovered["terminalCause"] as? String == "completed")
        let replacementId = UUID().uuidString
        try afterCrash.claim(windowKey, sessionId: replacementId)
        try beforeCrash.confirm(windowKey, sessionId: firstId, cause: "completed")
        do {
            try afterCrash.claim(windowKey, sessionId: UUID().uuidString)
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "window_stop_unconfirmed") }
        do {
            _ = try reloaded.stopStatus("../../outside")
            throw NativeFailure("window_control_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "invalid_session") }
        try check(viewport.width == 2000 && viewport.height == 1000)
        try check(try viewport.point(100, 200) == CGPoint(x: 50, y: 100))
        try check(viewport.imageFrame(CGRect(x: -250, y: 0, width: 100, height: 40)) == [100, 200, 200, 80])
        try check(viewport.imageFrame(.null).isEmpty)
        let capped = try WindowViewport(bounds: CGRect(x: 0, y: 0, width: 2000, height: 2000), scale: 2)
        try check(capped.width == 1536 && capped.height == 1536)
        for point in [(-1.0, 0.0), (2000.0, 0.0), (0.0, 1000.0), (Double.nan, 0.0)] {
            do { _ = try viewport.point(point.0, point.1); throw NativeFailure("window_control_self_check_failed") }
            catch let error as NativeFailure where error.code == "window_coordinate_out_of_bounds" { count += 1 }
        }
        try check(!allowedAXAction(kAXRaiseAction) && !allowedAXAction(kAXShowMenuAction) && allowedAXAction(kAXPressAction))
        try check(!allowedAXAction("") && !allowedAXAction("AX\0Press") && !allowedAXAction(String(repeating: "x", count: 129)))
        for role in ["AXMenu", "AXMenuBar", "AXMenuBarItem", "AXMenuItem", "AXPopUpButton", "AXMenuButton", "AXComboBox"] {
            let node = WindowAXNode(ref: "menu", element: AXUIElementCreateApplication(getpid()), parentRef: nil,
                role: role, identifier: "menu", title: "", value: "", frame: CGRect(x: 0, y: 0, width: 20, height: 20),
                enabled: true, actions: [kAXPressAction, "AXPick"], valueSettable: false, metadata: [:])
            try check(nodeActions(node) == ["move"] && availableAXActions(node).isEmpty && !keyboardRole(role))
            try check(nodeActions(node, semanticOnly: true).isEmpty)
        }
        try check(!keyboardRole("") && !keyboardRole("AXSecureTextField"))
        try check(keyboardRole("AXTextField") && keyboardRole("AXTextArea") && keyboardRole("AXButton"))
        let ambiguous: [String: Any] = ["type": "selectText", "text": "foo"]
        do { _ = try selection(ambiguous, text: "foo foo"); throw NativeFailure("window_control_self_check_failed") }
        catch let error as NativeFailure where error.code == "selection_not_unique" { count += 1 }
        let unique: [String: Any] = ["type": "selectText", "text": "foo", "prefix": " "]
        let range = try selection(unique, text: "foo foo")
        try check(range.location == 4 && range.length == 3)
        let unicode = try selection(["text": "😀", "selectionType": "cursor_after"], text: "A😀B")
        try check(unicode.location == 3 && unicode.length == 0)
        let before = try selection(["text": "foo", "suffix": "!", "selectionType": "cursor_before"], text: "foo foo!")
        try check(before.location == 4 && before.length == 0)
        try validateSemantic(["type": "setValue", "value": ""]); count += 1
        try validateSemantic(["type": "setValue", "value": String(repeating: "😀", count: 8192)]); count += 1
        for raw: [String: Any] in [["type": "press", "extra": true], ["type": "setValue", "value": "x\0y"],
            ["type": "setValue", "value": String(repeating: "😀", count: 8193)],
            ["type": "performAction", "action": kAXRaiseAction], ["type": "selectText", "text": ""],
            ["type": "selectText", "text": "foo", "selectionType": "wrong"], ["type": "selectText", "text": "foo", "prefix": 1]] {
            do { try validateSemantic(raw); throw NativeFailure("window_control_self_check_failed") }
            catch let error as NativeFailure where error.code != "window_control_self_check_failed" { count += 1 }
        }
        try check(capabilities["realPointer"] as? Bool == false && capabilities["partialObservations"] as? Bool == true)
        try check(AXSnapshotReader.retryTransientRead(.cannotComplete, attempt: 0, elapsed: 0.04))
        try check(AXSnapshotReader.retryTransientRead(.cannotComplete, attempt: 1, elapsed: 0.19))
        try check(!AXSnapshotReader.retryTransientRead(.cannotComplete, attempt: 2, elapsed: 0.19))
        try check(!AXSnapshotReader.retryTransientRead(.cannotComplete, attempt: 1, elapsed: 0.2))
        for error in [AXError.success, .noValue, .invalidUIElement, .attributeUnsupported, .failure] {
            try check(!AXSnapshotReader.retryTransientRead(error, attempt: 0, elapsed: 0.01))
        }
        var reads = 0
        let retryValue = try AXSnapshotReader.retryUnavailableRead("window_ax_root_unavailable") {
            reads += 1
            if reads == 1 {
                throw NativeFailure("window_ax_root_unavailable", details: ["axError": AXError.cannotComplete.rawValue])
            }
            return 42
        }
        try check(retryValue == 42 && reads == 2)
        for (code, error) in [("window_ax_root_unavailable", AXError.success), ("process_identity_changed", .cannotComplete)] {
            do {
                try AXSnapshotReader.retryUnavailableRead("window_ax_root_unavailable") {
                    throw NativeFailure(code, details: ["axError": error.rawValue])
                }
                throw NativeFailure("window_control_self_check_failed")
            } catch let failure as NativeFailure {
                try check(failure.code == code && failure.details["readAttempts"] as? Int == 1)
            }
        }
        for semanticOnly in [false, true] {
            func focus(_ front: pid_t, _ key: pid_t, _ window: CGWindowID?) -> WindowFocusDisposition {
                windowFocusDisposition(semanticOnly: semanticOnly, pid: 10, window: 20, front: front, key: key, focusedWindow: window)
            }
            try check(focus(11, 11, nil) == .allowed)
            try check(focus(10, 11, nil) == .transitioning)
            try check(focus(11, 10, 21) == (semanticOnly ? .transitioning : .takeover))
            try check(focus(11, 10, 20) == .takeover)
            try check(focus(11, 10, nil) == .takeover)
            try check(focus(10, 10, 20) == .takeover)
            try check(focus(10, 10, 0) == .takeover)
            try check(focus(10, 10, nil) == .takeover)
            try check(focus(10, 10, 21) == (semanticOnly ? .allowed : .takeover))
        }
        var transition = WindowFocusTransition()
        try check(transition.check(.allowed, sampledAt: 1, checkedAt: 1) == nil)
        try check(transition.check(.transitioning, sampledAt: 1.1, checkedAt: 1.1)?.code == "focus_transitioning")
        try check(transition.check(.allowed, sampledAt: 1.05, checkedAt: 1.2)?.code == "focus_transitioning")
        try check(transition.isTransitioning && transition.stopRequest == nil)
        try check(transition.check(.transitioning, sampledAt: 1.3, checkedAt: 1.3)?.code == "focus_transitioning")
        try check(transition.check(.allowed, sampledAt: 1.35, checkedAt: 1.35) == nil)
        try check(transition.check(.transitioning, sampledAt: 1.32, checkedAt: 1.37)?.code == "focus_transitioning")
        try check(transition.check(.transitioning, sampledAt: 2, checkedAt: 2)?.code == "focus_transitioning")
        try check(transition.check(.transitioning, sampledAt: 2.36, checkedAt: 2.36)?.code == "focus_transition_unresolved")
        try check(transition.check(.allowed, sampledAt: 2.4, checkedAt: 2.4)?.code == "session_stopped")
        try check(transition.stopRequest?.reason == "session_unavailable")
        var takeover = WindowFocusTransition()
        try check(takeover.check(.allowed, sampledAt: 1, checkedAt: 1) == nil)
        try check(takeover.check(.takeover, sampledAt: 1.15, checkedAt: 1.2, details: ["keyPID": 10])?.code == "target_takeover")
        try check(takeover.check(.allowed, sampledAt: 1.1, checkedAt: 1.21)?.code == "session_stopped")
        let first = takeover.latchStop("cancelled", details: [:])
        try check(first.reason == "takeover" && first.details["keyPID"] as? Int == 10)
        try check(try dispatchFeedbackAllowed(confirmedAX: true) {})
        try check(try !dispatchFeedbackAllowed(confirmedAX: true) { throw NativeFailure("focus_transitioning") })
        for (confirmedAX, code) in [(false, "focus_transitioning"), (true, "target_takeover"),
                                    (true, "focus_transition_unresolved"), (true, "ax_outcome_unknown")] {
            do {
                _ = try dispatchFeedbackAllowed(confirmedAX: confirmedAX) { throw NativeFailure(code) }
                throw NativeFailure("window_control_self_check_failed")
            } catch let failure as NativeFailure where failure.code == code { count += 1 }
        }
        let semanticText = WindowAXNode(ref: "text", element: AXUIElementCreateApplication(getpid()), parentRef: nil,
            role: "AXTextArea", identifier: "text", title: "", value: "text", frame: .zero, enabled: true,
            actions: [], valueSettable: true, metadata: ["valueType": "string", "selectionSettable": true, "valueTruncated": false])
        try check(nodeActions(semanticText, semanticOnly: true) == ["setValue", "selectText"])
        try check(!nodeActions(semanticText, semanticOnly: true).contains("key"))
        var contextOnly = semanticText
        contextOnly.metadata["regionAncestorOnly"] = true
        try check(nodeActions(contextOnly).isEmpty && nodeActions(contextOnly, semanticOnly: true).isEmpty)
        try check(capabilities(semanticOnly: true)["actions"] as? [String] == semanticActions)
        try check(capabilities(semanticOnly: true)["requiresBackgroundApplication"] as? Bool == false)
        try check(capabilities(semanticOnly: false)["requiresBackgroundApplication"] as? Bool == true)
        for actions in [[kAXPressAction], [kAXPressAction, kAXShowMenuAction], [kAXShowMenuAction]] {
            let button = WindowAXNode(ref: "button", element: AXUIElementCreateApplication(getpid()), parentRef: nil,
                role: "AXButton", identifier: "button", title: "", value: "", frame: .zero, enabled: true,
                actions: actions, valueSettable: false, metadata: [:])
            try check(nodeActions(button, semanticOnly: true) == (actions.contains(kAXPressAction) ? ["click", "press"] : []))
            var contextButton = button
            contextButton.metadata["regionAncestorOnly"] = true
            try check(availableAXActions(contextButton).isEmpty)
        }
        let menuButton = WindowAXNode(ref: "combo-button", element: AXUIElementCreateApplication(getpid()), parentRef: "combo",
            role: "AXButton", identifier: "combo-button", title: "", value: "", frame: .zero, enabled: true,
            actions: [kAXPressAction], valueSettable: false, metadata: ["menuAncestor": true])
        try check(nodeActions(menuButton, semanticOnly: true).isEmpty)
        try check(nodeActions(menuButton) == ["move"] && availableAXActions(menuButton).isEmpty)
        let group = WindowAXNode(ref: "group", element: AXUIElementCreateApplication(getpid()), parentRef: nil,
            role: "AXGroup", identifier: "", title: "", value: "", frame: .zero, enabled: true,
            actions: [kAXPressAction, "AXScrollToVisible"], valueSettable: false, metadata: [:])
        try check(availableAXActions(group) == ["AXScrollToVisible"] && !nodeActions(group).contains("press"))
        try check(!pressClick(role: group.role, actions: group.actions, raw: ["type": "click"]))
        try check(match(["identifier": "target", "value": "7"], ["identifier": "target", "value": "7"]) == 1)
        try check(match(["identifier": "target", "value": "7", "valueTruncated": true], ["identifier": "target", "value": "7"]) == 0)
        try check(match(["identifier": "other", "valueTruncated": true], ["identifier": "target", "value": "7"]) == -1)
        try check(match(["value": "ROME 中文"], ["contains": "中文"]) == 1)
        try check(pressClick(role: "AXCheckBox", actions: [kAXPressAction], raw: ["type": "click"]))
        let clickArea = CGRect(x: -20, y: -40, width: 20, height: 16)
        let preferredClick = CGPoint(x: -10, y: -32)
        let sideCover = CGRect(x: -14, y: -40, width: 14, height: 16)
        let topCover = CGRect(x: -20, y: -40, width: 6, height: 12)
        try check(uncoveredClickPoint(near: preferredClick, inside: clickArea, blockedBy: [sideCover, topCover])
                  == CGPoint(x: -17, y: -26))
        try check(uncoveredClickPoint(near: preferredClick, inside: clickArea, blockedBy: [clickArea]) == nil)
        try check(uncoveredClickPoint(near: preferredClick, inside: clickArea,
                                      blockedBy: [CGRect(x: -19, y: -40, width: 19, height: 16)]) == nil)
        try check(uncoveredClickPoint(near: preferredClick, inside: clickArea, blockedBy: [topCover, sideCover])
                  == CGPoint(x: -17, y: -26))
        try check(implicitPrimaryClick(["type": "click", "button": "left", "clickCount": 1]))
        try check(!implicitPrimaryClick(["type": "click", "x": 1, "y": 1]))
        try check(!implicitPrimaryClick(["type": "click", "clickCount": 2]))
        for (role, raw) in [("AXPopUpButton", ["type": "click"] as [String: Any]),
            ("AXButton", ["type": "click", "x": 10, "y": 20]), ("AXButton", ["type": "click", "button": "right"]),
            ("AXButton", ["type": "click", "clickCount": 2]), ("AXButton", ["type": "press"])] {
            try check(!pressClick(role: role, actions: [kAXPressAction], raw: raw))
        }
        let waiting: [String: Any] = ["windowError": AXError.cannotComplete.rawValue, "ownerError": Int32(0),
                                      "actualWindow": CGWindowID(0), "actualPID": pid_t(123)]
        try check(transientWindowRead(NativeFailure("window_binding_changed", details: waiting), pid: 123))
        try check(!transientWindowRead(NativeFailure("window_binding_changed", details: waiting), pid: 124))
        for replacement: [String: Any] in [["windowError": AXError.invalidUIElement.rawValue], ["ownerError": AXError.failure.rawValue],
                                          ["actualWindow": CGWindowID(42)], ["actualPID": pid_t(124)]] {
            try check(!transientWindowRead(NativeFailure("window_binding_changed", details: waiting.merging(replacement) { _, b in b }), pid: 123))
        }
        let observedButton = WindowAXNode(ref: "btn-1", element: AXUIElementCreateApplication(getpid()), parentRef: nil,
            role: "AXButton", identifier: "", title: "Save", value: "", frame: CGRect(x: 10, y: 10, width: 60, height: 24),
            enabled: true, actions: [kAXPressAction], valueSettable: false, metadata: [:])
        let renamedButton = WindowAXNode(ref: "btn-1", element: observedButton.element, parentRef: nil,
            role: "AXButton", identifier: "", title: "Delete", value: "", frame: observedButton.frame,
            enabled: true, actions: [kAXPressAction], valueSettable: false, metadata: [:])
        try check(liveElementMatches(observedButton, observed: observedButton, kind: "press", semanticOnly: true, rawAction: nil))
        try check(!liveElementMatches(renamedButton, observed: observedButton, kind: "press", semanticOnly: true, rawAction: nil))
        return count
    }

    func selfTestRegisterSession(owner: PeerIdentity, windowID: CGWindowID) throws -> String {
        let id = UUID().uuidString
        let binding = ProcessBinding(pid: getpid(), startSeconds: 1, startMicroseconds: 2,
                                     executable: "/self-check", bundleId: "com.rome.self-check")
        let candidate = DirectedCandidate(binding: binding, window: windowID, allowOffscreen: false)
        let viewport = try WindowViewport(bounds: CGRect(x: 0, y: 0, width: 400, height: 300), scale: 1)
        let session = DirectedSession(id: id, candidate: candidate, root: AXUIElementCreateApplication(getpid()),
                                      viewport: viewport, directory: directory, semanticOnly: true, owner: owner)
        store(session)
        return id
    }

    func selfTestTerminal(_ id: String) -> String? {
        lock.withLock { sessions[id]?.state.terminal }
    }
    #endif
}

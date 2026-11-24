import ApplicationServices
import CoreGraphics
import Foundation
import Darwin
import ScreenCaptureKit

struct PermissionFlags: Equatable {
    let accessibility: Bool
    let screenCapture: Bool
    let postEvents: Bool
    let inputMonitoring: Bool

    init(_ values: [String: Any]) {
        accessibility = values["accessibility"] as? Bool == true
        screenCapture = values["screenCapture"] as? Bool == true
        postEvents = values["postEvents"] as? Bool == true
        inputMonitoring = values["inputMonitoring"] as? Bool == true
    }

    var granted: Bool { accessibility && screenCapture && postEvents }
}

struct PermissionRecoveryState {
    enum Phase: String { case needsPermission = "needs_permission", checking, ready, restarting, error }
    private(set) var phase = Phase.needsPermission
    private(set) var restarted = false
    private(set) var failures = 0
    private(set) var generation = 0

    mutating func begin(restarted: Bool = false) {
        generation += 1
        self.restarted = restarted
        failures = 0
        phase = .checking
    }

    mutating func complete(ready: Bool, current: PermissionFlags, fresh: PermissionFlags?, epoch: Int) -> Bool {
        guard epoch == generation, phase != .restarting else { return false }
        if ready { phase = .ready; failures = 0; return false }
        failures += 1
        guard fresh?.granted == true else {
            phase = current.granted ? .error : .needsPermission
            return false
        }
        guard !restarted else { phase = .error; return false }
        // A capture failure can mean additional system consent, even when all preflight flags are true.
        guard !current.granted else { phase = .error; return false }
        restarted = true
        phase = .restarting
        return true
    }

    mutating func failed() { phase = .error }
    mutating func cancel() { generation += 1; phase = .needsPermission }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var count = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("permission_recovery_self_check_failed") }
            count += 1
        }
        let allowed = PermissionFlags(["accessibility": true, "screenCapture": true, "postEvents": true, "inputMonitoring": true])
        let denied = PermissionFlags([:])
        try check(PermissionFlags(["accessibility": true, "screenCapture": true, "postEvents": true]).granted)
        try check(!PermissionFlags(["accessibility": true, "screenCapture": true, "inputMonitoring": true]).granted)
        var state = PermissionRecoveryState()
        state.begin()
        try check(!state.complete(ready: false, current: denied, fresh: denied, epoch: state.generation))
        try check(state.phase == .needsPermission && !state.restarted)
        try check(!state.complete(ready: true, current: allowed, fresh: nil, epoch: state.generation))
        try check(state.phase == .ready)
        state.begin()
        try check(state.complete(ready: false, current: denied, fresh: allowed, epoch: state.generation))
        try check(state.phase == .restarting && state.restarted)
        try check(!state.complete(ready: false, current: denied, fresh: allowed, epoch: state.generation))
        state.begin(restarted: true)
        try check(!state.complete(ready: false, current: denied, fresh: allowed, epoch: state.generation))
        try check(state.phase == .error)
        state.begin(restarted: true)
        try check(!state.complete(ready: true, current: allowed, fresh: nil, epoch: state.generation) && state.phase == .ready)
        state.begin()
        try check(!state.complete(ready: false, current: allowed, fresh: allowed, epoch: state.generation))
        try check(!state.complete(ready: false, current: allowed, fresh: allowed, epoch: state.generation))
        try check(!state.complete(ready: false, current: allowed, fresh: allowed, epoch: state.generation))
        try check(state.failures == 3 && !state.restarted && state.phase == .error)
        state.failed()
        try check(state.phase == .error)
        state.begin()
        try check(!state.restarted && state.failures == 0 && state.phase == .checking)
        let old = state.generation
        state.cancel()
        try check(!state.complete(ready: false, current: denied, fresh: allowed, epoch: old))
        try check(state.phase == .needsPermission && !state.restarted)
        state.begin()
        try check(!state.complete(ready: true, current: allowed, fresh: nil, epoch: old))
        try check(state.phase == .checking)
        return count
    }
    #endif
}

final class PermissionRestartGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var active: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func close() { lock.lock(); value = true; lock.unlock() }
}

final class PermissionProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Any] = ["phase": "not_checked", "ready": false]
    func read() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return value }
    func update(_ value: [String: Any]) { lock.lock(); self.value = value; lock.unlock() }
}

enum PermissionReadiness {
    static func check(allowPersistentCapture: Bool = false, windowID: CGWindowID? = nil) -> [String: Any] {
        guard allowPersistentCapture else {
            return ["ready": false, "captureMode": "persistent", "error": "capture_mode_selection_required"]
        }
        do {
            guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw NativeFailure("input_permission_required") }
            let app = AXUIElementCreateApplication(try NativeFocus.state().front)
            AXUIElementSetMessagingTimeout(app, 0.1)
            var role: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &role) == .success else { throw NativeFailure("accessibility_read_unavailable") }
            guard let windowID, windowID > 0 else { throw NativeFailure("permission_panel_unavailable") }
            let available = DispatchSemaphore(value: 0)
            var content: SCShareableContent?
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { found, _ in content = found; available.signal() }
            guard available.wait(timeout: .now() + 3) == .success,
                  let window = content?.windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == getpid() }) else {
                throw NativeFailure("permission_panel_capture_unavailable")
            }
            let configuration = SCStreamConfiguration()
            configuration.width = 300; configuration.height = 240
            configuration.showsCursor = false; configuration.capturesAudio = false
            configuration.ignoreShadowsSingleWindow = true
            let captured = DispatchSemaphore(value: 0)
            var received = false
            SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration) { image, error in
                received = image != nil && error == nil; captured.signal()
            }
            guard captured.wait(timeout: .now() + 3) == .success, received else { throw NativeFailure("permission_panel_capture_failed") }
            return ["ready": true, "captureMode": "persistent"]
        } catch {
            return ["ready": false, "captureMode": "persistent", "error": (error as? NativeFailure)?.code ?? "permission_check_failed"]
        }
    }
}

enum FreshPermissionProbe {
    static func read(executable: URL) -> PermissionFlags? {
        let process = Process()
        let output = Pipe()
        let done = DispatchSemaphore(value: 0)
        process.executableURL = executable
        process.arguments = ["--permission-probe"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in done.signal() }
        do { try process.run() } catch { return nil }
        guard done.wait(timeout: .now() + 2) == .success else {
            process.terminate()
            if done.wait(timeout: .now() + 0.2) != .success { kill(process.processIdentifier, SIGKILL) }
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard data.count <= 4096,
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              result["bundleId"] as? String == "com.rome.computer-use",
              result["implementationSha256"] as? String == NativeBuildIdentity.implementationSha256,
              let flags = result["permissions"] as? [String: Any],
              ["accessibility", "screenCapture", "postEvents", "inputMonitoring"].allSatisfy({ flags[$0] is Bool }) else { return nil }
        return PermissionFlags(flags)
    }
}

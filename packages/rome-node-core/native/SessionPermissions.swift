import AppKit
import ApplicationServices
import Foundation

struct PermissionGrants: Decodable, Sendable {
    let accessibility: Bool
    let screenRecording: Bool
}

struct PermissionChecks: Sendable {
    let missing: @Sendable () -> [String]
    let freshGrants: @Sendable () -> PermissionGrants?
    let openGuide: @Sendable (HelperLocale) -> Bool

    static let system = Self(missing: {
        var missing: [String] = []
        if !AXIsProcessTrusted() { missing.append("accessibility") }
        if !CGPreflightScreenCaptureAccess() { missing.append("screen_recording") }
        return missing
    }, freshGrants: { ScreenRecordingProbe.read() }, openGuide: { locale in
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let output = directory.appendingPathComponent("ready")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: directory) }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-n", "--stdout", output.path, "--stderr", "/dev/null", "-a", Bundle.main.bundlePath,
                                 "--args", "--setup-permissions", "all", "--locale", locale.rawValue]
            try process.run()
            let deadline = DispatchTime.now() + .seconds(3)
            repeat {
                if (try? Data(contentsOf: output)) == Data("ready\n".utf8) { return true }
                if !process.isRunning && process.terminationStatus != 0 { break }
                usleep(25_000)
            } while DispatchTime.now() < deadline
            if process.isRunning { process.terminate() }
        } catch {}
        return false
    })

    static let headless = Self(missing: { [] }, freshGrants: { nil }, openGuide: { _ in false })
}

final class SessionPermissions: @unchecked Sendable {
    private let checks: PermissionChecks
    private let locale: HelperLocale
    private let mayOpenGuide: Bool
    private let live: @Sendable () throws -> Void
    private let handoff: @Sendable () throws -> ExecutionHandoff
    private let end: @Sendable (String) -> Void
    // The queue orders revisions, the waiting reply, and guide launches. Stop must be
    // able to revoke the execution socket even while a fresh probe blocks this queue.
    private let queue = DispatchQueue(label: "rome.computer-use.permissions")
    private let socketLock = NSLock()
    private var child: ExecutionHandoff?
    private var closed = false
    private var missing: [String] = []
    private var guideOpened = false
    private var revision = 1
    private var deadline: DispatchTime = .distantFuture
    private var timer: DispatchSourceTimer?
    private var waiter: (([String: Any]) throws -> Void)?

    init(checks: PermissionChecks, locale: HelperLocale, mayOpenGuide: Bool, live: @escaping @Sendable () throws -> Void,
         handoff: @escaping @Sendable () throws -> ExecutionHandoff, end: @escaping @Sendable (String) -> Void) {
        self.checks = checks
        self.locale = locale
        self.mayOpenGuide = mayOpenGuide
        self.live = live
        self.handoff = handoff
        self.end = end
    }

    func start() throws -> [String: Any] {
        try queue.sync {
            try live()
            missing = checks.missing()
            if !missing.isEmpty {
                deadline = .now() + .seconds(300)
                guideOpened = mayOpenGuide && checks.openGuide(locale)
                try live()
            }
            return result
        }
    }

    func monitor() {
        queue.async { [self] in
            guard !missing.isEmpty else { return }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in self?.refresh() }
            timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(2))
            self.timer = timer
            timer.resume()
        }
    }

    func executor() throws -> ExecutionHandoff? {
        try queue.sync {
            guard missing.isEmpty else { throw Failure("needs_system_permission") }
            return try socketLock.withLock {
                guard !closed else { throw Failure("cancelled") }
                return child
            }
        }
    }

    private func openGuide() throws {
        try live()
        let opened = checks.openGuide(locale)
        if opened != guideOpened {
            guideOpened = opened
            try changed()
        }
    }

    func respond(_ request: Request, on connection: Connection) throws {
        try queue.sync {
            try live()
            if request.method == "open_permission_guide", mayOpenGuide, !missing.isEmpty {
                try openGuide()
            } else if let after = request.params?.afterRevision {
                guard after > 0, after <= revision else { throw Failure("invalid_request") }
                if after == revision {
                    guard waiter == nil else { throw Failure("busy") }
                    waiter = { try connection.send(Wire.reply(request.id, result: $0)) }
                    return
                }
            }
            try connection.send(Wire.reply(request.id, result: result))
        }
    }

    private var result: [String: Any] {
        if missing.isEmpty { return ["status": "authorized", "revision": revision] }
        return ["status": "needs_system_permission", "revision": revision, "missing": missing, "guideOpened": guideOpened]
    }

    private func changed() throws {
        revision += 1
        defer { waiter = nil }
        try waiter?(result)
    }

    private func refresh() {
        do {
            try live()
            guard DispatchTime.now() < deadline else { throw Failure("permissions_expired") }
            let next = try checkGrants()
            guard DispatchTime.now() < deadline else { throw Failure("permissions_expired") }
            guard next != missing else { return }
            missing = next
            if next.isEmpty { timer?.cancel() }
            try changed()
        } catch {
            timer?.cancel()
            end((error as? Failure)?.code ?? "cancelled")
        }
    }

    private func checkGrants() throws -> [String] {
        let local = checks.missing()
        guard local.contains("screen_recording"), let fresh = checks.freshGrants(), fresh.screenRecording else { return local }
        let current = checks.missing()
        guard current.contains("screen_recording") else { return current }
        guard fresh.accessibility, !current.contains("accessibility") else { return ["accessibility"] }
        try live()
        let execution = try handoff()
        do {
            try live()
            try socketLock.withLock {
                guard !closed else { throw Failure("cancelled") }
                child = execution
            }
        } catch {
            execution.stop()
            execution.waitForExit()
            throw error
        }
        return []
    }

    func stopExecution() {
        socketLock.withLock {
            closed = true
            child?.stop()
        }
    }

    func waitForExecutionExit() { socketLock.withLock { child }?.waitForExit() }

    func close() {
        let released = socketLock.withLock {
            closed = true
            let current = child
            child = nil
            return current
        }
        released?.stop()
        queue.sync {
            timer?.cancel()
            waiter = nil
        }
    }
}

import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

private final class ControlCaptureOutput: NSObject, SCStreamDelegate, SCStreamOutput {
    weak var owner: ControlCapture?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        owner?.stream(stream, didStopWithError: error)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        owner?.stream(stream, didOutputSampleBuffer: sampleBuffer, of: type)
    }
}

final class ControlCapture: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private struct Lifecycle {
        enum Phase { case idle, starting, running, stopping, stopped }
        enum Action { case none, stop, release }
        var phase = Phase.idle
        var intentionalStop = false
        var firstFrame = false
        var notified = false

        var ready: Bool { phase == .running && firstFrame && !intentionalStop }

        mutating func begin() -> Bool {
            guard phase == .idle, !intentionalStop else { return false }
            phase = .starting
            return true
        }

        mutating func submit() -> Bool {
            guard phase == .starting else { return false }
            if intentionalStop { phase = .stopped; return false }
            return true
        }

        mutating func started(success: Bool) -> Action {
            guard phase == .starting else { return success ? .stop : .release }
            guard success else { phase = .stopped; return .release }
            phase = intentionalStop ? .stopping : .running
            return intentionalStop ? .stop : .none
        }

        mutating func requestStop() -> Action {
            intentionalStop = true
            switch phase {
            case .idle: phase = .stopped; return .release
            case .starting: return .none
            case .running: phase = .stopping; return .stop
            case .stopping, .stopped: return .none
            }
        }

        mutating func ended() -> Bool {
            let notify = !intentionalStop && !notified && (phase == .starting || phase == .running)
            phase = .stopped
            notified = notified || notify
            return notify
        }
    }

    private let lock = NSLock()
    private let changed = DispatchSemaphore(value: 0)
    private let queue = DispatchQueue(label: "rome.computer-use.control-capture")
    private let output = ControlCaptureOutput()
    private let onStop: @Sendable () -> Void
    private var lifecycle = Lifecycle()
    private var failure: NativeFailure?
    private var capture: SCStream?
    private var stopConfirmed = false
    private var stopError: Int?
    private var startCallAt: Double?
    private var startReturnedAt: Double?
    private var startCallbackAt: Double?
    private var firstFrameAt: Double?

    var diagnostics: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var result: [String: Any] = ["phase": String(describing: lifecycle.phase), "firstFrame": lifecycle.firstFrame,
                                   "stopRequested": lifecycle.intentionalStop, "stopConfirmed": stopConfirmed]
        if let stopError { result["stopError"] = stopError }
        result["startCallAt"] = startCallAt as Any? ?? NSNull()
        result["startReturnedAt"] = startReturnedAt as Any? ?? NSNull()
        result["startCallbackAt"] = startCallbackAt as Any? ?? NSNull()
        result["firstFrameAt"] = firstFrameAt as Any? ?? NSNull()
        return result
    }

    convenience init(window: SCWindow, onStop: @escaping @Sendable () -> Void) throws {
        try self.init(filter: SCContentFilter(desktopIndependentWindow: window), onStop: onStop)
    }

    init(filter: SCContentFilter, onStop: @escaping @Sendable () -> Void) throws {
        guard CGPreflightScreenCaptureAccess() else { throw NativeFailure("screen_capture_permission_required") }
        self.onStop = onStop
        super.init()
        let width = Double(filter.contentRect.width) * Double(filter.pointPixelScale)
        let height = Double(filter.contentRect.height) * Double(filter.pointPixelScale)
        guard width.isFinite, height.isFinite, width > 0, height > 0 else {
            throw NativeFailure("control_capture_invalid_geometry")
        }
        let ratio = min(1, min(640 / width, 480 / height))
        let configuration = SCStreamConfiguration()
        configuration.width = max(2, Int(width * ratio) / 2 * 2)
        configuration.height = max(2, Int(height * ratio) / 2 * 2)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        if #available(macOS 14.2, *) { configuration.includeChildWindows = false }
        if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
        output.owner = self
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        capture = stream
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
    }

    // The caller keeps this object alive for the session and stops it on every terminal path.
    func start(check: () throws -> Void) throws {
        do { try check() }
        catch { stop(); throw error }
        guard CGPreflightScreenCaptureAccess() else {
            stop()
            throw NativeFailure("screen_capture_permission_required")
        }
        lock.lock()
        let accepted = lifecycle.begin()
        lock.unlock()
        guard accepted else { throw NativeFailure("control_capture_start_reused") }
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let submit = self.lifecycle.submit()
            let stream = self.capture
            self.lock.unlock()
            guard let stream else { return }
            guard submit else { self.release(stream); return }
            self.lock.lock(); self.startCallAt = ProcessInfo.processInfo.systemUptime; self.lock.unlock()
            stream.startCapture { [weak self, weak stream] error in
                guard let stream else { return }
                guard let self else { stream.stopCapture(); return }
                self.started(stream, error: error)
            }
            self.lock.lock(); self.startReturnedAt = ProcessInfo.processInfo.systemUptime; self.lock.unlock()
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        do {
            while true {
                try check()
                lock.lock()
                let ready = lifecycle.ready
                let stopped = lifecycle.intentionalStop || lifecycle.phase == .stopped
                let error = failure
                lock.unlock()
                if let error { throw error }
                if ready { try check(); return }
                if stopped { throw NativeFailure("control_capture_stopped") }
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw NativeFailure("control_capture_start_unconfirmed", details: diagnostics) }
                _ = changed.wait(timeout: .now() + min(0.04, remaining))
            }
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        lock.lock()
        let action = lifecycle.requestStop()
        let stream = capture
        lock.unlock()
        changed.signal()
        if let stream { perform(action, stream: stream) }
    }

    private func started(_ stream: SCStream, error: Error?) {
        lock.lock()
        startCallbackAt = ProcessInfo.processInfo.systemUptime
        if let error {
            failure = NativeFailure("control_capture_start_failed", details: ["code": (error as NSError).code])
        }
        let action = lifecycle.started(success: error == nil)
        lock.unlock()
        changed.signal()
        perform(action, stream: stream)
    }

    private func perform(_ action: Lifecycle.Action, stream: SCStream) {
        switch action {
        case .none: return
        case .release: queue.async { [weak self] in self?.release(stream) }
        case .stop:
            queue.async { [weak self, stream] in
                stream.stopCapture { [weak self, weak stream] error in
                    guard let self, let stream else { return }
                    self.lock.lock()
                    self.lifecycle.phase = .stopped
                    self.stopConfirmed = self.stopConfirmed || error == nil
                    self.stopError = (error as NSError?)?.code
                    self.lock.unlock()
                    self.changed.signal()
                    self.queue.async { [weak self] in self?.release(stream) }
                }
            }
        }
    }

    private func release(_ stream: SCStream) {
        lock.lock()
        if capture === stream {
            capture = nil
            // A cancelled start or failed start callback also reaches stopped
            // without a stopCapture callback. Keep an actual stop error unconfirmed.
            if lifecycle.phase == .stopped && stopError == nil { stopConfirmed = true }
        }
        lock.unlock()
        try? stream.removeStreamOutput(output, type: .screen)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        guard capture === stream else { lock.unlock(); return }
        let notify = lifecycle.ended()
        stopConfirmed = true
        failure = NativeFailure("control_capture_stopped", details: ["code": (error as NSError).code])
        lock.unlock()
        changed.signal()
        perform(.release, stream: stream)
        if notify { onStop() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer),
              CMSampleBufferGetImageBuffer(sampleBuffer) != nil,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        lock.lock()
        if capture === stream, lifecycle.phase == .starting || lifecycle.phase == .running {
            lifecycle.firstFrame = true
            if firstFrameAt == nil { firstFrameAt = ProcessInfo.processInfo.systemUptime }
        }
        lock.unlock()
        changed.signal()
    }

    deinit {
        let stream = capture
        let output = output
        queue.async {
            guard let stream else { return }
            try? stream.removeStreamOutput(output, type: .screen)
            stream.stopCapture()
        }
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var assertions = 0
        func check(_ value: @autoclosure () -> Bool) throws {
            guard value() else { throw NativeFailure("self_check_failed", "Control capture lifecycle check failed.") }
            assertions += 1
        }
        var normal = Lifecycle()
        try check(normal.begin() && normal.submit())
        normal.firstFrame = true
        try check(!normal.ready)
        try check(normal.started(success: true) == .none && normal.ready)
        try check(!normal.begin())
        try check(normal.requestStop() == .stop && !normal.ready)
        try check(normal.requestStop() == .none && !normal.ended())

        var cancelled = Lifecycle()
        try check(cancelled.requestStop() == .release && !cancelled.begin())
        var queued = Lifecycle()
        try check(queued.begin() && queued.requestStop() == .none && !queued.submit())
        try check(queued.phase == .stopped && !queued.ended())
        var pending = Lifecycle()
        try check(pending.begin() && pending.submit() && pending.requestStop() == .none)
        try check(pending.started(success: true) == .stop && !pending.ready)
        try check(!pending.ended())

        var failed = Lifecycle()
        try check(failed.begin() && failed.started(success: false) == .release && !failed.ready)
        try check(!failed.ended())
        var unexpected = Lifecycle()
        try check(unexpected.begin() && unexpected.submit())
        try check(unexpected.ended() && !unexpected.ended())
        try check(unexpected.started(success: true) == .stop && !unexpected.ready)
        var waiting = Lifecycle()
        try check(waiting.begin() && waiting.started(success: true) == .none && !waiting.ready)
        waiting.firstFrame = true
        try check(waiting.ready && waiting.ended() && !waiting.ended())
        return assertions
    }
    #endif
}

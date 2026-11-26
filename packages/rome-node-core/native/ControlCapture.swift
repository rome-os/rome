import CoreMedia
import Foundation
import ScreenCaptureKit

protocol ControlCapture {
    var isActive: Bool { get }
    func start(check: () throws -> Void) throws
    func whileActive<T>(_ body: () throws -> T) throws -> T
    func stop()
}

// Output serializes start completion, frame updates and revocation. Only the
// successful start path can issue a stop request, and it issues at most one.
final class ScreenControlCapture: ControlCapture, @unchecked Sendable {
    final class Output: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
        private let lock = NSLock()
        private var started = false
        private var ended = false
        private var frame: CVPixelBuffer?
        private let onEnd: @Sendable () -> Void

        init(onEnd: @escaping @Sendable () -> Void) { self.onEnd = onEnd }

        var hasEnded: Bool { lock.withLock { ended } }
        var latestFrame: CVPixelBuffer? { lock.withLock { started && !ended ? frame : nil } }

        // Dispatch and delegate revocation share the lock to order their final checks.
        func whileActive<T>(_ body: () throws -> T) throws -> T {
            try lock.withLock {
                guard started, !ended, frame != nil else { throw Failure("binding_unavailable") }
                return try body()
            }
        }

        // A successful start that completes after revocation still needs stopCapture.
        func didStart() -> Bool {
            lock.withLock {
                if ended { return false }
                started = true
                return true
            }
        }

        func end(notify: Bool) -> Bool {
            let wasStarted: Bool? = lock.withLock {
                guard !ended else { return nil }
                ended = true
                frame = nil
                return started
            }
            if notify, wasStarted != nil { onEnd() }
            return wasStarted == true
        }

        func stream(_ stream: SCStream, didStopWithError error: Error) {
            _ = end(notify: true)
        }

        func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
            guard type == .screen, CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
                  let image = CMSampleBufferGetImageBuffer(sample),
                  let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                    as? [[SCStreamFrameInfo: Any]])?.first,
                  info[.status] as? Int == SCFrameStatus.complete.rawValue else { return }
            lock.withLock {
                if !ended { frame = image }
            }
        }
    }

    private let output: Output
    private let stream: SCStream
    private let controlQueue = DispatchQueue(label: "rome.computer-use.capture-control")

    init(filter: SCContentFilter, onEnd: @escaping @Sendable () -> Void) throws {
        let output = Output(onEnd: onEnd)
        let config = try Self.configuration(rect: filter.contentRect, pixelScale: Double(filter.pointPixelScale))
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "rome.computer-use.capture-frames"))
        self.output = output
        self.stream = stream
    }

    static func configuration(rect: CGRect, pixelScale: Double) throws -> SCStreamConfiguration {
        guard validBounds(rect), pixelScale.isFinite, pixelScale > 0 else { throw Failure("capture_limit") }
        let scale = min(pixelScale, 640 / rect.width, 480 / rect.height)
        let config = SCStreamConfiguration()
        config.width = max(2, Int(rect.width * scale) / 2 * 2)
        config.height = max(2, Int(rect.height * scale) / 2 * 2)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        config.showsCursor = false
        config.capturesAudio = false
        config.ignoreShadowsSingleWindow = true
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        if #available(macOS 15.0, *) { config.captureMicrophone = false }
        return config
    }

    var latestFrame: CVPixelBuffer? { output.latestFrame }
    var isActive: Bool { latestFrame != nil }

    func start(check: () throws -> Void) throws {
        let ready = DispatchSemaphore(value: 0)
        controlQueue.async { [self] in
            guard !output.hasEnded else { ready.signal(); return }
            stream.startCapture { [self] error in
                if error == nil {
                    if !output.didStart() { stream.stopCapture() }
                } else {
                    _ = output.end(notify: true)
                }
                ready.signal()
            }
        }

        let deadline = DispatchTime.now() + .seconds(3)
        while ready.wait(timeout: .now() + .milliseconds(25)) == .timedOut {
            try check()
            guard DispatchTime.now() < deadline else { throw Failure("capture_failed") }
        }
        while !isActive {
            try check()
            guard !output.hasEnded, DispatchTime.now() < deadline else { throw Failure("capture_failed") }
            Thread.sleep(forTimeInterval: 0.025)
        }
    }

    func whileActive<T>(_ body: () throws -> T) throws -> T {
        try output.whileActive(body)
    }

    func stop() {
        guard output.end(notify: false) else { return }
        stream.stopCapture()
    }

    deinit { stop() }
}

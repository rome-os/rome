import AppKit
import CoreGraphics
import simd

private final class PointerWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class PointerRequest: @unchecked Sendable {
    let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var cancelled = false
    private var signalled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func finish(cancel: Bool = false) {
        lock.lock()
        cancelled = cancelled || cancel
        let signal = !signalled
        signalled = true
        lock.unlock()
        if signal { done.signal() }
    }
}

private struct PointerPalette {
    static let ember = NSColor(srgbRed: 216/255, green: 111/255, blue: 76/255, alpha: 1)
    private var occupied: [String: NSColor] = [:]

    mutating func reserve(_ session: String) -> NSColor {
        if let assigned = occupied[session] { return assigned }
        var color = Self.ember
        if occupied.values.contains(Self.ember) {
            let neighbors = occupied.values.map(Self.lab)
            var bestDistance = -Double.infinity
            for sector in 0..<48 {
                let hue = (Double(sector) + Double.random(in: 0..<1)) / 48
                let candidate = NSColor(hue: hue, saturation: .random(in: 0.55...0.85),
                                        brightness: .random(in: 0.58...0.84), alpha: 1)
                let lab = Self.lab(candidate)
                let distance = neighbors.map { simd_distance_squared($0, lab) }.min()!
                if distance > bestDistance { color = candidate; bestDistance = distance }
            }
        }
        occupied[session] = color
        return color
    }

    mutating func release(_ session: String) { occupied.removeValue(forKey: session) }

    // ColorSync supplies Lab coordinates for the display-independent sRGB swatches.
    private static let labSpace = CGColorSpace(name: CGColorSpace.genericLab)!
    static func lab(_ color: NSColor) -> SIMD3<Double> {
        let lab = color.cgColor.converted(to: labSpace, intent: .relativeColorimetric, options: nil)!.components!
        return SIMD3(Double(lab[0]), Double(lab[1]), Double(lab[2]))
    }
}

private final class PointerView: NSView {
    static let badge = CGRect(x: 17, y: 0, width: 19, height: 16)
    static let robot = Bundle.main.url(forResource: "pointer-robot", withExtension: "svg").flatMap(NSImage.init(contentsOf:))
    var point = CGPoint.zero
    var trail: [CGPoint] = []
    var feedback = 1.0
    var ink = PointerPalette.ember
    var feedbackInk: NSColor?
    var rotation = 0.0
    var visibleRegions: [CGRect] = []
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(bounds)
        guard !visibleRegions.isEmpty else { return }
        context.saveGState()
        defer { context.restoreGState() }
        context.clip(to: visibleRegions)
        if trail.count > 1 {
            let line = NSBezierPath()
            line.move(to: trail[0])
            for p in trail.dropFirst() { line.line(to: p) }
            ink.withAlphaComponent(0.2).setStroke()
            line.lineWidth = 3
            line.lineCapStyle = .round
            line.stroke()
        }
        if feedback < 1 {
            (feedbackInk ?? ink).withAlphaComponent((1 - feedback) * 0.5).setStroke()
            let radius = 7 + 24 * feedback
            let ring = NSBezierPath(ovalIn: NSRect(x: point.x-radius, y: point.y-radius, width: radius*2, height: radius*2))
            ring.lineWidth = 2
            ring.stroke()
        }
        context.translateBy(x: point.x, y: point.y)
        context.rotate(by: rotation)
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 4.8, y: 1.2))
        arrow.curve(to: NSPoint(x: 1.0, y: 4.6), controlPoint1: NSPoint(x: 2.0, y: -0.1), controlPoint2: NSPoint(x: 0.3, y: 1.4))
        arrow.line(to: NSPoint(x: 2.7, y: 12.1))
        arrow.curve(to: NSPoint(x: 7.1, y: 13.0), controlPoint1: NSPoint(x: 3.4, y: 15.3), controlPoint2: NSPoint(x: 5.6, y: 15.6))
        arrow.line(to: NSPoint(x: 8.4, y: 10.8))
        arrow.curve(to: NSPoint(x: 10.2, y: 9.2), controlPoint1: NSPoint(x: 8.9, y: 9.9), controlPoint2: NSPoint(x: 9.3, y: 9.5))
        arrow.line(to: NSPoint(x: 12.7, y: 8.3))
        arrow.curve(to: NSPoint(x: 13.0, y: 4.8), controlPoint1: NSPoint(x: 15.3, y: 7.4), controlPoint2: NSPoint(x: 15.5, y: 5.9))
        arrow.close()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.30)
        shadow.shadowBlurRadius = 5.5
        shadow.shadowOffset = NSSize(width: 0, height: -3.5)
        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        NSColor(calibratedWhite: 0.42, alpha: 1).setFill()
        arrow.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSGradient(colors: [NSColor(calibratedRed: 0.55, green: 0.57, blue: 0.64, alpha: 1),
                            NSColor(calibratedRed: 0.32, green: 0.33, blue: 0.38, alpha: 1)])?.draw(in: arrow, angle: 75)
        NSColor(calibratedWhite: 0.98, alpha: 1).setStroke()
        arrow.lineWidth = 1.4
        arrow.lineJoinStyle = .round
        arrow.stroke()
        ink.setFill()
        NSBezierPath(roundedRect: Self.badge, xRadius: 5, yRadius: 5).fill()
        Self.robot?.draw(in: Self.badge.insetBy(dx: 3.75, dy: 2.6), from: .zero,
                         operation: .sourceOver, fraction: 0.65, respectFlipped: true, hints: nil)
    }
}

// All AppKit state stays on the main queue. Workers wait only for bounded visual movement.
final class VirtualPointer: @unchecked Sendable {
    private static var palette = PointerPalette()
    private var window: PointerWindow?
    private var view: PointerView?
    private var timer: Timer?
    private var frameInterval = 0.0
    private var observers: [NSObjectProtocol] = []
    private var motion: PointerMotion?
    private var motionSequence: UInt64 = 0
    private var request: PointerRequest?
    private var sessionID: String?
    private var targetID: CGWindowID = 0
    private var targetPID: pid_t = 0
    private var targetBounds = CGRect.zero
    private var active: (() -> Bool)?
    private var point = CGPoint.zero
    private var feedbackAt: Double?
    private var followingUntil = 0.0
    private var thinkingAt = Double.infinity
    private var layerCheckAt = 0.0
    private var nextOrderAttempt = 0.0
    private var lastInteraction = 0.0
    private var layerReady = false
    private var reading = false
    private var reduceMotion = false
    private let diagnosticLock = NSLock()
    private var state: [String: Any] = ["visible": false]

    var diagnostics: [String: Any] {
        diagnosticLock.lock()
        defer { diagnosticLock.unlock() }
        return state
    }

    func indicateRead(sessionID: String, pid: pid_t, windowID: CGWindowID, bounds: CGRect, active: @escaping () -> Bool) {
        DispatchQueue.main.async {
            guard active(), self.motion == nil, ProcessInfo.processInfo.systemUptime >= self.followingUntil else { return }
            if self.sessionID == sessionID, self.targetID == windowID, self.targetBounds == bounds {
                self.reading = true
                self.lastInteraction = ProcessInfo.processInfo.systemUptime
                self.layerCheckAt = 0
                self.frame()
            } else {
                let initial = CGPoint(x: bounds.width / 2, y: bounds.height / 2)
                self.present(sessionID: sessionID, pid: pid, windowID: windowID, bounds: bounds,
                             destination: initial, active: active, pending: PointerRequest(), reading: true)
            }
        }
    }

    func move(sessionID: String, pid: pid_t, windowID: CGWindowID, bounds: CGRect,
              destination: CGPoint, active: @escaping () -> Bool, check: () throws -> Void) throws {
        let pending = PointerRequest()
        DispatchQueue.main.async {
            guard !pending.isCancelled, active() else { pending.finish(cancel: true); return }
            self.present(sessionID: sessionID, pid: pid, windowID: windowID, bounds: bounds,
                         destination: destination, active: active, pending: pending)
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        do {
            while pending.done.wait(timeout: .now() + 0.04) != .success {
                try check()
                if ProcessInfo.processInfo.systemUptime >= deadline {
                    pending.finish(cancel: true)
                    break
                }
            }
            try check()
        } catch {
            pending.finish(cancel: true)
            throw error
        }
    }

    func feedback(sessionID: String, verified: Bool? = nil) {
        DispatchQueue.main.async {
            guard self.sessionID == sessionID, self.active?() == true else { return }
            let now = ProcessInfo.processInfo.systemUptime
            self.motion = nil
            self.followingUntil = 0
            self.feedbackAt = self.reduceMotion ? nil : now
            self.thinkingAt = now + (self.reduceMotion ? 0 : 0.35)
            self.view?.feedbackInk = verified.map { $0 ? .systemGreen : .systemOrange }
            self.frame()
        }
    }

    // A held drag supplies the same sampled path to event dispatch and presentation.
    func follow(sessionID: String, pid: pid_t, windowID: CGWindowID, bounds: CGRect,
                position: CGPoint, active: @escaping () -> Bool) {
        DispatchQueue.main.async {
            guard active(), position.x.isFinite, position.y.isFinite,
                  position.x >= 0, position.y >= 0, position.x < bounds.width, position.y < bounds.height else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if self.sessionID != sessionID || self.targetID != windowID || self.targetPID != pid || self.targetBounds != bounds {
                self.present(sessionID: sessionID, pid: pid, windowID: windowID, bounds: bounds,
                             destination: position, active: active, pending: PointerRequest(), externallySampled: true)
            }
            guard self.sessionID == sessionID, self.targetID == windowID else { return }
            self.request?.finish()
            self.motion = nil
            self.active = active
            self.reading = false
            self.point = position
            self.followingUntil = now + 0.12
            self.feedbackAt = nil
            self.thinkingAt = now + (self.reduceMotion ? 0 : 0.35)
            if !self.reduceMotion {
                self.view?.trail.append(position)
                if (self.view?.trail.count ?? 0) > 7 { self.view?.trail.removeFirst() }
            }
            self.frame()
        }
    }

    func hide(sessionID: String? = nil) {
        DispatchQueue.main.async {
            if sessionID == nil || self.sessionID == sessionID { self.dismiss() }
        }
    }

    static func appKitFrame(_ quartz: CGRect, primaryTop: CGFloat) -> CGRect {
        CGRect(x: quartz.minX, y: primaryTop - quartz.maxY, width: quartz.width, height: quartz.height)
    }

    private func publish(_ visible: Bool, phase: String = "hidden") {
        diagnosticLock.lock()
        state = ["visible": visible, "phase": phase, "windowId": window?.windowNumber ?? 0,
                 "targetWindowId": targetID, "level": 0, "lastInteractionUptime": lastInteraction,
                 "positionWindowPoints": [Double(point.x), Double(point.y)],
                 "opacity": view?.alphaValue ?? 0, "rotationDegrees": (view?.rotation ?? 0) * 180 / .pi,
                 "ignoresMouseEvents": true, "canBecomeKey": false]
        diagnosticLock.unlock()
    }

    private func present(sessionID: String, pid: pid_t, windowID: CGWindowID, bounds: CGRect,
                         destination: CGPoint, active: @escaping () -> Bool, pending: PointerRequest,
                         externallySampled: Bool = false, reading: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        let local = CGRect(origin: .zero, size: bounds.size)
        let sameTarget = self.sessionID == sessionID && targetID == windowID && targetBounds == bounds
        let previous = motion?.sample(at: now).position ?? point
        let retained = CGPoint(x: min(max(previous.x, 0), max(0, bounds.width - 1)),
                               y: min(max(previous.y, 0), max(0, bounds.height - 1)))
        let start = externallySampled ? destination : self.sessionID == sessionID ? retained : destination
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        motionSequence &+= 1
        let nextMotion = sameTarget && !externallySampled ? try? motion?.retarget(to: destination, at: now, reduceMotion: reduceMotion, variation: motionSequence) : nil
        guard let next = nextMotion ?? (try? PointerMotion(start: start, destination: destination, bounds: local,
                                            startedAt: now, reduceMotion: reduceMotion, variation: motionSequence)) else {
            pending.finish(cancel: true)
            return
        }
        request?.finish(cancel: true)
        if !sameTarget {
            view?.alphaValue = 0
            view?.needsDisplay = true
            view?.displayIfNeeded()
        }
        request = pending
        self.sessionID = sessionID
        targetID = windowID
        targetPID = pid
        targetBounds = bounds
        self.active = active
        self.reading = reading
        motion = externallySampled || reading ? nil : next
        followingUntil = externallySampled ? now + 0.12 : 0
        point = next.start
        feedbackAt = nil
        thinkingAt = reading ? now - 0.35 : now + next.duration
        lastInteraction = now
        if !sameTarget { layerReady = false }
        if window == nil {
            let panel = PointerWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
            panel.title = "Rome Virtual Pointer"
            panel.level = .normal
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.isExcludedFromWindowsMenu = true
            panel.isReleasedWhenClosed = false
            panel.animationBehavior = .none
            panel.collectionBehavior = [.transient, .ignoresCycle]
            let content = PointerView(frame: .zero)
            content.wantsLayer = true
            content.alphaValue = 0
            content.layer?.masksToBounds = true
            content.setAccessibilityElement(false)
            panel.contentView = content
            window = panel
            view = content
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification,
                object: nil, queue: .main) { [weak self] _ in self?.refreshLayout() })
            observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                object: nil, queue: .main) { [weak self] _ in self?.refreshLayout() })
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
                object: nil, queue: .main) { [weak self] _ in
                    guard let self else { return }
                    self.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                    if self.reduceMotion {
                        if let motion = self.motion {
                            self.motion = try? motion.retarget(to: motion.destination, at: ProcessInfo.processInfo.systemUptime, reduceMotion: true)
                        }
                        self.view?.trail = []
                        self.feedbackAt = nil
                    }
                    if self.active != nil { self.frame() }
                })
        }
        view?.trail = []
        view?.ink = Self.palette.reserve(sessionID)
        view?.feedbackInk = nil
        layerCheckAt = 0
        frame()
    }

    private func refreshLayout() {
        layerCheckAt = 0
        frame()
    }

    private func clearSurface() {
        layerReady = false
        view?.alphaValue = 0
        view?.visibleRegions = []
        view?.needsDisplay = true
        view?.displayIfNeeded()
    }

    private func updateLayer() -> Bool {
        guard let window, let primaryTop = NSScreen.screens.first?.frame.maxY,
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]],
              let target = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == targetID }),
              (target[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == targetPID,
              (target[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let raw = target[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds == targetBounds else { return false }
        let frame = Self.appKitFrame(bounds, primaryTop: primaryTop)
        if window.frame != frame { window.setFrame(frame, display: true) }
        let normal = rows.filter { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
        let numbers = normal.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
        let owners = normal.compactMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value }
        guard numbers.count == normal.count, owners.count == normal.count else { return false }
        let group = Self.groupOccluders(numbers, owners: owners, overlay: window.windowNumber,
                                        target: Int(targetID), targetPID: targetPID, overlayPID: getpid())
        if group != nil {
            // Elevated surfaces can span an entire display with transparent pixels, as during screen recording.
            // WindowServer composites those surfaces above the normal-level pointer.
            let exposed = exposedReadRegions(rows: normal, bounds: bounds)
            if reading, let anchor = Self.readAnchor(point, in: exposed) { point = anchor }
            view?.visibleRegions = exposed
            layerReady = true
        } else {
            // AppKit commits window ordering asynchronously. Only paint after WindowServer confirms it.
            clearSurface()
            let now = ProcessInfo.processInfo.systemUptime
            if now >= nextOrderAttempt {
                if !window.isVisible { window.orderFrontRegardless() }
                window.order(.above, relativeTo: Int(targetID))
                nextOrderAttempt = now + 0.2
            }
        }
        return true
    }

    // WindowServer keeps attached title-bar surfaces with their parent. Clip them out of the pointer plane.
    static func groupOccluders(_ frontToBack: [Int], owners: [pid_t], overlay: Int, target: Int, targetPID: pid_t, overlayPID: pid_t) -> Range<Int>? {
        guard owners.count == frontToBack.count, overlay > 0, target > 0,
              let own = frontToBack.firstIndex(of: overlay), let bound = frontToBack.firstIndex(of: target),
              own < bound, owners[own] == overlayPID, owners[bound] == targetPID else { return nil }
        let between = (own+1)..<bound
        guard between.allSatisfy({ owners[$0] == targetPID }) else { return nil }
        return between
    }

    static func visibleRegions(in bounds: CGRect, occluders: [CGRect]) -> [CGRect]? {
        var regions = [bounds]
        for cover in occluders {
            var next: [CGRect] = []
            for region in regions {
                let hit = region.intersection(cover)
                if hit.isNull || hit.isEmpty { next.append(region) }
                else { for rect in [CGRect(x: region.minX, y: region.minY, width: region.width, height: hit.minY-region.minY),
                             CGRect(x: region.minX, y: hit.maxY, width: region.width, height: region.maxY-hit.maxY),
                             CGRect(x: region.minX, y: hit.minY, width: hit.minX-region.minX, height: hit.height),
                             CGRect(x: hit.maxX, y: hit.minY, width: region.maxX-hit.maxX, height: hit.height)] where !rect.isEmpty { next.append(rect) } }
                guard next.count <= 256 else { return nil }
            }
            regions = next
        }
        return regions
    }

    private func exposedReadRegions(rows: [[String: Any]], bounds: CGRect) -> [CGRect] {
        guard let index = rows.firstIndex(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == targetID }) else { return [] }
        var occluders: [CGRect] = []
        for row in rows[..<index] {
            if (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue == 0 { continue }
            if (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid(),
               let number = (row[kCGWindowNumber as String] as? NSNumber)?.intValue,
               NSApp.window(withWindowNumber: number) is PointerWindow { continue }
            guard let raw = row[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return [] }
            if rect.intersects(bounds) { occluders.append(rect) }
        }
        return NSScreen.screens.flatMap { screen -> [CGRect] in
            guard let display = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return [] }
            let visible = bounds.intersection(CGDisplayBounds(display.uint32Value))
            guard !visible.isEmpty else { return [] }
            return (Self.visibleRegions(in: visible, occluders: occluders) ?? []).map {
                $0.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
            }
        }
    }

    static func readAnchor(_ current: CGPoint, in regions: [CGRect]) -> CGPoint? {
        let footprint = CGSize(width: PointerView.badge.maxX, height: PointerView.badge.height)
        if regions.contains(where: { $0.contains(current) }) { return current }
        func fits(_ rect: CGRect) -> Bool { rect.width >= footprint.width && rect.height >= footprint.height }
        guard let best = regions.max(by: { a, b in
            fits(a) == fits(b) ? a.width * a.height < b.width * b.height : !fits(a)
        }) else { return nil }
        return CGPoint(x: best.minX + max(0, (best.width - footprint.width) / 2),
                       y: best.minY + max(0, (best.height - footprint.height) / 2))
    }

    static func idleStyle(elapsed: Double, reduceMotion: Bool) -> (opacity: Double, rotation: Double) {
        guard elapsed >= 0 else { return (1, 0) }
        guard elapsed.isFinite else { return (0.45, 0) }
        if reduceMotion { return (0.45, 0) }
        let progress = min(1, elapsed / 0.35)
        let eased = progress * progress * (3 - 2 * progress)
        return (0.45 + 0.55 * (1 - eased), sin(elapsed * 2 * .pi / 1.8) * 7 * .pi / 180 * eased)
    }

    private func setFrameInterval(_ interval: Double) {
        guard timer == nil || frameInterval != interval else { return }
        timer?.invalidate()
        frameInterval = interval
        let tick = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.frame() }
        RunLoop.main.add(tick, forMode: .common)
        timer = tick
    }

    private func frame() {
        guard active?() == true else { dismiss(); return }
        let now = ProcessInfo.processInfo.systemUptime
        if now - layerCheckAt >= 0.05 {
            layerCheckAt = now
            if !updateLayer() { clearSurface(); if window?.isVisible == true { window?.orderOut(nil) } }
        }
        if request?.isCancelled == true {
            request = nil
            motion = nil
            thinkingAt = now - 0.35
        }
        if let motion {
            let sample = motion.sample(at: now)
            point = sample.position
            if !reduceMotion {
                view?.trail.append(point)
                if (view?.trail.count ?? 0) > 7 { view?.trail.removeFirst() }
            }
            if sample.finished { self.motion = nil; request?.finish(); view?.trail = [] }
        }
        let following = now < followingUntil
        if motion == nil && !following { view?.trail = [] }
        let thinking = motion == nil && !following && now >= thinkingAt
        let style = Self.idleStyle(elapsed: motion == nil && !following ? now - thinkingAt : -1, reduceMotion: reduceMotion)
        view?.point = point
        view?.feedback = feedbackAt.map { min(1, (now-$0)/0.35) } ?? 1
        let painted = layerReady && view?.visibleRegions.isEmpty == false
        view?.alphaValue = painted ? style.opacity : 0
        view?.rotation = style.rotation
        view?.needsDisplay = true
        let animating = motion != nil || painted && (following || (view?.feedback ?? 1) < 1 || thinking && !reduceMotion)
        setFrameInterval(animating ? thinking ? 1.0/30 : 1.0/60 : 0.1)
        let phase: String
        if !layerReady { phase = "ordering" }
        else if !painted { phase = "covered" }
        else if motion != nil || following { phase = "moving" }
        else if thinking { phase = "thinking" }
        else { phase = feedbackAt == nil ? "ready" : "feedback" }
        publish(painted, phase: phase)
    }

    private func dismiss() {
        request?.finish(cancel: true)
        request = nil
        motion = nil
        followingUntil = 0
        active = nil
        if let sessionID { Self.palette.release(sessionID) }
        sessionID = nil
        layerReady = false
        timer?.invalidate()
        timer = nil
        window?.orderOut(nil)
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        window = nil
        view?.trail = []
        view?.alphaValue = 0
        view?.rotation = 0
        view = nil
        publish(false)
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var palette = PointerPalette()
        let colors = (0..<6).map { palette.reserve(String($0)) }
        let labs = colors.map(PointerPalette.lab)
        guard colors[0] == PointerPalette.ember, colors[3] == palette.reserve("3"),
              labs.indices.allSatisfy({ i in labs[..<i].allSatisfy { simd_distance($0, labs[i]) >= 20 } }),
              PointerView.robot?.isValid == true else {
            throw NativeFailure("self_check_failed", "Pointer session colors or bundled robot icon failed.")
        }
        palette.release("0")
        guard palette.reserve("next") == PointerPalette.ember, palette.reserve("3") == colors[3] else {
            throw NativeFailure("self_check_failed", "Releasing a pointer changed another session's color.")
        }
        guard groupOccluders([9, 2, 1, 8], owners: [8, 7, 6, 5], overlay: 2, target: 1, targetPID: 6, overlayPID: 7)?.isEmpty == true,
              groupOccluders([2, 9, 1], owners: [7, 6, 6], overlay: 2, target: 1, targetPID: 6, overlayPID: 7) == 1..<2,
              groupOccluders([2, 9, 1], owners: [7, 8, 6], overlay: 2, target: 1, targetPID: 6, overlayPID: 7) == nil,
              groupOccluders([1, 2], owners: [6, 7], overlay: 2, target: 1, targetPID: 6, overlayPID: 7) == nil,
              groupOccluders([1], owners: [6], overlay: 0, target: 1, targetPID: 6, overlayPID: 7) == nil,
              groupOccluders([2, 1], owners: [9, 6], overlay: 2, target: 1, targetPID: 6, overlayPID: 7) == nil,
              groupOccluders([2, 1], owners: [7], overlay: 2, target: 1, targetPID: 6, overlayPID: 7) == nil,
              appKitFrame(CGRect(x: -50, y: -1080, width: 600, height: 400), primaryTop: 982)
                == CGRect(x: -50, y: 1662, width: 600, height: 400) else {
            throw NativeFailure("self_check_failed", "Virtual pointer layer or coordinate check failed.")
        }
        let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        let strip = CGRect(x: 150, y: 0, width: 20, height: 300)
        guard readAnchor(CGPoint(x: 8, y: 10), in: [bounds, strip]) == CGPoint(x: 8, y: 10),
              readAnchor(CGPoint(x: 90, y: 80), in: [bounds, strip]) == CGPoint(x: 90, y: 80),
              readAnchor(.zero, in: [strip]) == CGPoint(x: 150, y: 142),
              readAnchor(.zero, in: []) == nil else {
            throw NativeFailure("self_check_failed", "Virtual pointer read position is outside the exposed area.")
        }
        let covers = [CGRect(x: 20, y: 20, width: 60, height: 60), CGRect(x: 40, y: 40, width: 60, height: 60)]
        guard let regions = visibleRegions(in: bounds, occluders: covers),
              regions.allSatisfy({ region in bounds.contains(region) && covers.allSatisfy({ region.intersection($0).isEmpty }) }),
              abs(regions.reduce(0) { $0 + $1.width*$1.height } - 4400) < 0.001,
              regions.contains(where: { $0.contains(CGPoint(x: 10, y: 10)) }),
              !regions.contains(where: { $0.contains(CGPoint(x: 50, y: 50)) }),
              visibleRegions(in: bounds, occluders: [bounds])?.isEmpty == true else {
            throw NativeFailure("self_check_failed", "Virtual pointer clipping check failed.")
        }
        let pending = PointerRequest()
        pending.finish()
        pending.finish(cancel: true)
        let strips = (0..<256).map { CGRect(x: $0*3+1, y: 0, width: 1, height: 100) }
        guard pending.isCancelled, pending.done.wait(timeout: .now()) == .success,
              pending.done.wait(timeout: .now()) == .timedOut,
              visibleRegions(in: CGRect(x: 0, y: 0, width: 1000, height: 100), occluders: strips) == nil,
              visibleRegions(in: CGRect(x: 0, y: 0, width: 1000, height: 100), occluders: Array(strips.reversed())) == nil else {
            throw NativeFailure("self_check_failed", "Virtual pointer cancellation or clipping budget failed.")
        }
        let before = idleStyle(elapsed: -0.01, reduceMotion: false)
        let start = idleStyle(elapsed: 0, reduceMotion: false)
        let transition = idleStyle(elapsed: 0.175, reduceMotion: false)
        let positive = idleStyle(elapsed: 0.45, reduceMotion: false)
        let negative = idleStyle(elapsed: 1.35, reduceMotion: false)
        let reduced = idleStyle(elapsed: 1.35, reduceMotion: true)
        let idle = (0...360).map { idleStyle(elapsed: Double($0)/60, reduceMotion: false) }
        guard before.opacity == 1, before.rotation == 0, start.opacity == 1, start.rotation == 0,
              transition.opacity < 1, transition.opacity > 0.45,
              positive.opacity == 0.45, negative.opacity == 0.45,
              abs(positive.rotation - 7 * .pi / 180) < 1e-12,
              abs(negative.rotation + 7 * .pi / 180) < 1e-12,
              reduced.opacity == 0.45, reduced.rotation == 0,
              idle.allSatisfy({ $0.opacity >= 0.45 && $0.opacity <= 1 && abs($0.rotation) <= 7 * .pi / 180 }),
              zip(idle, idle.dropFirst()).allSatisfy({ $0.opacity >= $1.opacity }) else {
            throw NativeFailure("self_check_failed", "Virtual pointer thinking animation check failed.")
        }
        return 42
    }
    #endif
}

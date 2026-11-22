import AppKit
import ApplicationServices
import CoreGraphics

struct WindowInputTarget {
    let pid: pid_t
    let windowID: CGWindowID
    let bounds: CGRect

    func global(_ local: CGPoint) throws -> CGPoint {
        guard pid > 0, windowID > 0, [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, bounds.width, bounds.height, local.x, local.y].allSatisfy(\.isFinite),
              bounds.width > 0, bounds.height > 0,
              local.x >= 0, local.y >= 0, local.x < bounds.width, local.y < bounds.height else {
            throw NativeFailure("window_coordinate_out_of_bounds")
        }
        return CGPoint(x: bounds.minX + local.x, y: bounds.minY + local.y)
    }
}

final class WindowEventFactory {
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private let setWindowLocation: SetWindowLocation
    private let source: CGEventSource
    let target: WindowInputTarget
    let marker: Int64

    init(target: WindowInputTarget, marker: Int64) throws {
        _ = try target.global(.zero)
        guard let location = NativeFocus.symbol("CGEventSetWindowLocation", SetWindowLocation.self)
            ?? NativeFocus.symbol("SLEventSetWindowLocation", SetWindowLocation.self) else { throw NativeFailure("window_routing_spi_unavailable") }
        guard let source = CGEventSource(stateID: .privateState) else { throw NativeFailure("window_event_source_unavailable") }
        self.target = target; self.marker = marker
        self.source = source; setWindowLocation = location
    }

    private func route(_ event: CGEvent, local: CGPoint? = nil) throws -> CGEvent {
        // AppKit needs both private window identity fields; PID routing alone is insufficient.
        event.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(target.windowID))
        event.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(target.windowID))
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        if let local {
            event.location = try target.global(local)
            setWindowLocation(event, local)
        }
        return event
    }

    func mouse(_ type: NSEvent.EventType, at local: CGPoint, button: CGMouseButton = .left,
               clicks: Int = 1, flags: NSEvent.ModifierFlags = []) throws -> CGEvent {
        let global = try target.global(local)
        guard let appKit = NSEvent.mouseEvent(with: type, location: global, modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.windowID), context: nil,
            eventNumber: 1, clickCount: clicks, pressure: type == .leftMouseUp || type == .rightMouseUp ? 0 : 1),
              let event = appKit.cgEvent else { throw NativeFailure("window_event_creation_failed") }
        event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        return try route(event, local: local)
    }

    func scroll(at local: CGPoint, deltaX: Int32, deltaY: Int32) throws -> CGEvent {
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                  wheel1: -deltaY, wheel2: -deltaX, wheel3: 0) else { throw NativeFailure("window_event_creation_failed") }
        // Unlike NSEvent mouse construction, CG scroll construction omits the AppKit recipient window.
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(target.windowID))
        return try route(event, local: local)
    }

    func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags = [], unicode: [UniChar]? = nil) throws -> CGEvent {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw NativeFailure("window_event_creation_failed") }
        event.flags = flags
        if let unicode { unicode.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) } }
        return try route(event)
    }

    func localFocus(active: Bool, point: CGPoint? = nil) throws -> [CGEvent] {
        let location = active ? try point.map(target.global) ?? target.global(.zero) : .zero
        guard let app = NSEvent.otherEvent(with: .appKitDefined, location: location,
            modifierFlags: active ? NSEvent.ModifierFlags(rawValue: 0x000c0000) : [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: active ? Int(target.windowID) : 0, context: nil,
            subtype: active ? 1 : 2, data1: 0, data2: 0)?.cgEvent,
              let key = NSEvent.otherEvent(with: NSEvent.EventType(rawValue: 21)!, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
            subtype: Int16(bitPattern: active ? 0x8000 : 0x4000), data1: 0, data2: 0)?.cgEvent else {
            throw NativeFailure("window_focus_event_unavailable")
        }
        app.setIntegerValueField(.eventSourceUserData, value: marker)
        key.setIntegerValueField(.eventSourceUserData, value: marker)
        return [app, key]
    }

    func post(_ event: CGEvent, check: () throws -> Void, posted: () -> Void, cleanup: Bool = false) throws {
        if !cleanup { try check() }
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        posted()
        event.postToPid(target.pid)
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var count = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("window_event_self_check_failed", details: ["assertion": count + 1]) }
            count += 1
        }
        let target = WindowInputTarget(pid: getpid(), windowID: 123, bounds: CGRect(x: -50, y: -100, width: 800, height: 600))
        try check(try target.global(CGPoint(x: 20, y: 30)) == CGPoint(x: -30, y: -70))
        for point in [CGPoint(x: -1, y: 0), CGPoint(x: 800, y: 0), CGPoint(x: 0, y: 600), CGPoint(x: CGFloat.nan, y: 0)] {
            do { _ = try target.global(point); throw NativeFailure("window_event_self_check_failed") }
            catch let error as NativeFailure where error.code == "window_coordinate_out_of_bounds" { count += 1 }
        }
        let factory = try WindowEventFactory(target: target, marker: 77)
        let mouse = try factory.mouse(.leftMouseDown, at: CGPoint(x: 20, y: 30))
        try check(mouse.location == CGPoint(x: -30, y: -70))
        try check(mouse.getIntegerValueField(CGEventField(rawValue: 91)!) == 123 && mouse.getIntegerValueField(CGEventField(rawValue: 92)!) == 123)
        try check(mouse.getIntegerValueField(.mouseEventSubtype) == 3 && mouse.getIntegerValueField(.eventSourceUserData) == 77)
        try check(NSEvent(cgEvent: mouse)?.windowNumber == 123)
        let scroll = try factory.scroll(at: CGPoint(x: 20, y: 30), deltaX: 0, deltaY: 300)
        try check(scroll.getIntegerValueField(CGEventField(rawValue: 51)!) == 123)
        let key = try factory.key(0, down: true, flags: .maskCommand)
        try check(key.type == .keyDown && key.flags.contains(.maskCommand) && key.getIntegerValueField(.eventSourceUserData) == 77)
        try check(try factory.localFocus(active: true).count == 2)
        let activated = try factory.localFocus(active: true), deactivated = try factory.localFocus(active: false)
        try check(NSEvent(cgEvent: activated[0])?.modifierFlags.rawValue == 0x000c0000)
        try check(NSEvent(cgEvent: activated[0])?.windowNumber == 123 && NSEvent(cgEvent: activated[1])?.subtype.rawValue == Int16(bitPattern: 0x8000))
        try check(NSEvent(cgEvent: deactivated[0])?.windowNumber == 0 && NSEvent(cgEvent: deactivated[0])?.locationInWindow == .zero)
        try check(NSEvent(cgEvent: deactivated[1])?.subtype.rawValue == 0x4000)
        var posted = 0
        do {
            try factory.post(mouse, check: { throw NativeFailure("cancelled") }, posted: { posted += 1 })
            throw NativeFailure("window_event_self_check_failed")
        } catch let error as NativeFailure where error.code == "cancelled" {}
        try check(posted == 0)
        return count
    }
    #endif
}

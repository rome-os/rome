import Carbon.HIToolbox
import CoreGraphics
import Foundation

struct WindowInput {
    enum Button: String {
        case left, right, middle

        var button: CGMouseButton {
            switch self {
            case .left: .left
            case .right: .right
            case .middle: .center
            }
        }

        var events: (down: CGEventType, drag: CGEventType, up: CGEventType) {
            switch self {
            case .left: (.leftMouseDown, .leftMouseDragged, .leftMouseUp)
            case .right: (.rightMouseDown, .rightMouseDragged, .rightMouseUp)
            case .middle: (.otherMouseDown, .otherMouseDragged, .otherMouseUp)
            }
        }
    }

    enum Operation {
        case click(CGPoint, Button, Int)
        case move(CGPoint)
        case drag(CGPoint, CGPoint, Button, Int)
        case scroll(CGPoint, Int32, Int32)
        case key(String)
        case text(String)
    }

    let operation: Operation
    let flags: CGEventFlags

    init?(action: String, args: Request.Parameters) throws {
        let modifiers: [String: CGEventFlags] = [
            "command": .maskCommand, "control": .maskControl, "option": .maskAlternate, "shift": .maskShift,
        ]
        func point(_ x: Double?, _ y: Double?) throws -> CGPoint {
            guard let x, let y, x.isFinite, y.isFinite else { throw Failure("invalid_value") }
            return CGPoint(x: x, y: y)
        }
        func button() throws -> Button {
            guard let button = Button(rawValue: args.button ?? "left") else { throw Failure("invalid_value") }
            return button
        }
        func delta(_ value: Double?) throws -> Int32 {
            guard let value, value.isFinite, abs(value) <= 2000 else { throw Failure("invalid_value") }
            return Int32(value.rounded())
        }

        switch action {
        case "click":
            let count = args.clickCount ?? 1
            guard (1...3).contains(count) else { throw Failure("invalid_value") }
            operation = .click(try point(args.x, args.y), try button(), count)
        case "move":
            operation = .move(try point(args.x, args.y))
        case "drag":
            let steps = args.steps ?? 12
            guard (1...60).contains(steps) else { throw Failure("invalid_value") }
            operation = .drag(try point(args.x, args.y), try point(args.toX, args.toY), try button(), steps)
        case "scroll":
            let x = try delta(args.deltaX), y = try delta(args.deltaY)
            guard x != 0 || y != 0 else { throw Failure("invalid_value") }
            operation = .scroll(try point(args.x, args.y), x, y)
        case "key_press":
            guard let key = args.key,
                  Self.keys[key.lowercased()] != nil || (key.count == 1 && key.utf16.count <= 16) else {
                throw Failure("invalid_value")
            }
            operation = .key(key)
        case "type_text":
            guard let text = args.text, (1...16_384).contains(text.utf8.count) else { throw Failure("invalid_value") }
            operation = .text(text)
        default:
            return nil
        }

        let names = args.modifiers ?? []
        guard args.element == nil, args.value == nil, names.count <= 4, Set(names).count == names.count,
              !names.contains(where: { modifiers[$0] == nil }), action != "type_text" || names.isEmpty else {
            throw Failure("invalid_value")
        }
        flags = names.reduce(into: CGEventFlags()) { $0.formUnion(modifiers[$1] ?? []) }
    }

    private static let keys: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "escape": 53, "backspace": 51, "delete": 117, "space": 49,
        "up": 126, "down": 125, "left": 123, "right": 124, "home": 115, "end": 119, "page_up": 116, "page_down": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
        "f10": 109, "f11": 103, "f12": 111,
    ]

    @MainActor
    static func physicalKey(_ key: String, flags: CGEventFlags) -> (CGKeyCode, CGEventFlags)? {
        guard let input = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        defer { withExtendedLifetime(input) {} }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard let layout = CFDataGetBytePtr(data) else { return nil }
        let keyboard = UnsafeRawPointer(layout).assumingMemoryBound(to: UCKeyboardLayout.self)
        let keyboardType = UInt32(LMGetKbdType())
        let combinations: [(UInt32, CGEventFlags)] = [
            (0, []), (UInt32(shiftKey >> 8), .maskShift),
            (UInt32(optionKey >> 8), .maskAlternate), (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate]),
        ]
        // Shortcut modifiers apply to the physical key named by the caller.
        let sought = flags.isEmpty ? key : key.lowercased()
        var chars = [UniChar](repeating: 0, count: 16)
        for (modifier, implied) in combinations {
            for code: CGKeyCode in 0..<128 {
                var dead: UInt32 = 0, length = 0
                if UCKeyTranslate(keyboard, code, UInt16(kUCKeyActionDown), modifier, keyboardType,
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars) == noErr,
                   length > 0, String(decoding: chars.prefix(length), as: UTF16.self) == sought {
                    return (code, flags.union(implied))
                }
            }
        }
        return nil
    }

    static func global(_ point: CGPoint, in bounds: CGRect) throws -> CGPoint {
        guard validBounds(bounds), point.x.isFinite, point.y.isFinite,
              point.x >= 0, point.y >= 0, point.x < bounds.width, point.y < bounds.height else {
            throw Failure("window_coordinate_out_of_bounds")
        }
        let global = CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y)
        guard bounds.contains(global) else { throw Failure("window_coordinate_out_of_bounds") }
        return global
    }

    static func verifyStack(_ rows: [[String: Any]], target: WindowRow, point: CGPoint?,
                            isWindowServer: (pid_t) -> Bool) throws {
        guard target.pid > 0, target.pid != getpid(), target.id != 0, target.visible else {
            throw Failure("window_unavailable")
        }
        if let point, !target.bounds.contains(point) { throw Failure("window_coordinate_out_of_bounds") }
        let matches = rows.indices.filter {
            (rows[$0][kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.id
        }
        guard matches.count == 1, let index = matches.first,
              (rows[index][kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid,
              (rows[index][kCGWindowLayer as String] as? NSNumber)?.int32Value == 0,
              let alpha = (rows[index][kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha > 0,
              ConsentOcclusion.bounds(rows[index]) == target.bounds else { throw Failure("window_unavailable") }
        for row in rows[..<index] {
            guard let bounds = ConsentOcclusion.bounds(row) else { throw Failure("window_occluded") }
            guard !bounds.isEmpty,
                  point.map({ bounds.contains($0) }) ?? target.bounds.intersects(bounds) else { continue }
            let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            if pid == target.pid, point == nil { continue }
            let layer = (row[kCGWindowLayer as String] as? NSNumber)?.int32Value
            if layer == CGWindowLevelForKey(.cursorWindow),
               row[kCGWindowOwnerName as String] as? String == "Window Server",
               let pid, isWindowServer(pid) { continue }
            throw Failure("window_occluded")
        }
    }

    static func releaseDrag(_ event: CGEvent, identity: ProcessIdentity, post: (CGEvent) -> Void) throws {
        try identity.verify()
        post(event)
    }

    static func unicodeChunks(_ text: String) -> [[UniChar]] {
        var chunks: [[UniChar]] = [], chunk: [UniChar] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if chunk.count + units.count > 16 { chunks.append(chunk); chunk = [] }
            chunk += units
        }
        if !chunk.isEmpty { chunks.append(chunk) }
        return chunks
    }

    // send validates before dispatching a batch. release can run after send rejects the drag.
    func execute(window: CGWindowID, locate: (CGPoint) throws -> CGPoint,
                 lookupKey: (String, CGEventFlags) -> (CGKeyCode, CGEventFlags)?,
                 send: (CGPoint?, [CGEvent]) throws -> Void, release: (CGEvent) throws -> Void) throws {
        guard let source = CGEventSource(stateID: .privateState) else { throw Failure("action_rejected") }
        func mouse(_ type: CGEventType, at point: CGPoint, button: Button = .left, count: Int = 0) throws -> CGEvent {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                                      mouseCursorPosition: point, mouseButton: button.button) else {
                throw Failure("action_rejected")
            }
            event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.button.rawValue))
            event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            return pointer(event, at: point)
        }
        func pointer(_ event: CGEvent, at point: CGPoint) -> CGEvent {
            event.location = point
            event.flags = flags
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
            return event
        }
        func key(_ code: CGKeyCode, flags: CGEventFlags, chars: [UniChar] = []) throws {
            let pair = try [true, false].map { down in
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
                    throw Failure("action_rejected")
                }
                event.flags = flags
                if !chars.isEmpty {
                    chars.withUnsafeBufferPointer {
                        event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
                    }
                }
                return event
            }
            try send(nil, pair)
        }

        switch operation {
        case .click(let local, let button, let count):
            let point = try locate(local)
            for index in 1...count {
                try send(point, [mouse(button.events.down, at: point, button: button, count: index),
                                 mouse(button.events.up, at: point, button: button, count: index)])
            }
        case .move(let local):
            let point = try locate(local)
            try send(point, [mouse(.mouseMoved, at: point)])
        case .drag(let from, let to, let button, let steps):
            let start = try locate(from), end = try locate(to)
            try send(end, [])
            let up = try mouse(button.events.up, at: end, button: button, count: 1)
            try send(start, [mouse(button.events.down, at: start, button: button, count: 1)])
            var last = start
            do {
                for step in 1...steps {
                    let fraction = CGFloat(step) / CGFloat(steps)
                    let point = step == steps ? end : CGPoint(x: start.x + (end.x - start.x) * fraction,
                                                             y: start.y + (end.y - start.y) * fraction)
                    Thread.sleep(forTimeInterval: 0.008)
                    try send(point, [mouse(button.events.drag, at: point, button: button, count: 1)])
                    last = point
                }
                try send(end, [up])
            } catch {
                up.location = last
                try? release(up)
                throw error
            }
        case .scroll(let local, let x, let y):
            let point = try locate(local)
            guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                      wheel1: -y, wheel2: -x, wheel3: 0) else { throw Failure("action_rejected") }
            try send(point, [pointer(event, at: point)])
        case .key(let name):
            if let code = Self.keys[name.lowercased()] {
                try key(code, flags: flags)
            } else if let (code, effectiveFlags) = lookupKey(name, flags) {
                try key(code, flags: effectiveFlags)
            } else {
                guard flags.isEmpty else { throw Failure("key_unavailable") }
                try key(0, flags: [], chars: Array(name.utf16))
            }
        case .text(let text):
            for chunk in Self.unicodeChunks(text) { try key(0, flags: [], chars: chunk) }
        }
    }
}

import AppKit
import CoreGraphics

struct WindowAction {
    let type: String
    let point: CGPoint?
    let destination: CGPoint?
    let button: CGMouseButton
    let clicks: Int
    let duration: Double
    let deltaX: Int32
    let deltaY: Int32
    let key: CGKeyCode?
    let flags: CGEventFlags
    let text: String?

    static let fields: [String: Set<String>] = [
        "move": ["x", "y"], "click": ["x", "y", "button", "clickCount"],
        "drag": ["x", "y", "toX", "toY", "durationMs"], "scroll": ["x", "y", "deltaX", "deltaY"],
        "key": ["key", "modifiers"], "type": ["text"]]

    // Overrides are already converted from image pixels or resolved from an AX reference by the caller.
    static func parse(_ raw: [String: Any], bounds: CGRect, point: CGPoint? = nil,
                      destination: CGPoint? = nil) throws -> WindowAction {
        guard let type = raw["type"] as? String, let allowed = fields[type],
              Set(raw.keys).subtracting(["type"]).isSubset(of: allowed),
              [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, bounds.width, bounds.height].allSatisfy(\.isFinite),
              bounds.width > 0, bounds.height > 0 else { throw NativeFailure("unsupported_action") }
        func number(_ key: String, fallback: Double? = nil) throws -> Double {
            if raw[key] == nil, let fallback { return fallback }
            guard let n = raw[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else {
                throw NativeFailure("invalid_args")
            }
            return n.doubleValue
        }
        func local(_ override: CGPoint?, x: String, y: String, required: Bool) throws -> CGPoint? {
            let hasCoordinates = raw[x] != nil || raw[y] != nil
            let coordinates = hasCoordinates ? try CGPoint(x: number(x), y: number(y)) : nil
            guard let value = override ?? coordinates else {
                if required { throw NativeFailure("window_coordinate_required") }
                return nil
            }
            guard value.x.isFinite, value.y.isFinite, value.x >= 0, value.y >= 0,
                  value.x < bounds.width, value.y < bounds.height else { throw NativeFailure("window_coordinate_out_of_bounds") }
            return value
        }
        let usesPoint = ["move", "click", "drag", "scroll"].contains(type)
        let origin = usesPoint ? try local(point, x: "x", y: "y", required: true) : nil
        let end = type == "drag" ? try local(destination, x: "toX", y: "toY", required: true) : nil
        let duration = type == "drag" ? try number("durationMs", fallback: 500) : 500
        let clicks = type == "click" ? try number("clickCount", fallback: 1) : 1
        let dx = type == "scroll" ? try number("deltaX", fallback: 0) : 0
        let dy = type == "scroll" ? try number("deltaY") : 0
        guard duration >= 100, duration <= 2000, duration.rounded() == duration,
              clicks == 1 || clicks == 2, dx.rounded() == dx, dy.rounded() == dy,
              abs(dx) <= 2000, abs(dy) <= 2000 else { throw NativeFailure("invalid_args") }
        let button = raw["button"] as? String ?? "left"
        guard button == "left" || button == "right", raw["button"] == nil || raw["button"] is String else { throw NativeFailure("invalid_args") }
        var flags: CGEventFlags = []
        if let value = raw["modifiers"] {
            guard let values = value as? [String], values.count <= 4, Set(values).count == values.count else { throw NativeFailure("invalid_args") }
            for value in values {
                switch value {
                case "command": flags.insert(.maskCommand)
                case "control": flags.insert(.maskControl)
                case "alt": flags.insert(.maskAlternate)
                case "shift": flags.insert(.maskShift)
                default: throw NativeFailure("invalid_args")
                }
            }
        }
        let key: CGKeyCode?
        if type == "key" {
            guard let name = raw["key"] as? String, let code = DesktopInput.keyCode(name) else { throw NativeFailure("unsupported_key") }
            key = code
        } else { key = nil }
        let text = raw["text"] as? String
        if type == "type" {
            guard let text, !text.isEmpty, !text.contains("\0"), text.utf16.count <= 4096 else { throw NativeFailure("invalid_args") }
        }
        return WindowAction(type: type, point: origin, destination: end, button: button == "right" ? .right : .left,
                            clicks: Int(clicks), duration: duration / 1000, deltaX: Int32(dx), deltaY: Int32(dy),
                            key: key, flags: flags, text: text)
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        let bounds = CGRect(x: -50, y: -100, width: 800, height: 600)
        var count = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("window_action_self_check_failed", details: ["assertion": count + 1]) }
            count += 1
        }
        let click = try parse(["type": "click"], bounds: bounds, point: CGPoint(x: 10, y: 20))
        try check(click.point == CGPoint(x: 10, y: 20) && click.clicks == 1 && click.button == .left)
        let drag = try parse(["type": "drag", "x": 10, "y": 20, "toX": 300, "toY": 400, "durationMs": 2000], bounds: bounds)
        try check(drag.point == CGPoint(x: 10, y: 20) && drag.destination == CGPoint(x: 300, y: 400) && drag.duration == 2)
        let key = try parse(["type": "key", "key": "A", "modifiers": ["command", "shift"]], bounds: bounds)
        try check(key.key == 0 && key.flags == [.maskCommand, .maskShift])
        let scroll = try parse(["type": "scroll", "x": 799.5, "y": 599.5, "deltaX": -2000, "deltaY": 2000], bounds: bounds)
        try check(scroll.deltaX == -2000 && scroll.deltaY == 2000)
        try check(try parse(["type": "type", "text": "中文🪄"], bounds: bounds).text == "中文🪄")
        let invalid: [[String: Any]] = [
            ["type": "move", "x": true, "y": 0], ["type": "move", "x": Double.nan, "y": 0],
            ["type": "move", "x": 0], ["type": "move", "x": -1, "y": 0],
            ["type": "move", "x": 800, "y": 0], ["type": "move", "x": 0, "y": 600],
            ["type": "click", "x": 0, "y": 0, "button": "middle"],
            ["type": "click", "x": 0, "y": 0, "clickCount": true],
            ["type": "click", "x": 0, "y": 0, "clickCount": 3],
            ["type": "drag", "x": 0, "y": 0, "toX": 1, "toY": 1, "durationMs": 99],
            ["type": "drag", "x": 0, "y": 0, "toX": 1, "toY": 1, "durationMs": 2001],
            ["type": "scroll", "x": 0, "y": 0, "deltaY": 2001],
            ["type": "scroll", "x": 0, "y": 0, "deltaY": 0.5],
            ["type": "key", "key": "A", "modifiers": ["command", "command"]],
            ["type": "key", "key": "A", "modifiers": ["hyper"]], ["type": "key", "key": "CAPSLOCK"],
            ["type": "type", "text": ""], ["type": "type", "text": "a\0b"],
            ["type": "type", "text": String(repeating: "🪄", count: 2049)],
            ["type": "type", "text": "abc", "x": 0], ["type": "press"]]
        for raw in invalid {
            do { _ = try parse(raw, bounds: bounds); throw NativeFailure("window_action_self_check_failed") }
            catch let error as NativeFailure where error.code != "window_action_self_check_failed" { count += 1 }
        }
        do {
            _ = try parse(["type": "click", "x": 0], bounds: bounds, point: CGPoint(x: 1, y: 1))
            throw NativeFailure("window_action_self_check_failed")
        } catch let error as NativeFailure where error.code != "window_action_self_check_failed" { count += 1 }
        return count
    }
    #endif
}

enum WindowEventDispatcher {
    private static func holding(down: () throws -> Void, body: () throws -> Void, release: () throws -> Void) throws {
        try down()
        let dispatch = Result { try body() }
        do { try release() }
        catch let failure as NativeFailure {
            var details = failure.details
            details["releaseFailure"] = failure.code
            if case .failure(let dispatchError) = dispatch, let native = dispatchError as? NativeFailure {
                details["dispatchError"] = native.code
            }
            throw NativeFailure("window_release_unconfirmed", details: details)
        } catch {
            throw NativeFailure("window_release_unconfirmed")
        }
        try dispatch.get()
    }

    // A local focus click still changes a text field's caret. Its caller must preserve any existing selection.
    static func prepareFocus(at point: CGPoint, factory: WindowEventFactory, check: () throws -> Void,
                             posted: () -> Void, cleanupIdentity: () throws -> Void) throws {
        let down = try factory.mouse(.leftMouseDown, at: point, clicks: 0)
        let up = try factory.mouse(.leftMouseUp, at: point, clicks: 0)
        try holding(down: { try factory.post(down, check: check, posted: posted) }, body: { usleep(8_000); try check() }, release: {
            try cleanupIdentity()
            try factory.post(up, check: {}, posted: posted, cleanup: true)
        })
    }

    static func perform(_ input: WindowAction, factory: WindowEventFactory, check: () throws -> Void,
                        checkKeyboard: () throws -> Void, posted: () -> Void, cleanupIdentity: () throws -> Void,
                        visualProgress: ((CGPoint) throws -> Void)? = nil) throws {
        let until = ProcessInfo.processInfo.systemUptime + 8
        func ready() throws {
            try check()
            guard ProcessInfo.processInfo.systemUptime < until else { throw NativeFailure("input_duration_exceeded") }
        }
        func post(_ event: CGEvent) throws { try factory.post(event, check: ready, posted: posted) }
        func release(_ event: CGEvent) throws {
            try cleanupIdentity()
            try factory.post(event, check: {}, posted: posted, cleanup: true)
        }
        func pause(until target: Double) throws {
            while true {
                try ready()
                let remaining = target - ProcessInfo.processInfo.systemUptime
                if remaining <= 0 { return }
                usleep(useconds_t(min(0.01, remaining) * 1_000_000))
            }
        }
        func key(_ code: CGKeyCode, flags: CGEventFlags, unicode: [UniChar]? = nil) throws {
            try checkKeyboard()
            let down = try factory.key(code, down: true, flags: flags, unicode: unicode)
            let up = try factory.key(code, down: false)
            try holding(down: { try post(down) }, body: {
                try pause(until: ProcessInfo.processInfo.systemUptime + 0.004)
            }, release: { try release(up) })
        }
        try ready()
        switch input.type {
        case "move":
            try post(factory.mouse(.mouseMoved, at: input.point!))
            try visualProgress?(input.point!)
        case "click":
            let point = input.point!
            for count in 1...input.clicks {
                let down = try factory.mouse(input.button == .right ? .rightMouseDown : .leftMouseDown,
                                             at: point, button: input.button, clicks: count)
                let up = try factory.mouse(input.button == .right ? .rightMouseUp : .leftMouseUp,
                                           at: point, button: input.button, clicks: count)
                try holding(down: { try post(down) }, body: {
                    try pause(until: ProcessInfo.processInfo.systemUptime + 0.04)
                }, release: { try release(up) })
                if count < input.clicks { try pause(until: ProcessInfo.processInfo.systemUptime + 0.06) }
            }
        case "drag":
            let start = input.point!, end = input.destination!
            let bounds = CGRect(x: 0, y: 0, width: factory.target.bounds.width.nextDown, height: factory.target.bounds.height.nextDown)
            let path = try PointerMotion(start: start, destination: end, bounds: bounds, startedAt: 0,
                                         variation: UInt64(bitPattern: factory.marker), allowsElbow: false)
            var last = start
            let down = try factory.mouse(.leftMouseDown, at: start)
            try holding(down: { try post(down) }, body: {
                let began = ProcessInfo.processInfo.systemUptime
                let steps = max(6, Int(ceil(input.duration * 60)))
                for index in 1...steps {
                    let progress = Double(index) / Double(steps)
                    try pause(until: began + input.duration * progress)
                    let next = path.sample(at: path.duration * progress).position
                    try post(factory.mouse(.leftMouseDragged, at: next))
                    last = next
                    try visualProgress?(next)
                }
            }, release: { try release(factory.mouse(.leftMouseUp, at: last)) })
        case "scroll": try post(factory.scroll(at: input.point!, deltaX: input.deltaX, deltaY: input.deltaY))
        case "key": try key(input.key!, flags: input.flags)
        case "type":
            for chunk in DesktopInput.unicodeChunks(input.text!) { try key(0, flags: [], unicode: chunk) }
        default: throw NativeFailure("unsupported_action")
        }
        try ready()
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var count = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("window_dispatch_self_check_failed", details: ["assertion": count + 1]) }
            count += 1
        }
        var trace: [String] = []
        try holding(down: { trace.append("down") }, body: { trace.append("body") }, release: { trace.append("up") })
        try check(trace == ["down", "body", "up"])
        trace = []
        do {
            try holding(down: { throw NativeFailure("cancelled") }, body: { trace.append("body") }, release: { trace.append("up") })
            throw NativeFailure("window_dispatch_self_check_failed")
        } catch let error as NativeFailure where error.code == "cancelled" {}
        try check(trace.isEmpty)
        do {
            try holding(down: { trace.append("down") }, body: { trace.append("cancelled"); throw NativeFailure("cancelled") }, release: { trace.append("up") })
            throw NativeFailure("window_dispatch_self_check_failed")
        } catch let error as NativeFailure where error.code == "cancelled" {}
        try check(trace == ["down", "cancelled", "up"])
        do {
            try holding(down: {}, body: {}, release: { throw NativeFailure("identity_changed") })
            throw NativeFailure("window_dispatch_self_check_failed")
        } catch let error as NativeFailure where error.code == "window_release_unconfirmed" {
            try check(error.details["releaseFailure"] as? String == "identity_changed")
        }
        do {
            try holding(down: {}, body: { throw NativeFailure("cancelled") }, release: { throw NativeFailure("identity_changed") })
            throw NativeFailure("window_dispatch_self_check_failed")
        } catch let error as NativeFailure where error.code == "window_release_unconfirmed" {
            try check(error.details["releaseFailure"] as? String == "identity_changed" && error.details["dispatchError"] as? String == "cancelled")
        }
        let pathBounds = CGRect(x: 0, y: 0, width: CGFloat(800).nextDown, height: CGFloat(600).nextDown)
        for variant: UInt64 in [0, 1, 123, UInt64.max] {
            let path = try PointerMotion(start: CGPoint(x: 1, y: 1), destination: CGPoint(x: 799, y: 599), bounds: pathBounds, startedAt: 0,
                                         variation: variant, allowsElbow: false)
            let points = (0...120).map { path.sample(at: path.duration * Double($0) / 120).position }
            try check(points.first == path.start && points.last == path.destination && points.allSatisfy { $0.x >= 0 && $0.x < 800 && $0.y >= 0 && $0.y < 600 })
        }
        let factory = try WindowEventFactory(target: WindowInputTarget(pid: getpid(), windowID: 123,
            bounds: CGRect(x: 0, y: 0, width: 800, height: 600)), marker: 1)
        let move = try WindowAction.parse(["type": "move", "x": 10, "y": 20], bounds: factory.target.bounds)
        var posted = 0, visuals = 0
        do {
            try perform(move, factory: factory, check: { throw NativeFailure("cancelled") }, checkKeyboard: {},
                        posted: { posted += 1 }, cleanupIdentity: {}, visualProgress: { _ in visuals += 1 })
            throw NativeFailure("window_dispatch_self_check_failed")
        } catch let error as NativeFailure where error.code == "cancelled" { count += 1 }
        try check(posted == 0 && visuals == 0)
        return count
    }
    #endif
}

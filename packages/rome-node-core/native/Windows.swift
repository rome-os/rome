import AppKit
import ApplicationServices
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct WindowRow {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    var visible = true
}

func uniqueRoot(_ row: WindowRow, rows: [WindowRow], roots: [CGRect]) -> Int? {
    guard row.visible, rows.lazy.filter({ $0.id == row.id }).count == 1 else { return nil }
    let windows = rows.filter { $0.pid == row.pid && $0.bounds == row.bounds }
    let matches = roots.indices.filter { roots[$0] == row.bounds }
    guard windows.count == 1, windows.first?.id == row.id, matches.count == 1 else { return nil }
    return matches.first
}

final class DesktopAccess {
    private let lock = NSLock()
    private var screenGranted = false

    func check(rows: [[String: Any]]? = nil) throws {
        try Self.require(trusted: AXIsProcessTrusted(), console: Self.consoleAvailable(rows ?? Windows.onScreen()))
        try recording(granted: CGPreflightScreenCaptureAccess(), required: false)
    }

    func recording(granted: Bool, required: Bool) throws {
        try lock.withLock {
            if granted { screenGranted = true }
            else if required || screenGranted { throw Failure("screen_recording_permission_required") }
        }
    }

    static func require(trusted: Bool, console: @autoclosure () -> Bool) throws {
        guard trusted else { throw Failure("accessibility_permission_required") }
        guard console() else { throw Failure("console_unavailable") }
    }

    static func consoleAvailable(_ rows: [[String: Any]]?) -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
              session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session[kCGSessionLoginDoneKey as String] as? Bool == true,
              CGDisplayIsAsleep(CGMainDisplayID()) == 0,
              let front = NSWorkspace.shared.frontmostApplication,
              front.bundleIdentifier != "com.apple.loginwindow" else { return false }
        return visibleLayersClear(rows)
    }

    static func visibleLayersClear(_ rows: [[String: Any]]?) -> Bool {
        guard let rows, !rows.isEmpty else { return false }
        let screenSaver = CGWindowLevelForKey(.screenSaverWindow)
        return rows.allSatisfy {
            guard let layer = ($0[kCGWindowLayer as String] as? NSNumber)?.int32Value else { return false }
            return layer < screenSaver || (layer == CGWindowLevelForKey(.cursorWindow) &&
                $0[kCGWindowOwnerName as String] as? String == "Window Server")
        }
    }
}

private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

private func elements(_ element: AXUIElement, _ key: String, limit: Int) -> [AXUIElement]? {
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, key as CFString, 0, limit, &values) == .success else { return nil }
    return values as? [AXUIElement]
}

private func owner(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func boundsOfRoot(_ root: AXUIElement) -> CGRect? {
    guard let position = attribute(root, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(root, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    let bounds = CGRect(origin: point, size: dimensions)
    return validBounds(bounds) ? bounds : nil
}

private func validBounds(_ bounds: CGRect) -> Bool {
    [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy(\.isFinite) &&
        bounds.width > 0 && bounds.height > 0
}

final class Windows {
    private struct Match {
        let row: WindowRow
        let identity: ProcessIdentity
        let root: AXUIElement
        let app: NSRunningApplication
    }

    private struct Binding {
        let id = UUID().uuidString
        let instance: String
        let match: Match
        var refs: [String: AXUIElement] = [:]
        var expires: TimeInterval = 0
    }

    // Only the window worker reads or writes the binding.
    private var binding: Binding?
    var hasBinding: Bool { binding != nil }
    let instance: String
    let access: DesktopAccess
    let live: () throws -> Void

    init(instance: String, access: DesktopAccess, live: @escaping () throws -> Void) {
        self.instance = instance
        self.access = access
        self.live = live
    }

    static func onScreen() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    }

    private func rows() throws -> [WindowRow] {
        try live()
        guard AXIsProcessTrusted() else { throw Failure("accessibility_permission_required") }
        guard let raw = Self.onScreen() else { throw Failure("console_unavailable") }
        try access.check(rows: raw)
        guard let all = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { throw Failure("window_unavailable") }
        return all.compactMap {
            guard ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let id = ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id != 0,
                  let pid = ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != getpid(),
                  let dictionary = $0[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), validBounds(bounds)
            else { return nil }
            return WindowRow(id: id, pid: pid, bounds: bounds, visible: $0[kCGWindowIsOnscreen as String] as? Bool == true)
        }
    }

    private func matches(_ rows: [WindowRow], pid: pid_t, deadline: TimeInterval) -> [Match] {
        guard let identity = try? ProcessIdentity.read(pid), identity.uid == getuid(),
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.activationPolicy == .regular, app.bundleIdentifier != nil,
              let executable = app.executableURL?.path, canonicalPath(executable) == identity.executable else { return [] }

        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(axApp, 0.06)
        guard let roots = elements(axApp, kAXWindowsAttribute, limit: 129), roots.count <= 128 else { return [] }
        var verifiedRoots: [AXUIElement] = []
        var geometry: [CGRect] = []
        for root in roots {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return [] }
            AXUIElementSetMessagingTimeout(root, 0.06)
            guard owner(root) == pid, attribute(root, kAXRoleAttribute) as? String == kAXWindowRole,
                  let bounds = boundsOfRoot(root) else { return [] }
            verifiedRoots.append(root)
            geometry.append(bounds)
        }
        guard (try? identity.verify()) != nil else { return [] }
        return rows.compactMap { row in
            guard ProcessInfo.processInfo.systemUptime < deadline, row.pid == pid, let index = uniqueRoot(row, rows: rows, roots: geometry),
                  attribute(verifiedRoots[index], kAXMinimizedAttribute) as? Bool == false,
                  attribute(verifiedRoots[index], kAXModalAttribute) as? Bool != true else { return nil }
            return Match(row: row, identity: identity, root: verifiedRoots[index], app: app)
        }
    }

    private func metadata(_ match: Match) -> [String: Any] {
        let bounds = match.row.bounds
        return ["window": match.row.id, "appName": String((match.app.localizedName ?? "").unicodeScalars.prefix(128)),
                "bundleId": String((match.app.bundleIdentifier ?? "").unicodeScalars.prefix(128)),
                "bundleName": String((match.app.bundleURL?.deletingPathExtension().lastPathComponent ?? "").unicodeScalars.prefix(128)),
                "title": text(match.root, kAXTitleAttribute) ?? "",
                "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height]]
    }

    func list(application: String?) throws -> [String: Any] {
        let rows = try rows()
        let deadline = ProcessInfo.processInfo.systemUptime + 0.7
        var windows: [[String: Any]] = []
        var seen = Set<pid_t>()
        for row in rows where row.visible && seen.insert(row.pid).inserted {
            try live()
            if ProcessInfo.processInfo.systemUptime >= deadline || windows.count >= 64 { break }
            if let application {
                guard application.utf8.count <= 256,
                      let app = NSRunningApplication(processIdentifier: row.pid),
                      [app.bundleIdentifier, app.localizedName, app.bundleURL?.deletingPathExtension().lastPathComponent]
                        .compactMap({ $0 }).contains(where: { $0.caseInsensitiveCompare(application) == .orderedSame })
                else { continue }
            }
            for match in matches(rows, pid: row.pid, deadline: deadline).prefix(64 - windows.count) {
                windows.append(metadata(match))
            }
        }
        try live()
        return ["windows": windows]
    }

    func bind(_ id: CGWindowID) throws -> [String: Any] {
        binding = nil
        let rows = try rows()
        guard let row = rows.first(where: { $0.id == id }),
              let match = matches(rows, pid: row.pid, deadline: ProcessInfo.processInfo.systemUptime + 0.5)
                .first(where: { $0.row.id == id }) else { throw Failure("window_unavailable") }
        let value = Binding(instance: instance, match: match)
        let metadata = metadata(match)
        try live()
        binding = value
        return ["binding": value.id, "window": metadata]
    }

    private func revalidate(_ value: Binding) throws -> Match {
        let previous = value.match
        do {
            let rows = try rows()
            try previous.identity.verify()
            guard value.instance == instance,
                  let match = matches(rows, pid: previous.row.pid, deadline: ProcessInfo.processInfo.systemUptime + 0.5)
                    .first(where: { $0.row.id == previous.row.id }),
                  match.identity == previous.identity, CFEqual(match.root, previous.root) else {
                throw Failure("window_unavailable")
            }
            try live()
            return match
        } catch {
            binding = nil
            throw error
        }
    }

    private func current(_ id: String) throws -> Binding {
        guard let binding, binding.id == id else { throw Failure("binding_unavailable") }
        return binding
    }

    private func belongs(_ node: AXUIElement, to match: Match) -> Bool {
        guard owner(node) == match.identity.pid else { return false }
        if CFEqual(node, match.root) { return true }
        guard let root = attribute(node, kAXWindowAttribute), CFGetTypeID(root) == AXUIElementGetTypeID() else { return false }
        return CFEqual(root, match.root)
    }

    private func text(_ node: AXUIElement, _ key: String) -> String? {
        (attribute(node, key) as? String).map { String($0.unicodeScalars.prefix(160)) }
    }

    private func actions(_ node: AXUIElement, role: String) -> [String] {
        let enabled = attribute(node, kAXEnabledAttribute) as? Bool == true
        guard enabled else { return [] }
        var rawNames: CFArray?
        let result = AXUIElementCopyActionNames(node, &rawNames)
        let names = result == .success ? (rawNames as? [String] ?? []) : []
        var actions: [String] = []
        if [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole].contains(role), names.contains(kAXPressAction) {
            actions.append("press")
        }
        if role == kAXScrollBarRole {
            if names.contains(kAXIncrementAction) { actions.append("increment") }
            if names.contains(kAXDecrementAction) { actions.append("decrement") }
        }
        let textInput = [kAXTextFieldRole, kAXTextAreaRole].contains(role)
        let subrole = attribute(node, kAXSubroleAttribute) as? String
        if textInput && subrole != kAXSecureTextFieldSubrole || role == kAXCheckBoxRole ||
            role == kAXSliderRole && sliderRange(node) != nil {
            var settable = DarwinBoolean(false)
            if AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
                actions.append("set_value")
            }
        }
        return actions
    }

    private func sliderRange(_ node: AXUIElement) -> ClosedRange<Double>? {
        guard let minimum = attribute(node, kAXMinValueAttribute) as? NSNumber,
              let maximum = attribute(node, kAXMaxValueAttribute) as? NSNumber,
              minimum.doubleValue.isFinite, maximum.doubleValue.isFinite,
              minimum.doubleValue <= maximum.doubleValue else { return nil }
        return minimum.doubleValue...maximum.doubleValue
    }

    func observe(_ id: String, screenshot: Bool) throws -> ([String: Any], Wire.Image?) {
        var value = try current(id)
        let match = try revalidate(value)
        let deadline = ProcessInfo.processInfo.systemUptime + 0.6
        let previous = value.expires > ProcessInfo.processInfo.systemUptime ? value.refs : [:]
        var refs: [String: AXUIElement] = [:]
        var truncated = false

        func visit(_ node: AXUIElement, depth: Int) throws -> [String: Any]? {
            try live()
            guard depth <= 12, refs.count < 96, ProcessInfo.processInfo.systemUptime < deadline else {
                truncated = true
                return nil
            }
            AXUIElementSetMessagingTimeout(node, 0.04)
            guard belongs(node, to: match), !refs.values.contains(where: { CFEqual($0, node) }),
                  let role = text(node, kAXRoleAttribute) else { return nil }
            let ref = previous.first(where: { CFEqual($0.value, node) })?.key ?? UUID().uuidString
            refs[ref] = node
            var tree: [String: Any] = ["ref": ref, "role": role, "actions": actions(node, role: role)]
            tree["title"] = text(node, kAXTitleAttribute)
            tree["description"] = text(node, kAXDescriptionAttribute)
            if attribute(node, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole {
                let raw = attribute(node, kAXValueAttribute)
                if let string = raw as? String {
                    tree["value"] = String(string.unicodeScalars.prefix(160))
                } else if let number = raw as? NSNumber, number.doubleValue.isFinite {
                    tree["value"] = number
                }
            }
            let children = elements(node, kAXChildrenAttribute, limit: 97) ?? []
            if children.count > 96 { truncated = true }
            tree["children"] = try children.prefix(96).compactMap { try visit($0, depth: depth + 1) }
            return tree
        }

        guard let tree = try visit(match.root, depth: 0) else { throw Failure("window_unavailable") }
        let image = screenshot ? try capture(value) : nil
        _ = try revalidate(value)
        value.refs = refs
        value.expires = ProcessInfo.processInfo.systemUptime + 15
        binding = value
        return (["binding": id, "tree": tree, "truncated": truncated, "refTTLms": 15_000], image)
    }

    func act(_ id: String, element ref: String, action: String, input: Request.Value?) throws -> [String: Any] {
        let value = try current(id)
        let match = try revalidate(value)
        guard value.expires > ProcessInfo.processInfo.systemUptime, let node = value.refs[ref],
              belongs(node, to: match), let role = text(node, kAXRoleAttribute) else { throw Failure("element_unavailable") }
        guard actions(node, role: role).contains(action) else { throw Failure("action_unavailable") }

        let property: CFTypeRef?
        switch (action, role, input) {
        case ("set_value", kAXTextFieldRole, .text(let value)), ("set_value", kAXTextAreaRole, .text(let value)):
            property = value as CFString
        case ("set_value", kAXCheckBoxRole, .checked(let checked)):
            property = NSNumber(value: checked ? 1 : 0)
        case ("set_value", kAXSliderRole, .number(let number)):
            guard sliderRange(node)?.contains(number) == true else { throw Failure("invalid_value") }
            property = NSNumber(value: number)
        case ("press", _, nil), ("increment", _, nil), ("decrement", _, nil):
            property = nil
        default:
            throw Failure("invalid_value")
        }

        let latest = try revalidate(value)
        guard value.expires > ProcessInfo.processInfo.systemUptime,
              belongs(node, to: latest), actions(node, role: role).contains(action),
              text(node, kAXRoleAttribute) == role else { throw Failure("element_unavailable") }
        try access.check()
        try live()
        let status: AXError
        if let property {
            status = AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, property)
        } else {
            let name = action == "press" ? kAXPressAction : action == "increment" ? kAXIncrementAction : kAXDecrementAction
            status = AXUIElementPerformAction(node, name as CFString)
        }
        if status == .cannotComplete { throw Failure("action_outcome_unknown") }
        guard status == .success else { throw Failure("action_rejected") }
        return ["binding": id, "dispatched": true]
    }

    private func capture(_ value: Binding) throws -> Wire.Image {
        try access.recording(granted: CGPreflightScreenCaptureAccess(), required: true)
        let content: SCShareableContent = try captureCall {
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true, completionHandler: $0)
        }
        let match = try revalidate(value)
        let windows = content.windows.filter {
            $0.windowID == match.row.id && $0.owningApplication?.processID == match.identity.pid &&
                $0.isOnScreen && $0.frame == match.row.bounds
        }
        guard windows.count == 1, let window = windows.first else { throw Failure("window_unavailable") }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let rect = filter.contentRect
        guard validBounds(rect) else { throw Failure("capture_limit") }
        let scale = min(Double(filter.pointPixelScale), 2048 / rect.width, 1536 / rect.height)
        guard scale.isFinite, scale > 0 else { throw Failure("capture_limit") }
        config.width = max(1, Int((rect.width * scale).rounded(.down)))
        config.height = max(1, Int((rect.height * scale).rounded(.down)))
        try Wire.Image.checkSize(config.width, config.height)
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        try access.recording(granted: CGPreflightScreenCaptureAccess(), required: true)
        try live()
        let image: CGImage = try captureCall {
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config, completionHandler: $0)
        }
        try live()
        try access.recording(granted: CGPreflightScreenCaptureAccess(), required: true)
        try Wire.Image.checkSize(image.width, image.height)
        let png = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(png as CFMutableData, UTType.png.identifier as CFString, 1, nil)
        else { throw Failure("capture_failed") }
        CGImageDestinationAddImage(writer, image, nil)
        guard CGImageDestinationFinalize(writer) else { throw Failure("capture_failed") }
        return try Wire.Image(png: png as Data, width: image.width, height: image.height)
    }

    private func captureCall<T>(_ start: (@escaping @Sendable (T?, Error?) -> Void) -> Void) throws -> T {
        let result = CaptureResult<T>()
        start { value, _ in result.complete(value) }
        let deadline = DispatchTime.now() + .seconds(3)
        while result.ready.wait(timeout: .now() + .milliseconds(50)) == .timedOut {
            try live()
            guard DispatchTime.now() < deadline else { throw Failure("capture_failed") }
        }
        guard let value = result.value else { throw Failure("capture_failed") }
        return value
    }
}

private final class CaptureResult<T>: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    private(set) var value: T?

    func complete(_ value: T?) {
        self.value = value
        ready.signal()
    }
}

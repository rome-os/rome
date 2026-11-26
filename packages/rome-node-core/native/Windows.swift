import AppKit
import ApplicationServices
import ImageIO
import ScreenCaptureKit
import Security
import UniformTypeIdentifiers

struct WindowRow {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    var visible = true
    var title: String?
}

struct WindowRoot {
    let bounds: CGRect
    var title: String?
}

private func chromeTitleMatches(_ cgTitle: String, _ axTitle: String) -> Bool {
    let browserTitle = cgTitle + " - Google Chrome"
    let profilePrefix = browserTitle + " - "
    return axTitle == cgTitle || axTitle == browserTitle ||
        (axTitle.hasPrefix(profilePrefix) && axTitle.count > profilePrefix.count)
}

func uniqueRoot(_ row: WindowRow, rows: [WindowRow], roots: [WindowRoot],
                pinned: [CGWindowID: Int] = [:], focused: Int? = nil, chromeTitles: Bool = false) -> Int? {
    guard row.visible, rows.lazy.filter({ $0.visible && $0.id == row.id }).count == 1 else { return nil }
    let windows = rows.filter { $0.visible && $0.pid == row.pid && $0.bounds == row.bounds }
    let candidates = roots.indices.filter { roots[$0].bounds == row.bounds }
    guard windows.contains(where: { $0.id == row.id }) else { return nil }
    if windows.count == 1, candidates.count == 1 { return candidates.first }

    let ids = Set(windows.map(\.id))
    var pairs = pinned.filter { ids.contains($0.key) && candidates.contains($0.value) }
    if let pinned = pairs[row.id] { return pinned }
    if chromeTitles {
        // Chrome adds the product and profile to AX titles. Require a complete, unambiguous match.
        if ids.count == windows.count, candidates.count == windows.count {
            let named = windows.compactMap { window -> (CGWindowID, Int)? in
                guard let title = window.title, !title.isEmpty else { return nil }
                let matches = candidates.filter { index in
                    roots[index].title.map { chromeTitleMatches(title, $0) } ?? false
                }
                guard matches.count == 1, let index = matches.first,
                      pairs[window.id].map({ $0 == index }) ?? true else { return nil }
                return (window.id, index)
            }
            if named.count == windows.count, Set(named.map { $0.1 }).count == windows.count {
                pairs = Dictionary(uniqueKeysWithValues: named)
            }
        }
    } else {
        for window in windows {
            guard pairs[window.id] == nil, let title = window.title, !title.isEmpty,
                  windows.filter({ $0.title == title }).count == 1 else { continue }
            let named = candidates.filter { roots[$0].title == title }
            if named.count == 1, let index = named.first, !pairs.values.contains(index) { pairs[window.id] = index }
        }
    }
    if let named = pairs[row.id] { return named }
    guard windows.count == candidates.count else { return nil }
    // Core Graphics gives front-to-back order. AXWindows makes no order guarantee.
    if let front = windows.first, let focused, candidates.contains(focused),
       pairs[front.id] == nil, !pairs.values.contains(focused) {
        pairs[front.id] = focused
    }
    if let paired = pairs[row.id] { return paired }
    let remaining = candidates.filter { !pairs.values.contains($0) }
    return remaining.count == 1 ? remaining.first : nil
}

func pinnedWindow(_ previous: WindowRow, rows: [WindowRow], rootBounds: CGRect) -> WindowRow? {
    let windows = rows.filter { $0.visible && $0.id == previous.id }
    guard windows.count == 1, let window = windows.first,
          window.pid == previous.pid, window.bounds == rootBounds else { return nil }
    return window
}

func observedElement<Element>(_ ref: String, in refs: [String: Element], expires: TimeInterval,
                              at uptime: TimeInterval, belongs: (Element) -> Bool) throws -> Element {
    guard uptime < expires, let element = refs[ref], belongs(element) else { throw Failure("element_unavailable") }
    return element
}

func observedTextValue(_ source: String, expanded: Bool) -> (value: String, truncated: Bool) {
    let scalars = source.unicodeScalars
    guard expanded else {
        let prefix = scalars.prefix(160)
        return (String(prefix), prefix.endIndex != scalars.endIndex)
    }
    let bytes = source.utf8
    guard var end = bytes.index(bytes.startIndex, offsetBy: 16_384, limitedBy: bytes.endIndex),
          end != bytes.endIndex else { return (source, false) }
    while end.samePosition(in: scalars) == nil { bytes.formIndex(before: &end) }
    return (String(decoding: bytes[..<end], as: UTF8.self), true)
}

enum TrustedRemoteOverlay {
    struct SigningIdentity {
        let teamID: String
        let identifier: String
        let flags: UInt32
    }

    private static let teamID = "PU9BNSBJW7"
    private static let identifier = "com.netease.uuremote.server"

    static func matches(_ row: [String: Any]) -> Bool { matches(row, verify: verify) }

    static func matches(_ row: [String: Any], verify: (pid_t) -> SigningIdentity?) -> Bool {
        guard let layer = (row[kCGWindowLayer as String] as? NSNumber)?.int32Value,
              layer >= CGWindowLevelForKey(.screenSaverWindow),
              (row[kCGWindowSharingState as String] as? NSNumber)?.intValue == 0,
              let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0,
              let signing = verify(pid) else { return false }
        return signing.teamID == teamID && signing.identifier == identifier &&
            signing.flags & SecCodeSignatureFlags.runtime.rawValue != 0
    }

    private static func verify(_ pid: pid_t) -> SigningIdentity? {
        guard let process = try? ProcessIdentity.read(pid) else { return nil }
        let expression = """
            anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and \
            certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "\(teamID)" and \
            identifier "\(identifier)"
            """
        var code: SecCode?
        var requirement: SecRequirement?
        var staticCode: SecStaticCode?
        var rawInfo: CFDictionary?
        let attributes = [kSecGuestAttributePid as String: pid] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &rawInfo) == errSecSuccess,
              let info = rawInfo as? [String: Any],
              let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
              let identifier = info[kSecCodeInfoIdentifier as String] as? String,
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
              (try? process.verify()) != nil else { return nil }
        return SigningIdentity(teamID: team, identifier: identifier, flags: flags.uint32Value)
    }
}

final class DesktopAccess: @unchecked Sendable {
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

    static func consoleSessionAvailable(requireFrontmost: Bool = false) -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
              session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session[kCGSessionLoginDoneKey as String] as? Bool == true,
              CGDisplayIsAsleep(CGMainDisplayID()) == 0 else { return false }
        let front = NSWorkspace.shared.frontmostApplication
        return (!requireFrontmost || front != nil) && front?.bundleIdentifier != "com.apple.loginwindow"
    }

    static func consoleAvailable(_ rows: [[String: Any]]?) -> Bool {
        consoleSessionAvailable(requireFrontmost: true) && visibleLayersClear(rows)
    }

    static func visibleLayersClear(_ rows: [[String: Any]]?,
                                   isWindowServer: (pid_t) -> Bool = ConsentOcclusion.isWindowServer,
                                   executablePath: (pid_t) -> String? = ConsentOcclusion.executablePath,
                                   trustedOverlay: ([String: Any]) -> Bool = TrustedRemoteOverlay.matches) -> Bool {
        guard let rows, !rows.isEmpty else { return false }
        let screenSaver = CGWindowLevelForKey(.screenSaverWindow)
        return rows.allSatisfy { row in
            guard let layer = (row[kCGWindowLayer as String] as? NSNumber)?.int32Value else { return false }
            if layer < screenSaver { return true }
            guard let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0 else { return false }
            if layer == CGWindowLevelForKey(.cursorWindow),
               row[kCGWindowOwnerName as String] as? String == "Window Server", isWindowServer(pid) { return true }
            // Consent and input perform target-specific hit testing after this console check.
            if layer >= CGShieldingWindowLevel() { return trustedOverlay(row) }
            guard let path = executablePath(pid), path.hasPrefix("/") else { return false }
            let systemPaths = ["/System/", "/usr/libexec/", "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"]
            return !systemPaths.contains { path.hasPrefix($0) }
        }
    }

    @MainActor
    static func windowHit(at point: CGPoint) -> CGWindowID? {
        guard let primary = NSScreen.screens.first else { return nil }
        let appKitPoint = CGPoint(x: point.x, y: primary.frame.maxY - point.y)
        return CGWindowID(exactly: NSWindow.windowNumber(at: appKitPoint, belowWindowWithWindowNumber: 0))
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

private func focusedRoot(_ app: AXUIElement) -> AXUIElement? {
    guard let root = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(root) == AXUIElementGetTypeID()
    else { return nil }
    return (root as! AXUIElement)
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

private func eligibleRoot(_ root: AXUIElement, pid: pid_t) -> CGRect? {
    AXUIElementSetMessagingTimeout(root, 0.06)
    guard owner(root) == pid, attribute(root, kAXRoleAttribute) as? String == kAXWindowRole,
          attribute(root, kAXMinimizedAttribute) as? Bool == false,
          attribute(root, kAXModalAttribute) as? Bool != true else { return nil }
    return boundsOfRoot(root)
}

func validBounds(_ bounds: CGRect) -> Bool {
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, bounds.width, bounds.height].allSatisfy(\.isFinite) &&
        bounds.width > 0 && bounds.height > 0
}

// The window worker owns both indexes. Capture delegates invalidate their stream
// before they enqueue removal, so a queued operation cannot use an ended stream.
struct WindowBindings<Context> {
    struct Binding {
        let id: String
        let window: CGWindowID
        let capture: any ControlCapture
        var context: Context
    }

    private var bindings: [String: Binding] = [:]
    private var owners: [CGWindowID: String] = [:]

    var count: Int { bindings.count }
    var activeContexts: [Context] { bindings.values.filter { $0.capture.isActive }.map(\.context) }

    mutating func requireAvailable(_ window: CGWindowID, stillMatches: (Context) -> Bool = { _ in true }) throws {
        guard let id = owners[window] else { return }
        if let binding = bindings[id], binding.capture.isActive, stillMatches(binding.context) {
            throw Failure("window_already_bound")
        }
        remove(id)
    }

    mutating func bind(window: CGWindowID, context: Context,
                       makeCapture: (@escaping @Sendable () -> Void) throws -> any ControlCapture,
                       onEnd: @escaping @Sendable (String) -> Void, check: () throws -> Void) throws -> String {
        try requireAvailable(window)
        try check()
        let id = UUID().uuidString
        let capture = try makeCapture { onEnd(id) }
        do {
            try capture.start(check: check)
            try check()
            guard capture.isActive else { throw Failure("capture_failed") }
        } catch {
            capture.stop()
            throw error
        }
        bindings[id] = Binding(id: id, window: window, capture: capture, context: context)
        owners[window] = id
        return id
    }

    mutating func current(_ id: String) throws -> Binding {
        guard let value = bindings[id], value.capture.isActive else {
            remove(id)
            throw Failure("binding_unavailable")
        }
        return value
    }

    mutating func update(_ value: Binding) { bindings[value.id] = value }

    mutating func unbind(_ id: String) throws {
        guard let value = bindings[id], value.capture.isActive else {
            remove(id)
            throw Failure("binding_not_found")
        }
        remove(id)
    }

    mutating func remove(_ id: String) {
        guard let value = bindings.removeValue(forKey: id) else { return }
        owners.removeValue(forKey: value.window)
        value.capture.stop()
    }

    mutating func stopAll() {
        let previous = bindings
        bindings.removeAll()
        owners.removeAll()
        for value in previous.values { value.capture.stop() }
    }
}

// The serial window worker owns all mutable window state.
final class Windows: @unchecked Sendable {
    private struct Match {
        let row: WindowRow
        let identity: ProcessIdentity
        let root: AXUIElement
        let app: NSRunningApplication
    }

    private struct Context {
        let match: Match
        var refs: [String: AXUIElement] = [:]
        var expires: TimeInterval = 0
    }

    private typealias Binding = WindowBindings<Context>.Binding
    private var bindings = WindowBindings<Context>()
    var bindingCount: Int { bindings.count }
    let access: DesktopAccess
    let live: () throws -> Void
    private let worker: DispatchQueue
    private let onRevocation: @Sendable (Int) -> Void

    init(worker: DispatchQueue, access: DesktopAccess, live: @escaping () throws -> Void,
         onRevocation: @escaping @Sendable (Int) -> Void) {
        self.worker = worker
        self.access = access
        self.live = live
        self.onRevocation = onRevocation
    }

    func stopAll() { bindings.stopAll() }

    private func captureEnded(_ id: String) {
        bindings.remove(id)
        onRevocation(bindingCount)
    }

    func unbind(_ id: String) throws -> [String: Any] {
        try live()
        try bindings.unbind(id)
        return ["binding": id, "released": true]
    }

    static func onScreen() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    }

    private func rows() throws -> [WindowRow] {
        try live()
        guard AXIsProcessTrusted() else { throw Failure("accessibility_permission_required") }
        guard let raw = Self.onScreen() else { throw Failure("console_unavailable") }
        try access.check(rows: raw)
        return raw.compactMap {
            guard $0[kCGWindowIsOnscreen as String] as? Bool == true,
                  ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let id = ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id != 0,
                  let pid = ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != getpid(),
                  let dictionary = $0[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), validBounds(bounds)
            else { return nil }
            return WindowRow(id: id, pid: pid, bounds: bounds, title: $0[kCGWindowName as String] as? String)
        }
    }

    private func applicationRoots(_ axApp: AXUIElement) -> [AXUIElement]? {
        AXUIElementSetMessagingTimeout(axApp, 0.06)
        guard let roots = elements(axApp, kAXWindowsAttribute, limit: 129), roots.count <= 128 else { return nil }
        return roots
    }

    private func matches(_ rows: [WindowRow], pid: pid_t, deadline: TimeInterval) -> [Match] {
        guard let identity = try? ProcessIdentity.read(pid), identity.uid == getuid(),
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.activationPolicy == .regular, let bundleID = app.bundleIdentifier, bundleID != "com.apple.loginwindow",
              let executable = app.executableURL?.path, canonicalPath(executable) == identity.executable else { return [] }

        let axApp = AXUIElementCreateApplication(pid)
        guard let roots = applicationRoots(axApp) else { return [] }
        var verifiedRoots: [AXUIElement] = []
        var candidates: [WindowRoot] = []
        for root in roots {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return [] }
            guard let bounds = eligibleRoot(root, pid: pid) else { continue }
            verifiedRoots.append(root)
            candidates.append(WindowRoot(bounds: bounds, title: attribute(root, kAXTitleAttribute) as? String))
        }
        var focused: Int?
        if app.isActive, let root = focusedRoot(axApp), app.isActive {
            focused = verifiedRoots.firstIndex { CFEqual($0, root) }
        }
        var pinned: [CGWindowID: Int] = [:]
        for context in bindings.activeContexts where context.match.identity == identity {
            if let index = verifiedRoots.firstIndex(where: { CFEqual($0, context.match.root) }) {
                pinned[context.match.row.id] = index
            }
        }
        guard (try? identity.verify()) != nil else { return [] }
        return rows.compactMap { row in
            guard ProcessInfo.processInfo.systemUptime < deadline, row.pid == pid,
                  let index = uniqueRoot(row, rows: rows, roots: candidates, pinned: pinned, focused: focused,
                                         chromeTitles: bundleID == "com.google.Chrome") else { return nil }
            return Match(row: row, identity: identity, root: verifiedRoots[index], app: app)
        }
    }

    static func metadata(_ row: WindowRow, appName: String, bundleId: String, bundleName: String,
                         title: String) -> [String: Any] {
        let bounds = row.bounds
        return ["window": row.id, "appName": String(appName.unicodeScalars.prefix(128)),
                "bundleId": String(bundleId.unicodeScalars.prefix(128)),
                "bundleName": String(bundleName.unicodeScalars.prefix(128)), "title": title,
                "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height]]
    }

    private func metadata(_ match: Match) -> [String: Any] {
        Self.metadata(match.row, appName: match.app.localizedName ?? "", bundleId: match.app.bundleIdentifier ?? "",
                      bundleName: match.app.bundleURL?.deletingPathExtension().lastPathComponent ?? "",
                      title: text(match.root, kAXTitleAttribute) ?? "")
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
        try live()
        try bindings.requireAvailable(id) { (try? sameWindow($0.match)) != nil }
        let rows = try rows()
        try requireRecording()
        guard let row = rows.first(where: { $0.id == id }),
              let match = matches(rows, pid: row.pid, deadline: ProcessInfo.processInfo.systemUptime + 0.5)
                .first(where: { $0.row.id == id }) else { throw Failure("window_unavailable") }
        let metadata = metadata(match)
        let filter = try captureFilter(for: match, check: live)
        let binding = try bindings.bind(window: id, context: Context(match: match), makeCapture: {
            try ScreenControlCapture(filter: filter, onEnd: $0)
        }, onEnd: { [weak self, worker] id in
            guard let self else { return }
            worker.async { self.captureEnded(id) }
        }, check: { [self] in
            try checkCaptureAccess(match)
        })
        do {
            _ = try revalidate(bindings.current(binding))
        } catch {
            bindings.remove(binding)
            throw error
        }
        return ["binding": binding, "window": metadata]
    }

    private func requireRecording() throws {
        try access.recording(granted: CGPreflightScreenCaptureAccess(), required: true)
    }

    private func checkCaptureAccess(_ match: Match) throws {
        try live()
        try access.check()
        try requireRecording()
        try match.identity.verify()
    }

    private func sameWindow(_ previous: Match) throws -> Match {
        let rows = try rows()
        try previous.identity.verify()
        let app = AXUIElementCreateApplication(previous.identity.pid)
        guard let roots = applicationRoots(app), roots.contains(where: { CFEqual($0, previous.root) }),
              let bounds = eligibleRoot(previous.root, pid: previous.identity.pid),
              let row = pinnedWindow(previous.row, rows: rows, rootBounds: bounds) else {
            throw Failure("window_unavailable")
        }
        try previous.identity.verify()
        return Match(row: row, identity: previous.identity, root: previous.root, app: previous.app)
    }

    private func checkLive(_ binding: Binding) throws {
        try live()
        guard binding.capture.isActive else { throw Failure("binding_unavailable") }
    }

    private func revalidate(_ value: Binding) throws -> Match {
        do {
            try checkLive(value)
            let match = try sameWindow(value.context.match)
            try checkLive(value)
            return match
        } catch {
            bindings.remove(value.id)
            throw error
        }
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

    func observe(_ id: String, element: String?, screenshot: Bool) throws -> ([String: Any], Wire.Image?) {
        var value = try bindings.current(id)
        let match = try revalidate(value)
        let now = ProcessInfo.processInfo.systemUptime
        let deadline = now + 0.6
        let previous = value.context.expires > now ? value.context.refs : [:]
        let root = try element.map { ref in
            try observedElement(ref, in: previous, expires: value.context.expires, at: now) { belongs($0, to: match) }
        } ?? match.root
        var refs: [String: AXUIElement] = [:]
        var truncated = false
        var expandedValue: (value: String, truncated: Bool)?

        func visit(_ node: AXUIElement, depth: Int) throws -> [String: Any]? {
            try checkLive(value)
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
                    let preview = observedTextValue(string, expanded: false)
                    tree["value"] = preview.value
                    if preview.truncated {
                        tree["valueTruncated"] = true
                        if depth > 0 { truncated = true }
                        if depth == 0, element != nil {
                            expandedValue = observedTextValue(string, expanded: true)
                        }
                    }
                } else if let number = raw as? NSNumber, number.doubleValue.isFinite {
                    tree["value"] = number
                }
            }
            let children = elements(node, kAXChildrenAttribute, limit: 97) ?? []
            if children.count > 96 { truncated = true }
            tree["children"] = try children.prefix(96).compactMap { try visit($0, depth: depth + 1) }
            return tree
        }

        guard var tree = try visit(root, depth: 0) else {
            throw Failure(element == nil ? "window_unavailable" : "element_unavailable")
        }
        if let expandedValue {
            var expanded = tree
            expanded["value"] = expandedValue.value
            expanded["valueTruncated"] = expandedValue.truncated ? true : nil
            // Leave space for the RPC envelope and optional screenshot metadata.
            if let encoded = try? JSONSerialization.data(withJSONObject: expanded),
               encoded.count <= Wire.metadataLimit - 2_048 {
                tree = expanded
            }
        }
        if tree["valueTruncated"] as? Bool == true { truncated = true }
        let image = screenshot ? try capture(value) : nil
        _ = try revalidate(value)
        value.context.refs = refs
        value.context.expires = ProcessInfo.processInfo.systemUptime + 15
        bindings.update(value)
        return (["binding": id, "tree": tree, "truncated": truncated, "refTTLms": 15_000], image)
    }

    func act(_ id: String, element ref: String, action: String, input: Request.Value?) throws -> [String: Any] {
        let value = try bindings.current(id)
        let match = try revalidate(value)
        let node = try observedElement(ref, in: value.context.refs, expires: value.context.expires,
                                       at: ProcessInfo.processInfo.systemUptime) { belongs($0, to: match) }
        guard let role = text(node, kAXRoleAttribute) else { throw Failure("element_unavailable") }
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
        guard value.context.expires > ProcessInfo.processInfo.systemUptime,
              belongs(node, to: latest), actions(node, role: role).contains(action),
              text(node, kAXRoleAttribute) == role else { throw Failure("element_unavailable") }
        try access.check()
        let status = try value.capture.whileActive {
            try live()
            if let property {
                return AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, property)
            }
            let name = action == "press" ? kAXPressAction : action == "increment" ? kAXIncrementAction : kAXDecrementAction
            return AXUIElementPerformAction(node, name as CFString)
        }
        if status == .cannotComplete { throw Failure("action_outcome_unknown") }
        guard status == .success else { throw Failure("action_rejected") }
        return ["binding": id, "dispatched": true]
    }

    static func verifyKeyboardTarget(_ target: AXUIElement, focused: AXUIElement?,
                                     recover: () throws -> AXUIElement? = { nil }) throws {
        // PID-directed keys follow the app's focus, which can belong to a sibling window.
        if let focused, CFEqual(focused, target) { return }
        guard let recovered = try recover(), CFEqual(recovered, target) else {
            throw Failure("window_focus_unavailable")
        }
    }

    func input(_ id: String, _ action: WindowInput) throws -> [String: Any] {
        let value = try bindings.current(id)
        let match = try revalidate(value)
        let row = match.row
        let app = AXUIElementCreateApplication(row.pid)
        AXUIElementSetMessagingTimeout(app, 0.06)
        var firstKeyboardBatch = true

        try action.execute(window: row, locate: { try WindowInput.global($0, in: row.bounds) },
                           lookupKey: { name, flags in
            DispatchQueue.main.sync { WindowInput.physicalKey(name, flags: flags) }
        }, send: { point, events in
            try match.identity.verify()
            try requireRecording()
            try checkLive(value)
            guard let rows = Self.onScreen() else { throw Failure("console_unavailable") }
            try access.check(rows: rows)
            if let point {
                var count: UInt32 = 0
                guard CGGetDisplaysWithPoint(point, 0, nil, &count) == .success, count > 0 else {
                    throw Failure("window_coordinate_out_of_bounds")
                }
            }
            try WindowInput.verifyStack(rows, target: row, point: point, isWindowServer: ConsentOcclusion.isWindowServer,
                                        hitsTarget: { point in
                DispatchQueue.main.sync { DesktopAccess.windowHit(at: point) == row.id }
            })
            if point == nil {
                let focused = focusedRoot(app)
                try Self.verifyKeyboardTarget(match.root, focused: focused) {
                    guard firstKeyboardBatch, let focused, eligibleRoot(focused, pid: row.pid) != nil,
                          eligibleRoot(match.root, pid: row.pid) == row.bounds else { return nil }
                    try match.identity.verify()
                    try requireRecording()
                    return try value.capture.whileActive {
                        try live()
                        // Switching a foreground sibling would move the user's keyboard focus.
                        guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != row.pid,
                              !match.app.isActive,
                              AXUIElementSetAttributeValue(match.root, kAXMainAttribute as CFString, kCFBooleanTrue)
                                == .success else { return nil }
                        let recovered = focusedRoot(app)
                        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == front.processIdentifier
                        else { return nil }
                        return recovered
                    }
                }
                firstKeyboardBatch = false
            }
            try match.identity.verify()
            try requireRecording()
            try value.capture.whileActive {
                try live()
                for event in events { event.postToPid(row.pid) }
            }
        }, release: { event in
            // Drag cleanup runs before the input slot drains, even after admission closes.
            try WindowInput.releaseDrag(event, identity: match.identity) { $0.postToPid(row.pid) }
        })
        return ["binding": id, "dispatched": true]
    }

    private func captureFilter(for previous: Match, check: () throws -> Void) throws -> SCContentFilter {
        try check()
        let content: SCShareableContent = try captureCall(check: check) {
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true, completionHandler: $0)
        }
        let match = try sameWindow(previous)
        let windows = content.windows.filter {
            $0.windowID == match.row.id && $0.owningApplication?.processID == match.identity.pid &&
                $0.isOnScreen && $0.frame == match.row.bounds
        }
        guard windows.count == 1, let window = windows.first else { throw Failure("window_unavailable") }
        try checkCaptureAccess(match)
        return SCContentFilter(desktopIndependentWindow: window)
    }

    private func capture(_ value: Binding) throws -> Wire.Image {
        try requireRecording()
        let filter = try captureFilter(for: value.context.match) { try checkLive(value) }
        try checkLive(value)
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
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        try requireRecording()
        let image: CGImage = try captureCall(check: { try checkLive(value) }) {
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config, completionHandler: $0)
        }
        try checkLive(value)
        try requireRecording()
        try Wire.Image.checkSize(image.width, image.height)
        let png = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(png as CFMutableData, UTType.png.identifier as CFString, 1, nil)
        else { throw Failure("capture_failed") }
        CGImageDestinationAddImage(writer, image, nil)
        guard CGImageDestinationFinalize(writer) else { throw Failure("capture_failed") }
        return try Wire.Image(png: png as Data, width: image.width, height: image.height)
    }

    private func captureCall<T>(check: () throws -> Void, _ start: (@escaping @Sendable (T?, Error?) -> Void) -> Void) throws -> T {
        let result = CaptureResult<T>()
        start { value, _ in result.complete(value) }
        let deadline = DispatchTime.now() + .seconds(3)
        while result.ready.wait(timeout: .now() + .milliseconds(50)) == .timedOut {
            try check()
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

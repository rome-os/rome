import AppKit
import Darwin.libproc
import Foundation

enum ConsentOcclusion {
    private static let windowServerPath = canonicalPath("/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer")
    static let alertLevel = Int(CGWindowLevelForKey(.screenSaverWindow)) - 1

    static func isWindowServer(_ pid: pid_t) -> Bool {
        guard let path = windowServerPath else { return false }
        // A process name alone does not authenticate the Window Server.
        return executablePath(pid) == path
    }

    static func executablePath(_ pid: pid_t) -> String? {
        var bytes = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &bytes, UInt32(bytes.count))
        guard length > 0 else { return nil }
        return String(bytes: bytes.prefix(Int(length)), encoding: .utf8)
    }

    static func bounds(_ row: [String: Any]) -> CGRect? {
        guard let dictionary = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              [bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height].allSatisfy(\.isFinite),
              bounds.size.width >= 0, bounds.size.height >= 0 else { return nil }
        return bounds
    }

    static func isHiddenParent(_ id: CGWindowID, surfaces: [CGWindowID], info: [String: Any]?,
                               onScreen: [[String: Any]]) -> Bool {
        surfaces.count > 1 && surfaces.first == id && info?[kCGWindowIsOnscreen as String] as? Bool != true &&
            !onScreen.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
    }

    static func ownsAlertSurface(_ row: [String: Any], id: CGWindowID, pid: pid_t) -> Bool {
        (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id &&
            (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
            (row[kCGWindowLayer as String] as? NSNumber)?.intValue == alertLevel
    }

    static func clear(alertBounds: CGRect?, above: ArraySlice<[String: Any]>?, helperPID: pid_t,
                      isWindowServer: (pid_t) -> Bool,
                      allowsOverlay: ([String: Any]) -> Bool = { _ in false }) -> Bool {
        guard let alertBounds, !alertBounds.isEmpty, let above else { return false }
        return above.allSatisfy { row in
            guard let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return false }
            if pid == helperPID { return true }
            if (row[kCGWindowLayer as String] as? NSNumber)?.int32Value == CGWindowLevelForKey(.cursorWindow),
               row[kCGWindowOwnerName as String] as? String == "Window Server", isWindowServer(pid) { return true }
            guard let bounds = bounds(row) else { return false }
            return bounds.isEmpty || !alertBounds.intersects(bounds) || allowsOverlay(row)
        }
    }
}

struct ConsentVisibility: Sendable {
    let surfaces: [CGWindowID]
    let backingWindow: CGWindowID?
    let needsHitTest: Bool

    func acceptsHit(_ id: CGWindowID?, backingIsCurrent: Bool) -> Bool {
        guard let id, !surfaces.isEmpty else { return false }
        return surfaces.contains(id) || (id == backingWindow && backingIsCurrent)
    }
}

struct ConsentUnlock {
    enum State: Equatable {
        case needsFocus, occluded, checking, ready
    }

    static let dwell: TimeInterval = 0.5

    private var focusedSince: TimeInterval?
    private var lastMouseDown: TimeInterval?
    private var pendingClick: (count: Int, interval: TimeInterval?)?
    private var pendingKey = false

    mutating func reset() {
        focusedSince = nil
        pendingClick = nil
        pendingKey = false
    }

    mutating func update(focused: Bool, at uptime: TimeInterval) -> Bool {
        guard focused else {
            reset()
            return false
        }
        let since = focusedSince ?? uptime
        focusedSince = since
        return uptime - since >= Self.dwell
    }

    mutating func state(eligible: Bool = true, focused: Bool, raised: Bool, at uptime: TimeInterval) -> State? {
        guard eligible else {
            reset()
            return nil
        }
        if update(focused: focused && raised, at: uptime) { return .ready }
        if !raised { return .occluded }
        return focused ? .checking : .needsFocus
    }

    mutating func mouseDown(at uptime: TimeInterval, clickCount: Int, enabled: Bool) {
        guard enabled, uptime.isFinite, uptime > (lastMouseDown ?? 0) else {
            reset()
            return
        }
        let interval = lastMouseDown.map { uptime - $0 }
        lastMouseDown = uptime
        pendingClick = (clickCount, interval)
        pendingKey = false
    }

    mutating func keyDown(enabled: Bool, isRepeat: Bool = false) {
        if enabled && !isRepeat {
            pendingClick = nil
            pendingKey = true
        } else {
            reset()
        }
    }

    mutating func accept(currentClickCount: Int?, doubleClickInterval: TimeInterval) -> Bool {
        let singleClick = pendingClick.map { click in
            (0...1).contains(click.count) && (click.interval ?? .infinity) > doubleClickInterval
        } ?? (pendingKey && currentClickCount == nil)
        guard singleClick, (0...1).contains(currentClickCount ?? 1) else {
            reset()
            return false
        }
        pendingClick = nil
        pendingKey = false
        return true
    }

    mutating func revalidate(clear: Bool, focused: Bool, eligible: Bool, at uptime: TimeInterval) -> Bool {
        guard clear, focused, eligible, let focusedSince, uptime - focusedSince >= Self.dwell else {
            reset()
            return false
        }
        return true
    }
}

enum ConsentCountdown {
    static func seconds(until deadline: DispatchTime, now: DispatchTime = .now()) -> Int {
        guard deadline > now else { return 0 }
        let remaining = deadline.uptimeNanoseconds - now.uptimeNanoseconds
        return Int((remaining - 1) / 1_000_000_000 + 1)
    }

    static func title(_ locale: HelperLocale, seconds: Int) -> String {
        "\(locale[.deny]) (\(seconds)s)"
    }
}

struct ConsentPoll {
    private var generation: UInt64 = 0
    private var inFlight = false
    private var active = false

    mutating func start() {
        invalidate()
        active = true
    }

    mutating func invalidate() { generation &+= 1 }

    mutating func stop() {
        invalidate()
        active = false
    }

    mutating func begin() -> UInt64? {
        guard active, !inFlight else { return nil }
        inFlight = true
        return generation
    }

    mutating func finish(_ token: UInt64) -> Bool {
        inFlight = false
        return active && token == generation
    }
}

extension ConsentDecision {
    var buttonTitle: HelperLocale.Text {
        switch self {
        case .deny: .deny
        case .allowSession: .allowSession
        case .allowPersistent: .allowPersistent
        }
    }
}

extension ConsentPrompt {
    var accessText: String { locale[.access] }

    var persistentNotice: String? {
        guard let controller, mode.choices.contains(.allowPersistent) else { return nil }
        return controller.scope == .local ? locale[.localRisk] : locale[.persistentAccess] + " " + locale[.remoteRisk]
    }

    var fingerprintLines: String? {
        guard let controller else { return nil }
        let groups = controller.key.fingerprint.split(separator: "-")
        return [groups.prefix(4), groups.dropFirst(4)].map {
            locale.keyFingerprint($0.joined(separator: "-"))
        }.joined(separator: "\n")
    }

    var verifiedExecutable: String { auditDisplayValue(host.executable) }

    var verifiedSigningIdentifier: String {
        signingSummary.map { auditDisplayValue($0.identifier) } ?? locale[.signingUnavailable]
    }

    var verifiedTeam: String {
        signingSummary?.teamID.map(auditDisplayValue) ?? locale[signingSummary?.isAdHoc == true ? .adHoc : .noTeamID]
    }
}

func auditDisplayValue(_ text: String) -> String {
    var visible = ""
    for scalar in text.unicodeScalars {
        if scalar == "\\" {
            visible += "\\\\"
            continue
        }
        switch scalar.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator:
            visible += "\\u{\(String(scalar.value, radix: 16))}"
        default:
            visible.unicodeScalars.append(scalar)
        }
    }
    return visible
}

@MainActor
private final class ConsentAccessory {
    let view = NSView()
    private let stack = NSStackView()
    private let width: CGFloat = 248

    init(prompt: ConsentPrompt) {
        let locale = prompt.locale
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            stack.widthAnchor.constraint(equalToConstant: width),
        ])

        let explanation = [prompt.accessText, prompt.persistentNotice].compactMap { $0 }.joined(separator: "\n")
        append(label(explanation))

        let host = prompt.host
        let running = NSRunningApplication(processIdentifier: host.pid)
        let icon = NSImageView(image: running?.icon ?? NSWorkspace.shared.icon(forFile: host.executable))
        icon.imageScaling = .scaleProportionallyDown
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 16),
                                     icon.heightAnchor.constraint(equalToConstant: 16)])
        let name = auditDisplayValue(URL(fileURLWithPath: host.executable).lastPathComponent)
        let processName = label("\(locale.sourceLabel(name)) (PID \(host.pid))", width: width - 22)
        processName.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        let process = NSStackView(views: [icon, processName])
        process.orientation = .horizontal
        process.alignment = .centerY
        process.spacing = 6
        process.setAccessibilityLabel(locale[.process])
        append(process)

        let pathCaption = locale[.executable] + "  "
        let path = label(pathCaption + prompt.verifiedExecutable)
        let pathText = NSMutableAttributedString(string: path.stringValue, attributes: [.font: path.font!])
        pathText.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor,
                              range: NSRange(location: 0, length: pathCaption.utf16.count))
        path.attributedStringValue = pathText
        path.lineBreakMode = .byCharWrapping
        path.isSelectable = true
        append(path)
        let pairWidth = (width - 8) / 2
        let pair = NSStackView(views: [
            group(locale[.signingIdentifier], value: prompt.verifiedSigningIdentifier, width: pairWidth),
            group(locale[.teamID], value: prompt.verifiedTeam, width: pairWidth),
        ])
        pair.orientation = .horizontal
        pair.alignment = .top
        pair.spacing = 8
        append(pair)

        if let fingerprint = prompt.fingerprintLines {
            let value = label(fingerprint, width: 136)
            value.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
            value.isSelectable = true
            let title = label(locale[.fingerprint], width: width - 144, color: .secondaryLabelColor)
            let key = NSStackView(views: [title, value])
            key.orientation = .horizontal
            key.alignment = .top
            key.spacing = 8
            append(key)
        }
        if let name = prompt.claimedSource {
            append(label("\(locale[.claimedSource]): \(locale.sourceLabel(name))", color: .secondaryLabelColor))
        }

        stack.layoutSubtreeIfNeeded()
        view.setFrameSize(CGSize(width: width, height: ceil(stack.fittingSize.height)))
        view.layoutSubtreeIfNeeded()
    }

    private func label(_ text: String, width: CGFloat? = nil, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        field.textColor = color
        field.maximumNumberOfLines = 0
        field.lineBreakMode = .byWordWrapping
        field.preferredMaxLayoutWidth = width ?? self.width
        field.widthAnchor.constraint(equalToConstant: field.preferredMaxLayoutWidth).isActive = true
        return field
    }

    private func append(_ block: NSView) {
        stack.addArrangedSubview(block)
    }

    private func group(_ caption: String, value: String, width: CGFloat) -> NSStackView {
        let field = label(value, width: width)
        field.isSelectable = true
        let group = NSStackView(views: [label(caption, width: width, color: .secondaryLabelColor), field])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = 1
        return group
    }
}

func revokeTrustedKeys(admission: Admission, persistent: Bool, remove: () throws -> Void, reportFailure: (String) -> Void) {
    // Seal window admission before touching Keychain. The stop handler only enqueues cleanup.
    if persistent { _ = admission.stop("key_revoked") }
    do { try remove() }
    catch {
        reportFailure((error as? Failure)?.code ?? "key_store_unavailable")
        return
    }
    if persistent { admission.terminate("key_revoked") }
}

@MainActor
final class DesktopSession: NSObject, NSMenuDelegate {
    private let admission: Admission
    private let store: any TrustedKeyStore
    private let consentQueue = DispatchQueue(label: "com.rome.computer-use.consent-visibility", qos: .userInteractive)
    private var consentPoll = ConsentPoll()
    private var unlock = ConsentUnlock()
    private var answer: ((NSButton) -> Void)?
    private var statusItem: NSStatusItem?
    private var windowItem: NSMenuItem?
    private var authorization: SessionAuthorization?
    private var revocationItems: [NSMenuItem] = []
    private var presentingRevocationError = false
    private var pendingExitCode: Int32?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lockObserver: NSObjectProtocol?

    init(admission: Admission, store: any TrustedKeyStore) {
        self.admission = admission
        self.store = store
        super.init()
        let unavailable: @Sendable (Notification) -> Void = { _ in
            admission.terminate("console_unavailable")
        }
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification,
            NSWorkspace.screensDidSleepNotification,
        ].map { workspace.addObserver(forName: $0, object: nil, queue: nil, using: unavailable) }
        lockObserver = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: nil, using: unavailable)
    }

    func confirm(_ prompt: ConsentPrompt, canContinue: @escaping @Sendable () -> Bool) throws -> ConsentDecision {
        let eligible: @Sendable () -> Bool = {
            canContinue() && DesktopAccess.consoleSessionAvailable()
        }
        guard eligible() else { throw prompt.interruption }
        var remaining = ConsentCountdown.seconds(until: prompt.deadline)
        guard remaining > 0 else { throw Failure("consent_expired") }
        let locale = prompt.locale
        let alert = NSAlert()
        alert.alertStyle = .informational
        if let iconURL = Bundle.main.url(forResource: "icon", withExtension: "icns") {
            alert.icon = NSImage(contentsOf: iconURL)
        }
        alert.messageText = locale[.title]
        alert.informativeText = ""
        let choices = prompt.mode.choices
        let buttons = choices.map { decision in
            let title = decision == .deny ? ConsentCountdown.title(locale, seconds: remaining) : locale[decision.buttonTitle]
            let button = alert.addButton(withTitle: title)
            button.tag = decision.rawValue
            button.keyEquivalent = decision == .deny ? "\r" : ""
            button.isEnabled = decision == .deny
            button.target = self
            button.action = #selector(answerConsent)
            return button
        }
        let deny = buttons[0]
        deny.font = .monospacedDigitSystemFont(ofSize: deny.font?.pointSize ?? NSFont.systemFontSize, weight: .semibold)
        let protected = buttons.dropFirst()
        consentPoll.start()
        defer { consentPoll.stop() }
        unlock = ConsentUnlock()
        let setEnabled: @MainActor @Sendable (Bool) -> Void = { ready in
            protected.forEach { if $0.isEnabled != ready { $0.isEnabled = ready } }
        }
        let reset: @MainActor @Sendable () -> Void = {
            self.consentPoll.invalidate()
            self.unlock.reset()
            setEnabled(false)
        }
        let accessory = ConsentAccessory(prompt: prompt)
        alert.accessoryView = accessory.view
        alert.layout()
        let window = alert.window
        let level = NSWindow.Level(rawValue: ConsentOcclusion.alertLevel)
        window.level = level
        window.defaultButtonCell = deny.cell as? NSButtonCell
        window.makeFirstResponder(deny)

        let app = NSApplication.shared
        let focus: @MainActor @Sendable () -> Void = {
            window.makeKeyAndOrderFront(nil)
            if !app.isActive { _ = NSRunningApplication.current.activate(options: []) }
        }
        let sample: @Sendable ([CGWindowID]?) -> ConsentVisibility? = { ids in
            guard let ids, let onScreen = Windows.onScreen(), DesktopAccess.consoleAvailable(onScreen) else { return nil }
            return Self.visibility(ids, onScreen: onScreen)
        }
        let clear: @MainActor @Sendable (ConsentVisibility?) -> Bool = { visibility in
            guard let visibility, let screen = window.screen, screen.visibleFrame.contains(window.frame) else { return false }
            guard visibility.needsHitTest else { return true }
            let dialogCenter = CGPoint(x: window.frame.midX, y: window.frame.midY)
            let buttonCenters = buttons.compactMap { button -> CGPoint? in
                guard let host = button.window else { return nil }
                let rect = host.convertToScreen(button.convert(button.bounds, to: nil))
                return CGPoint(x: rect.midX, y: rect.midY)
            }
            guard buttonCenters.count == buttons.count else { return false }
            return ([dialogCenter] + buttonCenters).allSatisfy { point in
                let number = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
                let backingIsCurrent = app.window(withWindowNumber: number) === window && window.level == level
                return visibility.acceptsHit(CGWindowID(exactly: number), backingIsCurrent: backingIsCurrent)
            }
        }
        let revalidate: @MainActor () -> Bool = {
            let visible = clear(sample(Self.surfaceIDs(window)))
            return self.unlock.revalidate(clear: visible,
                                   focused: window.isKeyWindow && app.isActive, eligible: eligible(),
                                   at: ProcessInfo.processInfo.systemUptime)
        }
        answer = { sender in
            guard sender.isEnabled, buttons.contains(where: { $0 === sender }) else { return }
            if sender === deny {
                app.stopModal(withCode: .init(rawValue: ConsentDecision.deny.rawValue))
                return
            }
            // AppKit can deliver a control action after currentEvent has changed.
            let clickCount = app.currentEvent.flatMap { event in
                event.type == .leftMouseDown || event.type == .leftMouseUp ? event.clickCount : nil
            }
            guard revalidate() else {
                reset()
                if !eligible() { app.abortModal() }
                return
            }
            guard self.unlock.accept(currentClickCount: clickCount, doubleClickInterval: NSEvent.doubleClickInterval) else {
                reset()
                return
            }
            app.stopModal(withCode: .init(rawValue: sender.tag))
        }
        defer { answer = nil }

        guard let inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .keyDown], handler: { event in
            MainActor.assumeIsolated {
                guard event.windowNumber == window.windowNumber ||
                        window.childWindows?.contains(where: { $0.isVisible && $0.windowNumber == event.windowNumber }) == true else { return }
                let focused = app.isActive && window.isKeyWindow
                let enabled = focused && protected.allSatisfy(\.isEnabled)
                if event.type == .leftMouseDown {
                    self.unlock.mouseDown(at: ProcessInfo.processInfo.systemUptime, clickCount: event.clickCount, enabled: enabled)
                    if !focused {
                        reset()
                        focus()
                    }
                } else {
                    self.unlock.keyDown(enabled: enabled, isRepeat: event.isARepeat)
                    if event.isARepeat { setEnabled(false) }
                }
            }
            return event
        }) else { throw Failure("cancelled") }
        defer { NSEvent.removeMonitor(inputMonitor) }

        let raise: @MainActor @Sendable () -> Void = {
            // AppKit can assign the modal-panel level when it presents the alert.
            if window.level != level { window.level = level }
            for child in window.childWindows ?? [] where child.level != level { child.level = level }
        }
        let onChange: @Sendable (Notification) -> Void = { _ in MainActor.assumeIsolated { reset() } }
        let notifications = NotificationCenter.default
        let becomeKey = notifications.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window,
                                                   queue: nil) { _ in MainActor.assumeIsolated { raise() } }
        let windowChanges = [NSWindow.didResignKeyNotification, NSWindow.didMoveNotification, NSWindow.didResizeNotification].map {
            notifications.addObserver(forName: $0, object: window, queue: nil, using: onChange)
        }
        let becomeActive = notifications.addObserver(forName: NSApplication.didBecomeActiveNotification, object: app,
                                                      queue: nil) { _ in MainActor.assumeIsolated {
            reset()
            window.makeKeyAndOrderFront(nil)
            raise()
        } }
        let resignActive = notifications.addObserver(forName: NSApplication.willResignActiveNotification, object: app,
                                                      queue: nil, using: onChange)
        defer {
            notifications.removeObserver(becomeKey)
            windowChanges.forEach(notifications.removeObserver)
            notifications.removeObserver(becomeActive)
            notifications.removeObserver(resignActive)
        }

        let requestSample: @MainActor @Sendable () -> Void = {
            guard let token = self.consentPoll.begin() else { return }
            let ids = Self.surfaceIDs(window)
            self.consentQueue.async {
                let live = eligible()
                let visibility = live ? sample(ids) : nil
                // The modal runs inside a main-queue block, so deliver through its run loop.
                let runLoop = CFRunLoopGetMain()
                let modes = [RunLoop.Mode.default.rawValue, RunLoop.Mode.modalPanel.rawValue, RunLoop.Mode.eventTracking.rawValue]
                CFRunLoopPerformBlock(runLoop, modes as CFArray) {
                    MainActor.assumeIsolated {
                        guard self.consentPoll.finish(token) else { return }
                        if !live {
                            reset()
                            app.abortModal()
                            return
                        }
                        let focused = window.isKeyWindow && app.isActive
                        let state = self.unlock.state(focused: focused,
                                                      raised: focused && ids == Self.surfaceIDs(window) && clear(visibility),
                                                      at: ProcessInfo.processInfo.systemUptime)
                        setEnabled(state == .ready)
                    }
                }
                CFRunLoopWakeUp(runLoop)
            }
        }
        var firstTick = true
        let timer = Timer(timeInterval: 0.05, repeats: true) { _ in
            MainActor.assumeIsolated {
                let seconds = ConsentCountdown.seconds(until: prompt.deadline)
                if seconds != remaining {
                    remaining = seconds
                    deny.title = ConsentCountdown.title(locale, seconds: seconds)
                }
                guard seconds > 0 else {
                    reset()
                    app.abortModal()
                    return
                }
                raise()
                // A background launch can require LaunchServices to foreground the running app.
                if firstTick {
                    firstTick = false
                    if !app.isActive { Self.foregroundRunningBundle() }
                    else if !window.isKeyWindow { focus() }
                }
                requestSample()
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        RunLoop.main.add(timer, forMode: .eventTracking)
        window.center()
        focus()
        // Keep the alert ordered on screen until the acceptance checks finish.
        return try withExtendedLifetime(alert) {
            defer {
                timer.invalidate()
                window.orderOut(nil)
            }
            while true {
                let response = app.runModal(for: window)
                guard eligible() else { throw prompt.interruption }
                guard let decision = ConsentDecision(rawValue: response.rawValue), decision != .deny,
                      let button = protected.first(where: { $0.tag == decision.rawValue }) else { return .deny }
                if revalidate(), button.isEnabled { return decision }
                reset()
                if !eligible() { throw prompt.interruption }
            }
        }
    }

    @objc private func answerConsent(_ sender: NSButton) {
        answer?(sender)
    }

    private static func foregroundRunningBundle() {
        let url = Bundle.main.bundleURL.standardizedFileURL
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        guard running.allSatisfy({ app in
            app.processIdentifier == getpid() || (app.bundleURL.map { $0.standardizedFileURL.path != url.path } ?? false)
        }) else { return }
        let options = NSWorkspace.OpenConfiguration()
        options.activates = true
        options.createsNewApplicationInstance = false
        options.allowsRunningApplicationSubstitution = false
        options.addsToRecentItems = false
        options.promptsUserIfNeeded = false
        NSWorkspace.shared.openApplication(at: url, configuration: options, completionHandler: nil)
    }

    private static func surfaceIDs(_ window: NSWindow) -> [CGWindowID]? {
        // AppKit can draw the alert in a child window with its own Core Graphics ID.
        var ids: [CGWindowID] = []
        for surface in [window] + (window.childWindows ?? []).filter(\.isVisible) {
            guard let id = CGWindowID(exactly: surface.windowNumber), id != kCGNullWindowID else { return nil }
            ids.append(id)
        }
        return ids
    }

    nonisolated private static func visibility(_ ids: [CGWindowID], onScreen: [[String: Any]]) -> ConsentVisibility? {
        let helperPID = getpid()
        var surfaces: [CGWindowID] = []
        var backingWindow: CGWindowID?
        var needsHitTest = false
        for id in ids {
            guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]]
            else { return nil }
            if ConsentOcclusion.isHiddenParent(id, surfaces: ids, info: rows.first, onScreen: onScreen) {
                // The visible child can be the only Core Graphics record under LaunchServices activation.
                if rows.first.map({ ConsentOcclusion.ownsAlertSurface($0, id: id, pid: helperPID) }) ?? true {
                    backingWindow = id
                }
                continue
            }
            guard let row = rows.first, row[kCGWindowIsOnscreen as String] as? Bool == true,
                  let bounds = ConsentOcclusion.bounds(row),
                  let ordered = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .optionIncludingWindow], id) as? [[String: Any]],
                  let reference = ordered.last,
                  ConsentOcclusion.ownsAlertSurface(reference, id: id, pid: helperPID),
                  reference[kCGWindowIsOnscreen as String] as? Bool == true,
                  ConsentOcclusion.bounds(reference) == bounds,
                  ConsentOcclusion.clear(alertBounds: bounds, above: ordered.dropLast(), helperPID: helperPID,
                                         isWindowServer: ConsentOcclusion.isWindowServer, allowsOverlay: { row in
                guard TrustedRemoteOverlay.matches(row) else { return false }
                needsHitTest = true
                return true
            }) else { return nil }
            surfaces.append(id)
        }
        guard !surfaces.isEmpty else { return nil }
        return ConsentVisibility(surfaces: surfaces, backingWindow: backingWindow, needsHitTest: needsHitTest)
    }

    func showStatus(_ authorization: SessionAuthorization) -> Bool {
        guard DesktopAccess.consoleAvailable(Windows.onScreen()) else { return false }
        self.authorization = authorization
        let locale = authorization.prompt.locale
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        guard let button = item.button else { return false }
        button.title = locale[.menuTitle]

        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(withTitle: locale.sourceLabel(authorization.label), action: nil, keyEquivalent: "")
        if let fingerprint = authorization.prompt.controller?.key.fingerprint {
            menu.addItem(withTitle: locale.keyFingerprint(fingerprint), action: nil, keyEquivalent: "")
        }
        windowItem = menu.addItem(withTitle: locale[.noWindows], action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        let stop = menu.addItem(withTitle: locale[.stop], action: #selector(stopSession), keyEquivalent: "")
        stop.target = self
        item.menu = menu
        return true
    }

    func updateBinding(_ count: Int) {
        guard let locale = authorization?.prompt.locale else { return }
        switch count {
        case 0: windowItem?.title = locale[.noWindows]
        case 1: windowItem?.title = locale[.oneWindow]
        default: windowItem?.title = String(format: locale[.multipleWindows], Int32(count))
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard let authorization else { return }
        let locale = authorization.prompt.locale
        revocationItems.forEach { menu.removeItem($0) }
        revocationItems.removeAll()
        if let record = authorization.persistent {
            let title = String(format: locale[.revokeCurrent], locale.sourceLabel(record.label), locale.keyFingerprint(record.fingerprint))
            revocationItems.append(menu.addItem(withTitle: title, action: #selector(revokeCurrent), keyEquivalent: ""))
        }
        if (try? store.list().isEmpty) != true {
            revocationItems.append(menu.addItem(withTitle: locale[.revokeAll], action: #selector(revokeAll), keyEquivalent: ""))
        }
        revocationItems.forEach { $0.target = self }
    }

    @objc private func revokeCurrent() {
        guard let record = authorization?.persistent else { return }
        revoke { try store.revoke(.publicKey(record.publicKey)) }
    }

    @objc private func revokeAll() {
        revoke { try store.revokeAll() }
    }

    private func revoke(_ remove: () throws -> Void) {
        guard let authorization, !presentingRevocationError else { return }
        revokeTrustedKeys(admission: admission, persistent: authorization.persistent != nil, remove: remove) { reason in
            FileHandle.standardError.write(Data("\(reason)\n".utf8))
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = authorization.prompt.locale[.keyStoreError]
            alert.informativeText = reason
            presentingRevocationError = true
            NSApplication.shared.activate()
            _ = alert.runModal()
            presentingRevocationError = false
            if let pendingExitCode { finish(pendingExitCode) }
        }
    }

    @objc private func stopSession() {
        admission.terminate("local_stop")
    }

    func finish(_ code: Int32) {
        // The host can disconnect while the revocation error is on screen.
        if presentingRevocationError {
            pendingExitCode = code
            return
        }
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        if let lockObserver { DistributedNotificationCenter.default().removeObserver(lockObserver) }
        exit(code)
    }
}

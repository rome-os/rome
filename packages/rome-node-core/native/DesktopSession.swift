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

    var detailFields: [ConsentDisclosure.Field] {
        func field(_ key: HelperLocale.Text, _ value: String) -> ConsentDisclosure.Field {
            (key, auditDisplayValue(value))
        }
        var identity: [ConsentDisclosure.Field] = []
        if let fingerprintLines { identity.append((.fingerprint, fingerprintLines)) }
        identity.append(field(.executable, host.executable))
        if let signingSummary {
            identity.append(field(.signingIdentifier, signingSummary.identifier))
            if let teamID = signingSummary.teamID { identity.append(field(.teamID, teamID)) }
        }
        return identity
    }
}

func auditDisplayValue(_ text: String) -> String {
    var visible = ""
    for scalar in text.unicodeScalars {
        switch scalar.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator:
            visible += "\\u{\(String(scalar.value, radix: 16))}"
        default:
            visible.unicodeScalars.append(scalar)
        }
    }
    return visible
}

struct ConsentDisclosure {
    typealias Field = (label: HelperLocale.Text, value: String)
    let fields: [Field]
    private(set) var expanded = false

    var visibleFields: [Field] { expanded ? fields : [] }
    var rows: [[Field]] {
        let fields = visibleFields
        guard fields.suffix(2).map(\.label) == [.signingIdentifier, .teamID] else { return fields.map { [$0] } }
        return fields.dropLast(2).map { [$0] } + [Array(fields.suffix(2))]
    }

    mutating func toggle() { expanded.toggle() }

    static func contentWidth(alertWidth: CGFloat) -> CGFloat {
        min(228, max(1, alertWidth - 32))
    }

    static func pathLineLimit(heightLimit: CGFloat, fittingHeight: (Int) -> CGFloat) -> Int {
        (2...3).reversed().first { ceil(fittingHeight($0)) <= heightLimit } ?? 1
    }
}

@MainActor
private final class ConsentAccessory: NSObject {
    private final class DisclosureButton: NSButton {
        override var alignmentRectInsets: NSEdgeInsets {
            var insets = super.alignmentRectInsets
            insets.left += 4
            return insets
        }
    }

    let view = NSView()
    private let stack = NSStackView()
    private let body = NSStackView()
    private let toggle = DisclosureButton()
    private let accessoryWidth: CGFloat
    private var width: CGFloat { max(1, accessoryWidth - 12) }
    private let heightLimit: CGFloat
    private weak var alert: NSAlert?
    private let locale: HelperLocale
    private var disclosure: ConsentDisclosure
    private var introduction: NSStackView?
    private var detailsView: NSView?
    private let beforeLayout: @MainActor () -> Void
    private(set) var resizing = false

    init(prompt: ConsentPrompt, alert: NSAlert, beforeLayout: @escaping @MainActor () -> Void) {
        self.alert = alert
        self.beforeLayout = beforeLayout
        locale = prompt.locale
        let width = ConsentDisclosure.contentWidth(alertWidth: alert.window.contentLayoutRect.width)
        accessoryWidth = width
        heightLimit = Self.maxCompactHeight(of: alert, accessoryWidth: width)
        disclosure = ConsentDisclosure(fields: prompt.detailFields)
        super.init()
        for column in [stack, body] {
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 10
        }
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            stack.widthAnchor.constraint(equalToConstant: self.width),
            body.widthAnchor.constraint(equalToConstant: self.width),
        ])
        if let name = prompt.sourceLabel {
            let value = label(locale.sourceLabel(name), font: .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold),
                              color: .labelColor)
            let header = group(locale[.introduction], value: value)
            introduction = header
            addBlock(header, to: stack)
        }

        let host = prompt.host
        let running = NSRunningApplication(processIdentifier: host.pid)
        let name = running?.localizedName.flatMap { sanitizeLabel($0) } ??
            sanitizeLabel(URL(fileURLWithPath: host.executable).lastPathComponent) ?? locale[.source]
        let icon = NSImageView(image: running?.icon ?? NSWorkspace.shared.icon(forFile: host.executable))
        icon.imageScaling = .scaleProportionallyDown
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 16),
                                     icon.heightAnchor.constraint(equalToConstant: 16)])
        let nameLabel = label("\(locale.sourceLabel(name)) (\(host.pid))",
                              font: .systemFont(ofSize: NSFont.systemFontSize), color: .labelColor)
        nameLabel.maximumNumberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingMiddle
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let process = NSStackView(views: [icon, nameLabel])
        process.orientation = .horizontal
        process.alignment = .centerY
        process.spacing = 6
        addBlock(group(locale[.process], value: process), to: body)

        let explanation = label(prompt.accessText, font: .systemFont(ofSize: NSFont.systemFontSize), color: .labelColor)
        addBlock(explanation, to: body)
        stack.addArrangedSubview(body)
        if let notice = prompt.persistentNotice {
            addBlock(label(notice), to: body)
            if alert.buttons.count == 3 {
                body.setCustomSpacing(6, after: explanation)
                stack.setCustomSpacing(6, after: body)
            }
        }

        toggle.controlSize = .mini
        toggle.title = locale[.details]
        toggle.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        toggle.isBordered = false
        toggle.imagePosition = .imageLeft
        toggle.imageHugsTitle = true
        toggle.contentTintColor = .secondaryLabelColor
        toggle.target = self
        toggle.action = #selector(toggleDetails)
        toggle.setAccessibilityLabel(locale[.details])
        updateDisclosure()
        stack.addArrangedSubview(toggle)
        fit()
    }

    private static func maxCompactHeight(of alert: NSAlert, accessoryWidth: CGFloat) -> CGFloat {
        let nativeWidth = alert.window.frame.width
        var low = 1, high = 350
        // AppKit changes layout when the complete alert gets too tall.
        while low < high {
            let height = (low + high + 1) / 2
            alert.accessoryView = NSView(frame: CGRect(x: 0, y: 0, width: accessoryWidth, height: CGFloat(height)))
            alert.layout()
            if alert.window.frame.width <= nativeWidth { low = height }
            else { high = height - 1 }
        }
        alert.accessoryView = nil
        return CGFloat(low)
    }

    private func label(_ text: String, font: NSFont = .systemFont(ofSize: NSFont.smallSystemFontSize),
                       color: NSColor = .secondaryLabelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = font
        field.textColor = color
        field.maximumNumberOfLines = 0
        field.lineBreakMode = .byCharWrapping
        field.preferredMaxLayoutWidth = width
        return field
    }

    private func addBlock(_ block: NSView, to column: NSStackView) {
        column.addArrangedSubview(block)
        block.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    }

    private func group(_ caption: String, value: NSView, spacing: CGFloat = 3, columnWidth: CGFloat? = nil) -> NSStackView {
        let title = label(caption)
        title.preferredMaxLayoutWidth = columnWidth ?? width
        let group = NSStackView(views: [title, value])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = spacing
        title.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        value.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    private func fit() {
        stack.layoutSubtreeIfNeeded()
        view.setFrameSize(CGSize(width: accessoryWidth, height: ceil(stack.fittingSize.height)))
        view.layoutSubtreeIfNeeded()
    }

    private func updateDisclosure() {
        toggle.image = NSImage(systemSymbolName: disclosure.expanded ? "chevron.down" : "chevron.right",
                               accessibilityDescription: nil)
        toggle.setAccessibilityExpanded(disclosure.expanded)
    }

    @objc private func toggleDetails() {
        relayout {
            disclosure.toggle()
            updateDisclosure()
            if disclosure.expanded {
                showDetails()
            } else if let detailsView {
                stack.removeArrangedSubview(detailsView)
                detailsView.removeFromSuperview()
                self.detailsView = nil
                body.isHidden = false
                if let introduction {
                    introduction.spacing = 3
                    stack.setCustomSpacing(10, after: introduction)
                }
            }
        }
    }

    private func showDetails() {
        let audit = NSStackView()
        audit.orientation = .vertical
        audit.alignment = .leading
        audit.spacing = 5
        var executable: NSTextField?
        for row in disclosure.rows {
            let columnWidth = row.count == 2 ? (width - 8) / 2 : width
            let groups = row.map { field in
                let value = auditValue(field, columnWidth: columnWidth)
                if field.label == .executable { executable = value }
                return group(locale[field.label], value: value, spacing: 2, columnWidth: columnWidth)
            }
            if groups.count == 2 {
                let pair = NSStackView(views: groups)
                pair.orientation = .horizontal
                pair.alignment = .top
                pair.distribution = .fillEqually
                pair.spacing = 8
                addBlock(pair, to: audit)
            } else if let field = groups.first {
                addBlock(field, to: audit)
            }
        }
        detailsView = audit
        stack.setCustomSpacing(2, after: toggle)
        addBlock(audit, to: stack)
        if ceil(stack.fittingSize.height) > heightLimit {
            body.isHidden = true
            if let introduction {
                introduction.spacing = 2
                stack.setCustomSpacing(2, after: introduction)
            }
        }
        if let executable {
            executable.maximumNumberOfLines = 0
            let fullHeight = ceil(executable.fittingSize.height)
            executable.maximumNumberOfLines = ConsentDisclosure.pathLineLimit(heightLimit: heightLimit) { lines in
                executable.maximumNumberOfLines = lines
                return stack.fittingSize.height
            }
            if ceil(executable.fittingSize.height) < fullHeight {
                executable.lineBreakMode = .byTruncatingMiddle
            }
        }
    }

    private func auditValue(_ field: ConsentDisclosure.Field, columnWidth: CGFloat) -> NSTextField {
        let value = label(field.value, color: .labelColor)
        value.preferredMaxLayoutWidth = columnWidth
        value.isSelectable = true
        value.toolTip = field.value
        if field.label == .fingerprint {
            value.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
            value.maximumNumberOfLines = 2
        } else if field.label == .executable {
            value.maximumNumberOfLines = 3
        } else {
            value.maximumNumberOfLines = 1
            value.lineBreakMode = .byTruncatingMiddle
        }
        return value
    }

    private func relayout(_ change: () -> Void) {
        guard let alert else { return }
        let window = alert.window
        let previous = window.frame
        beforeLayout()
        resizing = true
        defer { resizing = false }
        change()
        fit()
        alert.layout()
        let size = window.frame.size
        let frame = CGRect(x: previous.midX - size.width / 2, y: previous.maxY - size.height,
                           width: size.width, height: size.height)
        if window.isVisible, frame != previous {
            window.setFrame(previous, display: false)
            window.setFrame(frame, display: true, animate: true)
        }
        view.layoutSubtreeIfNeeded()
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
            _ = admission.stop("console_unavailable")
        }
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification,
            NSWorkspace.screensDidSleepNotification,
        ].map { workspace.addObserver(forName: $0, object: nil, queue: nil, using: unavailable) }
        lockObserver = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: nil, using: unavailable)
    }

    func confirm(_ prompt: ConsentPrompt, canContinue: @escaping @Sendable () -> Bool) -> ConsentDecision {
        let eligible: @Sendable () -> Bool = {
            canContinue() && DesktopAccess.consoleSessionAvailable()
        }
        guard eligible() else { return .deny }
        var remaining = ConsentCountdown.seconds(until: prompt.deadline)
        guard remaining > 0 else { return .deny }
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
        alert.layout()
        let accessory = ConsentAccessory(prompt: prompt, alert: alert, beforeLayout: reset)
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
            guard let visibility else { return false }
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
            let visible = !accessory.resizing && clear(sample(Self.surfaceIDs(window)))
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
        }) else { return .deny }
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
            guard !accessory.resizing, let token = self.consentPoll.begin() else { return }
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
        return withExtendedLifetime(alert) {
            defer {
                timer.invalidate()
                window.orderOut(nil)
            }
            while true {
                let response = app.runModal(for: window)
                guard let decision = ConsentDecision(rawValue: response.rawValue), decision != .deny,
                      let button = protected.first(where: { $0.tag == decision.rawValue }) else { return .deny }
                if revalidate(), button.isEnabled { return decision }
                reset()
                if !eligible() { return .deny }
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
                guard DesktopAccess.isThirdPartyOverlay(row) else { return false }
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

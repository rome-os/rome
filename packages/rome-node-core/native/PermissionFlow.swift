import AppKit
import ApplicationServices
import Darwin
import Foundation

private let setupRequestNotification = Notification.Name("com.rome.computer-use.permission-setup")

@MainActor
func runPermissionSetup(_ request: PermissionSetupRequest) throws {
    let lock = open(NSTemporaryDirectory() + "rome-computer-use-permission-setup.lock",
                    O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw Failure("permission_setup_unavailable") }
    defer { close(lock) }
    var entry = stat()
    guard fstat(lock, &entry) == 0, entry.st_uid == getuid(), entry.st_nlink == 1,
          entry.st_mode & S_IFMT == S_IFREG, entry.st_mode & 0o077 == 0 else {
        throw Failure("permission_setup_unavailable")
    }
    let notifications = DistributedNotificationCenter.default()
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
        if errno == EWOULDBLOCK {
            notifications.postNotificationName(setupRequestNotification, object: bundleIdentifier,
                                               userInfo: ["pane": request.step?.rawValue ?? "all"],
                                               deliverImmediately: true)
            try? FileHandle.standardOutput.write(contentsOf: Data("ready\n".utf8))
            return
        }
        throw Failure("permission_setup_unavailable")
    }

    let app = NSApplication.shared
    try requireAccessoryPolicy(current: app.activationPolicy, set: app.setActivationPolicy)
    let flow = PermissionFlow(request, app: app)
    let observer = notifications.addObserver(forName: setupRequestNotification, object: bundleIdentifier, queue: .main) {
        [weak flow] notification in
        guard let pane = notification.userInfo?["pane"] as? String, pane.count <= 16 else { return }
        let step = PermissionStep(rawValue: pane)
        guard step != nil || pane == "all" else { return }
        MainActor.assumeIsolated { flow?.focus(step) }
    }
    defer { notifications.removeObserver(observer) }
    try? FileHandle.standardOutput.write(contentsOf: Data("ready\n".utf8))
    flow.show(request.step)
    withExtendedLifetime(flow) { app.run() }
}

private enum ScreenRecordingProbe {
    static func read() -> Bool? {
        let files = FileManager.default
        let temp = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try files.createDirectory(at: temp, withIntermediateDirectories: false,
                                      attributes: [.posixPermissions: 0o700])
        } catch { return nil }
        defer { try? files.removeItem(at: temp) }
        let output = temp.appendingPathComponent("permissions.json")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", "-g", "-j", "-W", "--stdout", output.path, "--stderr", "/dev/null",
                             "-a", Bundle.main.bundleURL.path, "--args", "--check-permissions"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do { try process.run() } catch { return nil }
        if exited.wait(timeout: .now() + 2.5) == .timedOut, process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        // LaunchServices can lose the wait race against an app that exits after writing its result.
        guard let data = try? Data(contentsOf: output),
              let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Bool] else { return nil }
        return result["screenRecording"]
    }
}

private final class PermissionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

private final class PermissionDragCard: NSBox, NSDraggingSource {
    private let icon: NSImage

    init(icon: NSImage, locale: HelperLocale) {
        self.icon = icon
        super.init(frame: .zero)
        boxType = .custom
        cornerRadius = 12
        borderWidth = 1
        borderColor = .separatorColor
        fillColor = .controlBackgroundColor.withAlphaComponent(0.65)
        contentViewMargins = NSSize(width: 12, height: 10)

        let image = NSImageView(image: icon)
        image.imageScaling = .scaleProportionallyDown
        image.widthAnchor.constraint(equalToConstant: 40).isActive = true
        image.heightAnchor.constraint(equalToConstant: 40).isActive = true
        let name = NSTextField(labelWithString: "Rome Computer Use")
        name.font = .systemFont(ofSize: 13, weight: .semibold)
        let hint = NSTextField(labelWithString: locale[.setupDragHint])
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 11)
        let label = NSStackView(views: [name, hint])
        label.orientation = .vertical
        label.alignment = .leading
        label.spacing = 2
        let row = NSStackView(views: [image, label])
        row.alignment = .centerY
        row.spacing = 10
        contentView = row
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(name.stringValue)
        setAccessibilityHelp(hint.stringValue)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override func mouseDown(with event: NSEvent) {}

    override func mouseDragged(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
        let point = convert(event.locationInWindow, from: nil)
        item.setDraggingFrame(NSRect(x: point.x - 20, y: point.y - 20, width: 40, height: 40), contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext)
        -> NSDragOperation {
        .copy
    }

    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        window?.ignoresMouseEvents = true
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        window?.ignoresMouseEvents = false
    }
}

@MainActor
private final class PermissionFlow: NSObject {
    private let locale: HelperLocale
    private let appIcon: NSImage
    private let panel: PermissionPanel
    private let card: PermissionDragCard
    private let stack = NSStackView()
    private let heading = NSTextField(labelWithString: "")
    private let instructions = NSTextField(wrappingLabelWithString: "")
    private let settings = NSButton()
    private let finder = NSButton()
    private let done = NSButton()
    private var stepButtons: [NSButton] = []
    private var badges: [(NSBox, NSTextField)] = []
    private var state: PermissionSetupState
    private var pollTimer: Timer?
    private var dockTimer: Timer?
    private var dockInterval: TimeInterval = 0
    private var lastSettingsFrame: CGRect?
    private var settingsWindow: (id: CGWindowID, pid: pid_t)?
    private var fastDockUntil: TimeInterval = 0
    private var nextProbe: TimeInterval = 0
    private var probing = false
    private var probedScreenGrant: Bool?
    private var closing = false
    private static let width: CGFloat = 424
    private static let inset: CGFloat = 20
    private static let activeDockInterval: TimeInterval = 0.04
    private static let frontDockInterval: TimeInterval = 0.12
    private static let idleDockInterval: TimeInterval = 0.25
    private static let pendingScreenProbeInterval: TimeInterval = 2.5
    private static let grantedScreenProbeInterval: TimeInterval = 5.0

    init(_ request: PermissionSetupRequest, app: NSApplication) {
        locale = request.locale
        appIcon = app.applicationIconImage
        card = PermissionDragCard(icon: appIcon, locale: request.locale)
        panel = PermissionPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 300),
                                styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                                backing: .buffered, defer: false)
        let initialGrants = Self.grants(probedScreenGrant: nil)
        state = PermissionSetupState(step: request.step, granted: initialGrants)
        if initialGrants.contains(.screenRecording) {
            nextProbe = ProcessInfo.processInfo.systemUptime + Self.grantedScreenProbeInterval
        }
        super.init()
        configurePanel()
    }

    func show(_ requested: PermissionStep?) {
        focus(requested)
        let pollTimer = Timer(timeInterval: 0.75, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        pollTimer.tolerance = 0.15
        self.pollTimer = pollTimer
        RunLoop.main.add(pollTimer, forMode: .common)
        scheduleDock(interval: Self.activeDockInterval)
    }

    func focus(_ requested: PermissionStep?) {
        guard !closing else { return }
        if let requested { state.enter(requested) }
        fastDockUntil = ProcessInfo.processInfo.systemUptime + 1.0
        render()
        _ = dock()
        panel.orderFrontRegardless()
        showStep(focus: requested)
        if dockTimer != nil { scheduleDock(interval: Self.activeDockInterval) }
    }

    private func configurePanel() {
        panel.title = locale[.setupTitle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovable = false
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]

        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        panel.contentView = effect

        let headerIcon = NSImageView(image: appIcon)
        headerIcon.imageScaling = .scaleProportionallyDown
        headerIcon.widthAnchor.constraint(equalToConstant: 32).isActive = true
        headerIcon.heightAnchor.constraint(equalToConstant: 32).isActive = true
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        let brand = NSTextField(labelWithString: "Rome Computer Use")
        brand.font = .systemFont(ofSize: 11, weight: .medium)
        brand.textColor = .secondaryLabelColor
        let titleStack = NSStackView(views: [heading, brand])
        titleStack.orientation = .vertical
        titleStack.alignment = .leading
        titleStack.spacing = 1
        let header = NSStackView(views: [headerIcon, titleStack])
        header.alignment = .centerY
        header.spacing = 10

        instructions.font = .systemFont(ofSize: 13)
        instructions.textColor = .secondaryLabelColor
        instructions.preferredMaxLayoutWidth = Self.width - Self.inset * 2
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 12
        stack.addArrangedSubview(header)

        let steps = NSStackView()
        steps.orientation = .vertical
        steps.alignment = .leading
        steps.distribution = .fill
        steps.spacing = 5
        for (index, step) in PermissionStep.allCases.enumerated() {
            let button = NSButton(title: "\(index + 1). \(locale[step.title])", target: self,
                                  action: #selector(selectStep(_:)))
            button.tag = index
            button.setButtonType(.pushOnPushOff)
            button.bezelStyle = .recessed
            stepButtons.append(button)

            let badge = NSTextField(labelWithString: "")
            badge.font = .systemFont(ofSize: 11, weight: .medium)
            badge.alignment = .center
            badge.stringValue = "✓ \(locale[.setupGranted])"
            let grantedWidth = badge.intrinsicContentSize.width
            badge.stringValue = locale[.setupPending]
            let pendingSize = badge.intrinsicContentSize
            let pill = NSBox()
            pill.boxType = .custom
            pill.cornerRadius = 8
            pill.borderWidth = 0
            pill.contentViewMargins = NSSize(width: 7, height: 3)
            pill.contentView = badge
            pill.widthAnchor.constraint(equalToConstant: ceil(max(grantedWidth, pendingSize.width)) + 14).isActive = true
            pill.heightAnchor.constraint(equalToConstant: ceil(pendingSize.height) + 6).isActive = true
            badges.append((pill, badge))
            let row = controlRow([button, NSView(), pill])
            steps.addArrangedSubview(row)
            fillWidth(row)
        }
        stack.addArrangedSubview(steps)
        let separator = NSBox()
        separator.boxType = .separator
        separator.heightAnchor.constraint(equalToConstant: 1).isActive = true
        stack.addArrangedSubview(separator)
        stack.addArrangedSubview(instructions)
        stack.addArrangedSubview(card)
        card.heightAnchor.constraint(equalToConstant: 62).isActive = true

        settings.title = locale[.setupOpenSettings]
        settings.target = self
        settings.action = #selector(openSettings)
        finder.title = locale[.setupShowInFinder]
        finder.target = self
        finder.action = #selector(showInFinder)
        done.target = self
        done.action = #selector(close)
        done.keyEquivalent = "\u{1b}"
        done.keyEquivalentModifierMask = []
        for button in [settings, finder, done] { button.bezelStyle = .rounded }
        let controls = controlRow([settings, finder, NSView(), done])
        stack.addArrangedSubview(controls)
        for view in [separator, instructions, card, controls] { fillWidth(view) }

        effect.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: Self.inset),
            stack.topAnchor.constraint(equalTo: effect.topAnchor, constant: Self.inset),
            stack.widthAnchor.constraint(equalToConstant: Self.width - Self.inset * 2),
        ])
        panel.recalculateKeyViewLoop()
    }

    private func controlRow(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.distribution = .fill
        row.alignment = .centerY
        row.spacing = 6
        return row
    }

    private func fillWidth(_ view: NSView) {
        view.widthAnchor.constraint(equalToConstant: Self.width - 2 * Self.inset).isActive = true
    }

    private func render() {
        let complete = state.step == nil
        let needsScreenReopen = !CGPreflightScreenCaptureAccess() && probedScreenGrant == true
        heading.stringValue = locale[complete ? .setupComplete : .setupTitle]
        let detail: HelperLocale.Text
        if complete {
            detail = needsScreenReopen ? .setupCompleteReopenDetail : .setupCompleteDetail
        } else if state.step.map(state.granted.contains) == true {
            detail = .setupGrantedDetail
        } else if state.step == .screenRecording {
            detail = .setupScreenInstructions
        } else {
            detail = .setupInstructions
        }
        instructions.stringValue = locale[detail]
        card.isHidden = complete || state.step.map(state.granted.contains) == true
        settings.isHidden = complete
        finder.isHidden = complete
        done.title = locale[complete ? .setupDone : .setupClose]
        for (index, step) in PermissionStep.allCases.enumerated() {
            let granted = state.granted.contains(step)
            let (pill, badge) = badges[index]
            badge.stringValue = granted ? "✓ \(locale[.setupGranted])" : locale[.setupPending]
            badge.textColor = granted ? .labelColor : .secondaryLabelColor
            pill.fillColor =
                (granted ? NSColor.systemGreen : .labelColor).withAlphaComponent(granted ? 0.16 : 0.07)
            stepButtons[index].state = step == state.step ? .on : .off
            stepButtons[index].isEnabled = !complete
        }
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.setContentSize(NSSize(width: Self.width, height: ceil(stack.fittingSize.height) + 2 * Self.inset))
        panel.invalidateShadow()
    }

    private func showStep(focus requested: PermissionStep? = nil) {
        if let step = state.step ?? requested { NSWorkspace.shared.open(step.settingsURL) }
        switch state.takePrompt() {
        case .accessibility:
            if !AXIsProcessTrusted() {
                let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
            }
        case .screenRecording:
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        case nil: break
        }
    }

    @objc private func selectStep(_ sender: NSButton) {
        focus(PermissionStep.allCases[sender.tag])
    }

    @objc private func openSettings() {
        if let step = state.step { NSWorkspace.shared.open(step.settingsURL) }
    }

    @objc private func showInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    @objc private func close() {
        closing = true
        pollTimer?.invalidate()
        dockTimer?.invalidate()
        panel.orderOut(nil)
        if !probing { NSApp.terminate(nil) }
    }

    private static func grants(probedScreenGrant: Bool?) -> Set<PermissionStep> {
        var grants: Set<PermissionStep> = []
        if AXIsProcessTrusted() { grants.insert(.accessibility) }
        if probedScreenGrant ?? CGPreflightScreenCaptureAccess() { grants.insert(.screenRecording) }
        return grants
    }

    private func poll() {
        let previous = state.step
        let grants = Self.grants(probedScreenGrant: probedScreenGrant)
        if grants != state.granted {
            state.update(grants)
            render()
            _ = dock()
            if state.step != previous { showStep() }
        }
        let now = ProcessInfo.processInfo.systemUptime
        let screenGranted = grants.contains(.screenRecording)
        let shouldProbe = (screenGranted && lastSettingsFrame != nil)
            || (!screenGranted && (state.step == .screenRecording || grants.contains(.accessibility)))
        guard shouldProbe, !probing, now >= nextProbe else { return }
        probing = true
        nextProbe = now + (screenGranted ? Self.grantedScreenProbeInterval : Self.pendingScreenProbeInterval)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let granted = ScreenRecordingProbe.read()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.probing = false
                if self.closing {
                    NSApp.terminate(nil)
                    return
                }
                if let granted { self.probedScreenGrant = granted }
                self.poll()
            }
        }
    }

    private func scheduleDock(interval: TimeInterval) {
        guard !closing, interval != dockInterval else { return }
        dockTimer?.invalidate()
        dockInterval = interval
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.trackDock() }
        }
        timer.tolerance = interval <= Self.activeDockInterval ? 0 : interval * 0.2
        dockTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func trackDock() {
        let now = ProcessInfo.processInfo.systemUptime
        if dock() { fastDockUntil = now + 0.6 }
        let desired: TimeInterval
        if NSEvent.pressedMouseButtons != 0 || now < fastDockUntil {
            desired = Self.activeDockInterval
        } else if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.systempreferences" {
            desired = Self.frontDockInterval
        } else {
            desired = Self.idleDockInterval
        }
        scheduleDock(interval: desired)
    }

    private func dock() -> Bool {
        guard !panel.ignoresMouseEvents, let primary = NSScreen.screens.first else { return false }
        let settings = settingsFrame(primaryTop: primary.frame.maxY)
        let changed = settings != lastSettingsFrame
        lastSettingsFrame = settings
        let screen = settings.flatMap { frame in
            NSScreen.screens.max { lhs, rhs in
                func area(_ screen: NSScreen) -> CGFloat {
                    let overlap = screen.frame.intersection(frame)
                    return overlap.isNull ? 0 : overlap.width * overlap.height
                }
                return area(lhs) < area(rhs)
            }
        } ?? NSScreen.main ?? primary
        let point = dockPermissionPanel(size: panel.frame.size, settings: settings, visible: screen.visibleFrame)
        if point != panel.frame.origin {
            panel.setFrameOrigin(point)
            return true
        }
        return changed
    }

    private static func extractSettingsFrame(from row: [String: Any], primaryTop: CGFloat) -> CGRect? {
        guard row[kCGWindowLayer as String] as? Int == 0,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.width > 200, frame.height > 200 else { return nil }
        return CGRect(x: frame.minX, y: primaryTop - frame.maxY, width: frame.width, height: frame.height)
    }

    private func settingsFrame(primaryTop: CGFloat) -> CGRect? {
        if let cached = settingsWindow,
           let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], cached.id) as? [[String: Any]],
           let row = rows.first,
           row[kCGWindowOwnerPID as String] as? pid_t == cached.pid,
           row[kCGWindowIsOnscreen as String] as? Bool == true,
           let frame = Self.extractSettingsFrame(from: row, primaryTop: primaryTop) {
            return frame
        }
        settingsWindow = nil
        let pids = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences")
            .map(\.processIdentifier)
        guard !pids.isEmpty,
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                    kCGNullWindowID) as? [[String: Any]] else { return nil }
        for row in rows {
            guard let pid = row[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
                  let frame = Self.extractSettingsFrame(from: row, primaryTop: primaryTop) else { continue }
            if let wid = row[kCGWindowNumber as String] as? CGWindowID {
                settingsWindow = (wid, pid)
            }
            return frame
        }
        return nil
    }
}

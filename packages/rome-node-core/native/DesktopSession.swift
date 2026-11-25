import AppKit
import Darwin.libproc
import Foundation

enum ConsentOcclusion {
    private static let windowServerPath = canonicalPath("/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer")
    static let alertLevel = Int(CGWindowLevelForKey(.screenSaverWindow)) - 1

    static func isWindowServer(_ pid: pid_t) -> Bool {
        guard let path = windowServerPath else { return false }
        // A process name alone does not authenticate the Window Server.
        var bytes = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &bytes, UInt32(bytes.count))
        guard length > 0 else { return false }
        return String(decoding: bytes.prefix(Int(length)), as: UTF8.self) == path
    }

    static func bounds(_ row: [String: Any]) -> CGRect? {
        guard let dictionary = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              [bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height].allSatisfy(\.isFinite),
              bounds.size.width >= 0, bounds.size.height >= 0 else { return nil }
        return bounds
    }

    static func clear(alertBounds: CGRect?, above: ArraySlice<[String: Any]>?, helperPID: pid_t,
                      isWindowServer: (pid_t) -> Bool) -> Bool {
        guard let alertBounds, !alertBounds.isEmpty, let above else { return false }
        return above.allSatisfy { row in
            guard let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return false }
            if pid == helperPID { return true }
            if (row[kCGWindowLayer as String] as? NSNumber)?.int32Value == CGWindowLevelForKey(.cursorWindow),
               row[kCGWindowOwnerName as String] as? String == "Window Server", isWindowServer(pid) { return true }
            // Core Graphics can report windows that let clicks through, regardless of alpha.
            guard let bounds = bounds(row) else { return false }
            return bounds.isEmpty || !alertBounds.intersects(bounds)
        }
    }
}

struct ConsentUnlock {
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
        return uptime - since >= 1
    }

    mutating func mouseDown(at timestamp: TimeInterval, clickCount: Int, enabled: Bool) {
        let interval = lastMouseDown.map { timestamp - $0 }
        lastMouseDown = timestamp
        guard enabled else {
            reset()
            return
        }
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
            click.count == 1 && (click.interval ?? .infinity) > doubleClickInterval
        } ?? (pendingKey && currentClickCount == nil)
        guard singleClick, (currentClickCount ?? 1) == 1 else {
            reset()
            return false
        }
        pendingClick = nil
        pendingKey = false
        return true
    }

    mutating func revalidate(clear: Bool, focused: Bool, eligible: Bool, at uptime: TimeInterval) -> Bool {
        guard clear, focused, eligible, let focusedSince, uptime - focusedSince >= 1 else {
            reset()
            return false
        }
        return true
    }
}

extension ConsentPrompt {
    var informativeText: String {
        var details = [locale[.access]]
        if mode.choices.contains(.allowPersistent) { details.append(locale[.persistentAccess]) }
        if let controller {
            details.append(locale[controller.scope == .local ? .localRisk : .remoteRisk])
            let groups = controller.key.fingerprint.split(separator: "-")
            let lines = [groups.prefix(4), groups.dropFirst(4)].map { locale.keyFingerprint($0.joined(separator: "-")) }
            details.append(([locale[.fingerprint]] + lines).joined(separator: "\n"))
        }
        details.append("\(locale[.source])\n\(locale.sourceLabel(label))")
        if mode == .sessionOnly {
            var identity = [
                "\(locale[.executable]) \(locale.sourceLabel(String(reflecting: host.executable)))",
                "PID: \(host.pid)",
            ]
            if let signingSummary {
                identity.append("\(locale[.signingIdentifier]) \(locale.sourceLabel(String(reflecting: signingSummary.identifier)))")
                if let teamID = signingSummary.teamID {
                    identity.append("\(locale[.teamID]) \(locale.sourceLabel(String(reflecting: teamID)))")
                }
            }
            details.append(identity.joined(separator: "\n"))
        }
        return details.joined(separator: "\n\n")
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
    private enum ConsentVisibility { case untrusted, clear, raised }

    private let admission: Admission
    private let store: any TrustedKeyStore
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
        let eligible: @MainActor @Sendable () -> Bool = {
            canContinue() && DesktopAccess.consoleAvailable(Windows.onScreen())
        }
        guard eligible() else { return .deny }
        let locale = prompt.locale
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = locale[.title]
        alert.informativeText = prompt.informativeText
        let deny = alert.addButton(withTitle: locale[.deny])
        deny.tag = ConsentDecision.deny.rawValue
        let allows = prompt.mode.choices.dropFirst().map { choice in
            let button = alert.addButton(withTitle: locale[choice == .allowSession ? .allowSession : .allowPersistent])
            button.tag = choice.rawValue
            button.keyEquivalent = ""
            button.isEnabled = false
            return button
        }
        deny.keyEquivalent = "\r"
        for button in [deny] + allows {
            button.target = self
            button.action = #selector(answerConsent)
        }
        alert.layout()
        let window = alert.window
        let level = NSWindow.Level(rawValue: ConsentOcclusion.alertLevel)
        window.level = level
        window.defaultButtonCell = deny.cell as? NSButtonCell
        window.makeFirstResponder(deny)

        let app = NSApplication.shared
        unlock = ConsentUnlock()
        let enable: @MainActor @Sendable (Bool) -> Void = { enabled in
            allows.forEach { $0.isEnabled = enabled }
        }
        let reset: @MainActor @Sendable () -> Void = {
            self.unlock.reset()
            enable(false)
        }
        let revalidate: @MainActor () -> Bool = {
            self.unlock.revalidate(clear: Self.visibility(window) == .raised,
                                   focused: window.isKeyWindow && app.isActive, eligible: eligible(),
                                   at: ProcessInfo.processInfo.systemUptime)
        }
        answer = { sender in
            guard sender.isEnabled else { return }
            if sender !== deny {
                // AppKit can deliver a control action after currentEvent has changed.
                let clickCount = app.currentEvent.flatMap { event in
                    event.type == .leftMouseDown || event.type == .leftMouseUp ? event.clickCount : nil
                }
                guard revalidate() else {
                    reset()
                    app.abortModal()
                    return
                }
                guard self.unlock.accept(currentClickCount: clickCount, doubleClickInterval: NSEvent.doubleClickInterval) else {
                    reset()
                    return
                }
            }
            app.stopModal(withCode: .init(rawValue: sender.tag))
        }
        defer { answer = nil }

        guard let inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .keyDown], handler: { event in
            MainActor.assumeIsolated {
                let enabled = allows.allSatisfy(\.isEnabled)
                if event.type == .leftMouseDown {
                    self.unlock.mouseDown(at: event.timestamp, clickCount: event.clickCount, enabled: enabled)
                } else {
                    self.unlock.keyDown(enabled: enabled, isRepeat: event.isARepeat)
                    if event.isARepeat { enable(false) }
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
        let onFocusLoss: @Sendable (Notification) -> Void = { _ in MainActor.assumeIsolated { reset() } }
        let notifications = NotificationCenter.default
        let becomeKey = notifications.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window,
                                                   queue: nil) { _ in MainActor.assumeIsolated { raise() } }
        let resignKey = notifications.addObserver(forName: NSWindow.didResignKeyNotification, object: window,
                                                   queue: nil, using: onFocusLoss)
        let resignActive = notifications.addObserver(forName: NSApplication.willResignActiveNotification, object: app,
                                                      queue: nil, using: onFocusLoss)
        defer {
            notifications.removeObserver(becomeKey)
            notifications.removeObserver(resignKey)
            notifications.removeObserver(resignActive)
        }

        let timer = Timer(timeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated {
                raise()
                let visibility = Self.visibility(window)
                guard visibility != .untrusted, eligible() else {
                    reset()
                    app.abortModal()
                    return
                }
                enable(self.unlock.update(focused: visibility == .raised && window.isKeyWindow && app.isActive,
                                          at: ProcessInfo.processInfo.systemUptime))
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        app.activate(ignoringOtherApps: true)
        // Keep the alert ordered on screen until the acceptance checks finish.
        return withExtendedLifetime(alert) {
            let response = app.runModal(for: window)
            timer.invalidate()
            defer { window.orderOut(nil) }
            guard let decision = ConsentDecision(rawValue: response.rawValue), decision != .deny,
                  allows.contains(where: { $0.tag == decision.rawValue && $0.isEnabled }), revalidate() else { return .deny }
            return decision
        }
    }

    @objc private func answerConsent(_ sender: NSButton) {
        answer?(sender)
    }

    private static func visibility(_ window: NSWindow) -> ConsentVisibility {
        let helperPID = getpid()
        var checked = false
        var raised = true
        // AppKit can draw the alert in a child window with its own Core Graphics ID.
        for surface in [window] + (window.childWindows ?? []).filter(\.isVisible) {
            guard let id = CGWindowID(exactly: surface.windowNumber), id != kCGNullWindowID,
                  let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]]
            else { return .untrusted }
            if surface === window, rows.isEmpty { continue }
            guard let row = rows.first, row[kCGWindowIsOnscreen as String] as? Bool == true,
                  let bounds = ConsentOcclusion.bounds(row),
                  let ordered = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .optionIncludingWindow], id) as? [[String: Any]],
                  let reference = ordered.last,
                  (reference[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id,
                  (reference[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == helperPID,
                  reference[kCGWindowIsOnscreen as String] as? Bool == true,
                  let layer = (reference[kCGWindowLayer as String] as? NSNumber)?.intValue,
                  ConsentOcclusion.bounds(reference) == bounds,
                  ConsentOcclusion.clear(alertBounds: bounds, above: ordered.dropLast(), helperPID: helperPID,
                                         isWindowServer: ConsentOcclusion.isWindowServer) else { return .untrusted }
            checked = true
            raised = raised && layer == ConsentOcclusion.alertLevel
        }
        guard checked else { return .untrusted }
        return raised ? .raised : .clear
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
            NSApplication.shared.activate(ignoringOtherApps: true)
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

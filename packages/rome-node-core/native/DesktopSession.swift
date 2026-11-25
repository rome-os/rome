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

    mutating func reset() {
        focusedSince = nil
        pendingClick = nil
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
    }

    mutating func keyDown(enabled: Bool) {
        if !enabled { reset() }
    }

    mutating func accept(currentClickCount: Int?, doubleClickInterval: TimeInterval) -> Bool {
        let singleClick = pendingClick.map { click in
            click.count == 1 && (click.interval ?? .infinity) > doubleClickInterval
        } ?? (currentClickCount == nil)
        guard singleClick, (currentClickCount ?? 1) == 1 else {
            reset()
            return false
        }
        return true
    }
}

@MainActor
final class DesktopSession: NSObject {
    private enum ConsentVisibility { case untrusted, clear, raised }

    private let admission: Admission
    private var unlock = ConsentUnlock()
    private var statusItem: NSStatusItem?
    private var windowItem: NSMenuItem?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lockObserver: NSObjectProtocol?

    init(admission: Admission) {
        self.admission = admission
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

    func confirm(_ peer: Peer, canContinue: @escaping @Sendable () -> Bool) -> Bool {
        guard let signature = peer.signingSummary else { return false }
        let eligible: @MainActor @Sendable () -> Bool = {
            canContinue() && DesktopAccess.consoleAvailable(Windows.onScreen())
        }
        guard eligible() else { return false }
        let name = URL(fileURLWithPath: peer.identity.executable).lastPathComponent
        let host = "\(String(reflecting: name)) (PID \(peer.identity.pid))"
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow a computer use session?"
        alert.informativeText = """
            \(host) requests access to list your open windows and read and control any of them until you stop the session.
            Choose Stop Computer Use in the Rome Computer Use menu bar item to stop at any time.

            Executable: \(String(reflecting: peer.identity.executable))
            Signing identifier: \(signature)
            """
        let deny = alert.addButton(withTitle: "Deny")
        let allow = alert.addButton(withTitle: "Allow Session")
        deny.keyEquivalent = "\r"
        allow.keyEquivalent = ""
        allow.isEnabled = false
        deny.tag = NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        allow.tag = NSApplication.ModalResponse.alertSecondButtonReturn.rawValue
        for button in [deny, allow] {
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
        let reset: @MainActor @Sendable () -> Void = {
            self.unlock.reset()
            allow.isEnabled = false
        }
        guard let inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .keyDown], handler: { event in
            MainActor.assumeIsolated {
                if event.type == .leftMouseDown {
                    self.unlock.mouseDown(at: event.timestamp, clickCount: event.clickCount, enabled: allow.isEnabled)
                } else {
                    self.unlock.keyDown(enabled: allow.isEnabled)
                }
            }
            return event
        }) else { return false }
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
                allow.isEnabled = self.unlock.update(focused: visibility == .raised && window.isKeyWindow && app.isActive,
                                                     at: ProcessInfo.processInfo.systemUptime)
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        app.activate(ignoringOtherApps: true)
        // Keep the alert ordered on screen until the acceptance checks finish.
        let accepted = withExtendedLifetime(alert) {
            let response = app.runModal(for: window)
            timer.invalidate()
            let accepted = response == .alertSecondButtonReturn && allow.isEnabled && eligible() &&
                Self.visibility(window) == .raised && window.isKeyWindow && app.isActive
            window.orderOut(nil)
            return accepted
        }
        return accepted && showStatus(host: host)
    }

    @objc private func answerConsent(_ sender: NSButton) {
        guard sender.isEnabled else { return }
        let app = NSApplication.shared
        if sender.tag == NSApplication.ModalResponse.alertSecondButtonReturn.rawValue {
            // AppKit can deliver a control action after currentEvent has changed.
            let clickCount = app.currentEvent.flatMap { event in
                event.type == .leftMouseDown || event.type == .leftMouseUp ? event.clickCount : nil
            }
            guard unlock.accept(currentClickCount: clickCount, doubleClickInterval: NSEvent.doubleClickInterval) else {
                sender.isEnabled = false
                return
            }
        }
        app.stopModal(withCode: .init(rawValue: sender.tag))
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

    private func showStatus(host: String) -> Bool {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        guard let button = item.button else { return false }
        button.title = "Rome Computer Use"

        let menu = NSMenu()
        menu.addItem(withTitle: host, action: nil, keyEquivalent: "")
        windowItem = menu.addItem(withTitle: "No window bound", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        let stop = menu.addItem(withTitle: "Stop Computer Use", action: #selector(stopSession), keyEquivalent: "")
        stop.target = self
        item.menu = menu
        return true
    }

    func updateBinding(_ label: String?) {
        windowItem?.title = label ?? "No window bound"
    }

    @objc private func stopSession() {
        admission.terminate("local_stop")
    }

    func close() {
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        if let lockObserver { DistributedNotificationCenter.default().removeObserver(lockObserver) }
        statusItem = nil
        windowItem = nil
    }
}

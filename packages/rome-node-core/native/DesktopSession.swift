import AppKit
import Foundation

@MainActor
final class DesktopSession: NSObject {
    private let admission: Admission
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
            \(host) requests access to read and control a window.

            Executable: \(String(reflecting: peer.identity.executable))
            Signing identifier: \(signature)
            """
        let deny = alert.addButton(withTitle: "Deny")
        deny.keyEquivalent = "\r"
        alert.addButton(withTitle: "Allow Session").keyEquivalent = ""
        NSApplication.shared.activate(ignoringOtherApps: true)
        alert.window.makeFirstResponder(deny)

        let timer = Timer(timeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated {
                if !eligible() { NSApplication.shared.abortModal() }
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        let response = alert.runModal()
        timer.invalidate()
        guard response == .alertSecondButtonReturn, eligible() else { return false }
        return showStatus(host: host)
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
        _ = admission.stop("local_stop")
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

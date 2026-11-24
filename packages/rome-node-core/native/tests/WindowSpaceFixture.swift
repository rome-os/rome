import AppKit

private func windows(_ options: CGWindowListOption, _ id: CGWindowID = kCGNullWindowID) -> [[String: Any]] {
    CGWindowListCopyWindowInfo(options, id) as? [[String: Any]] ?? []
}

private func owns(_ row: [String: Any], _ pid: pid_t, _ id: CGWindowID) -> Bool {
    (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
        (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id &&
        (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
}

@MainActor private final class PressableGroup: NSView {
    var onPress: (() -> Void)?

    override func accessibilityPerformPress() -> Bool {
        guard let onPress else { return false }
        onPress()
        return true
    }

    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == #selector(accessibilityPerformPress) || super.isAccessibilitySelectorAllowed(selector)
    }
}

@MainActor private final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let foreground: Bool, directory: URL, targetPID: pid_t, targetWindow: CGWindowID
    let started = ProcessInfo.processInfo.systemUptime
    let window = NSWindow(contentRect: CGRect(x: 42, y: 90, width: 480, height: 280),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    let countLabel = NSTextField(labelWithString: "Count: 0")
    var clicks = 0, fullScreen = false, samples = 0, violations = 0
    var groupPresses = 0
    var pointer: CGPoint?, timer: Timer?

    init(_ args: [String]) {
        foreground = args[0] == "A"
        directory = URL(fileURLWithPath: args[1], isDirectory: true)
        targetPID = foreground ? pid_t(args[2]) ?? 0 : 0
        targetWindow = foreground ? CGWindowID(args[3]) ?? 0 : 0
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = foreground ? "Rome Space Acceptance A" : "Rome Space Acceptance B"
        window.isRestorable = false
        window.delegate = self
        window.center()
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.setAccessibilityIdentifier(foreground ? "space-a-increment" : "space-b-increment")
        button.frame = CGRect(x: 30, y: 130, width: 140, height: 34)
        countLabel.setAccessibilityIdentifier("space-fixture-count")
        countLabel.frame = CGRect(x: 200, y: 136, width: 140, height: 28)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(countLabel)
        if foreground {
            window.collectionBehavior = [.fullScreenPrimary]
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            window.toggleFullScreen(nil)
        } else {
            if let content = window.contentView { addWorkspaceResult(to: content) }
            window.orderBack(nil)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        sample()
    }

    func windowDidEnterFullScreen(_ notification: Notification) { fullScreen = true }
    func windowDidExitFullScreen(_ notification: Notification) { fullScreen = false }

    @objc func increment() {
        clicks += 1
        countLabel.stringValue = "Count: \(clicks)"
    }

    private func addWorkspaceResult(to content: NSView) {
        var parent = content
        for level in 0..<22 {
            let group = level == 21 ? PressableGroup() : NSView()
            group.frame = level == 0 ? CGRect(x: 30, y: 30, width: 155, height: 60) : parent.bounds
            group.setAccessibilityElement(true)
            group.setAccessibilityRole(.group)
            parent.addSubview(group)
            parent = group
        }
        guard let group = parent as? PressableGroup else { return }
        group.setAccessibilityIdentifier("space-b-workspace-result")
        group.onPress = { [weak self] in self?.groupPresses += 1 }
        let label = NSTextField(labelWithString: "Workspace")
        label.setAccessibilityIdentifier("space-b-workspace")
        label.frame = CGRect(x: 10, y: 20, width: 120, height: 24)
        group.addSubview(label)
    }

    func sample() {
        let uptime = ProcessInfo.processInfo.systemUptime
        if uptime - started > 120 || FileManager.default.fileExists(atPath: directory.appendingPathComponent("stop").path) {
            NSApp.terminate(nil)
            return
        }
        let id = CGWindowID(max(0, window.windowNumber))
        let target = foreground ? targetWindow : id
        let owner = foreground ? targetPID : getpid()
        let exact = windows(.optionIncludingWindow, target).filter { owns($0, owner, target) }.count
        let onScreen = windows(.optionOnScreenOnly).contains { owns($0, owner, target) }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if foreground && FileManager.default.fileExists(atPath: directory.appendingPathComponent("arm").path) {
            let current = CGEvent(source: nil)?.location
            if pointer == nil { pointer = current }
            samples += 1
            if current == nil || current != pointer || front != getpid() || !window.isKeyWindow ||
                !fullScreen || exact != 1 || onScreen { violations += 1 }
        }
        let value: [String: Any] = ["pid": getpid(), "window": id, "exact": exact, "onScreen": onScreen,
            "front": front, "key": window.isKeyWindow, "fullScreen": fullScreen, "clicks": clicks,
            "groupPresses": groupPresses, "samples": samples, "violations": violations, "uptime": uptime]
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            try? data.write(to: directory.appendingPathComponent("state.json"), options: .atomic)
        }
    }
}

@main struct WindowSpaceFixture {
    @MainActor static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.count == 2, args[0] == "--identity", let pid = pid_t(args[1]) {
            var seconds: UInt64 = 0, micros: UInt64 = 0
            var path = [CChar](repeating: 0, count: 4096)
            guard rome_process_identity(pid, &seconds, &micros, &path, path.count) == 1,
                  let data = try? JSONSerialization.data(withJSONObject: ["pid": pid, "seconds": seconds,
                      "micros": micros, "executable": String(cString: path)] as [String: Any]) else { exit(1) }
            FileHandle.standardOutput.write(data)
            return
        }
        guard args.count == 2 && args[0] == "B" || args.count == 4 && args[0] == "A" else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let fixture = Fixture(args)
        app.delegate = fixture
        withExtendedLifetime(fixture) { app.run() }
    }
}

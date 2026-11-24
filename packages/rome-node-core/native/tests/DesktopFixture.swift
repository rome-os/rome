import AppKit

private final class FixtureWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private final class DragBoard: NSView {
    var position = CGPoint(x: 70, y: 75)
    var changed: (() -> Void)?
    private var dragging = false
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.93, alpha: 1).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12).fill()
        NSColor.systemGreen.withAlphaComponent(0.25).setFill()
        NSBezierPath(roundedRect: CGRect(x: bounds.width - 140, y: 30, width: 110, height: 100), xRadius: 12, yRadius: 12).fill()
        ("DROP HERE" as NSString).draw(at: CGPoint(x: bounds.width - 130, y: 70), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 12)])
        NSColor.systemOrange.setFill()
        NSBezierPath(ovalIn: CGRect(x: position.x - 22, y: position.y - 22, width: 44, height: 44)).fill()
    }

    override func mouseDown(with event: NSEvent) { dragging = hypot(convert(event.locationInWindow, from: nil).x - position.x, convert(event.locationInWindow, from: nil).y - position.y) <= 25 }
    override func mouseDragged(with event: NSEvent) {
        guard dragging else { return }
        let point = convert(event.locationInWindow, from: nil)
        position = CGPoint(x: min(bounds.width - 22, max(22, point.x)), y: min(bounds.height - 22, max(22, point.y)))
        setAccessibilityValue("Token x \(Int(position.x)) y \(Int(position.y))")
        needsDisplay = true
        changed?()
    }
    override func mouseUp(with event: NSEvent) { dragging = false; changed?() }
}

@MainActor private final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!
    var field: NSTextField!
    var guardField: NSTextField!
    var result: NSTextField!
    var checkbox: NSButton!
    var scroll: NSScrollView!
    var board: DragBoard!
    var total = 0
    var timer: Timer?
    var monitor: Any?
    var events: [[String: Any]] = []
    let directory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/invalid")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let appMenu = NSMenu(), item = NSMenuItem(), menu = NSMenu()
        menu.addItem(withTitle: "Quit Desktop Test", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = menu; appMenu.addItem(item); NSApp.mainMenu = appMenu
        let editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; appMenu.addItem(editItem)
        let screen = NSScreen.screens.first!
        window = FixtureWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "Rome Desktop Controller Native Test"
        window.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.95, blue: 0.92, alpha: 1)
        window.isReleasedWhenClosed = false
        let width = screen.frame.width, height = screen.frame.height
        let content = window.contentView!
        func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 16) -> NSTextField {
            let value = NSTextField(labelWithString: text)
            value.frame = CGRect(x: x, y: y, width: width, height: 36); value.font = .systemFont(ofSize: size)
            content.addSubview(value); return value
        }
        _ = label("Rome desktop control · native input laboratory", x: 36, y: height - 100, width: width - 72, size: 26)
        _ = label("Synthetic data only. This window records actual AppKit input and resulting UI state.", x: 36, y: height - 144, width: width - 72)
        field = NSTextField(string: "")
        field.placeholderString = "Enter text here"
        field.setAccessibilityIdentifier("native-text"); field.setAccessibilityLabel("Native text")
        field.frame = CGRect(x: 36, y: height - 210, width: 580, height: 36); field.delegate = self
        content.addSubview(field)
        guardField = NSTextField(string: "KEEP_GUARD")
        guardField.setAccessibilityIdentifier("native-guard"); guardField.setAccessibilityLabel("Protected field")
        guardField.frame = CGRect(x: 36, y: height - 262, width: 580, height: 36); guardField.delegate = self
        content.addSubview(guardField)
        let add = NSButton(title: "Add 7", target: self, action: #selector(addSeven))
        add.frame = CGRect(x: 36, y: height - 326, width: 180, height: 40)
        add.setAccessibilityIdentifier("native-add"); content.addSubview(add)
        result = label("Native total: 0", x: 240, y: height - 322, width: 350, size: 20)
        result.setAccessibilityIdentifier("native-result")
        checkbox = NSButton(checkboxWithTitle: "Approved", target: self, action: #selector(checkChanged))
        checkbox.frame = CGRect(x: 36, y: height - 380, width: 240, height: 36)
        checkbox.setAccessibilityIdentifier("native-approved"); content.addSubview(checkbox)
        _ = label("Drag the orange token into the green tray", x: 36, y: height - 438, width: 580)
        board = DragBoard(frame: CGRect(x: 36, y: height - 620, width: 580, height: 160))
        board.setAccessibilityElement(true); board.setAccessibilityRole(.group)
        board.setAccessibilityLabel("Drag board"); board.setAccessibilityIdentifier("native-drag")
        board.changed = { [weak self] in Task { @MainActor in self?.save() } }
        content.addSubview(board)
        scroll = NSScrollView(frame: CGRect(x: min(width - 500, 700), y: 100, width: min(450, width - 750), height: height - 290))
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.setAccessibilityIdentifier("native-scroll")
        let document = NSTextView(frame: CGRect(x: 0, y: 0, width: scroll.bounds.width - 20, height: 3600))
        document.string = (1...100).map { "Line \($0): desktop scrolling evidence" }.joined(separator: "\n\n")
        document.isEditable = false; document.font = .monospacedSystemFont(ofSize: 16, weight: .regular)
        scroll.documentView = document; content.addSubview(scroll)
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .leftMouseDragged, .scrollWheel]) { [weak self] event in
            MainActor.assumeIsolated {
                self?.events.append(["type": event.type.rawValue, "at": Date().timeIntervalSince1970,
                                     "sourcePID": event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1,
                                     "keyCode": event.type == .keyDown || event.type == .keyUp ? event.keyCode : 0, "flags": event.modifierFlags.rawValue,
                                     "characters": event.type == .keyDown || event.type == .keyUp ? event.charactersIgnoringModifiers ?? "" : ""])
                if (self?.events.count ?? 0) > 1000 { self?.events.removeFirst() }
            }
            return event
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.save() } }
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(field); NSApp.activate(ignoringOtherApps: true)
        save()
    }

    func controlTextDidChange(_ notification: Notification) { save() }
    @objc func addSeven() { total += 7; result.stringValue = "Native total: \(total)"; save() }
    @objc func checkChanged() { save() }
    func save() {
        let selection = (field.currentEditor() as? NSTextView)?.selectedRange()
        let value: [String: Any] = ["pid": getpid(), "at": Date().timeIntervalSince1970, "text": field.currentEditor()?.string ?? field.stringValue,
            "guard": guardField.currentEditor()?.string ?? guardField.stringValue, "total": total, "approved": checkbox.state == .on,
            "scrollY": Double(scroll.contentView.bounds.origin.y), "drag": [Double(board.position.x), Double(board.position.y)],
            "events": events, "isActive": NSApp.isActive, "selection": [selection?.location ?? -1, selection?.length ?? -1]]
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? bytes.write(to: directory.appendingPathComponent("native-state.json"), options: .atomic)
        }
    }
}

@main struct DesktopFixtureMain {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate = FixtureDelegate(); app.delegate = delegate; app.run()
        withExtendedLifetime(delegate) {}
    }
}

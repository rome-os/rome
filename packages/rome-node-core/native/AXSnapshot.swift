import ApplicationServices
import CoreGraphics

enum AXSnapshotReader {
    typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    static func isMenuRole(_ role: String) -> Bool {
        ["AXMenu", "AXMenuBar", "AXMenuBarItem", "AXMenuItem", "AXPopUpButton", "AXMenuButton", "AXComboBox"].contains(role)
    }

    static func retryTransientRead(_ error: AXError, attempt: Int, elapsed: TimeInterval) -> Bool {
        error == .cannotComplete && attempt < 2 && elapsed < 0.2
    }

    static func focusedWindow(pid: pid_t) throws -> CGWindowID {
        try retryUnavailableRead("focused_window_unavailable") { try readFocusedWindow(pid: pid) }
    }

    static func retryUnavailableRead<T>(_ code: String, _ read: () throws -> T) throws -> T {
        let started = ProcessInfo.processInfo.systemUptime
        var attempt = 0
        while true {
            do { return try read() }
            catch let failure as NativeFailure {
                if failure.code == code,
                   failure.details["axError"] as? Int32 == AXError.cannotComplete.rawValue,
                   retryTransientRead(.cannotComplete, attempt: attempt, elapsed: ProcessInfo.processInfo.systemUptime - started) {
                    usleep(5_000)
                    if retryTransientRead(.cannotComplete, attempt: attempt, elapsed: ProcessInfo.processInfo.systemUptime - started) {
                        attempt += 1
                        continue
                    }
                }
                throw NativeFailure(failure.code, failure.message, details: failure.details.merging(["readAttempts": attempt + 1]) { _, b in b })
            }
        }
    }

    private static func readFocusedWindow(pid: pid_t) throws -> CGWindowID {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.04)
        var raw: CFTypeRef?
        let attributeError = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &raw)
        guard attributeError == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw NativeFailure("focused_window_unavailable", details: ["stage": "focused_window_attribute", "axError": attributeError.rawValue])
        }
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else {
            throw NativeFailure("focused_window_unavailable", details: ["stage": "window_identity_symbol"])
        }
        let element = raw as! AXUIElement, get = unsafeBitCast(pointer, to: GetWindow.self)
        AXUIElementSetMessagingTimeout(element, 0.04)
        var window: CGWindowID = 0
        let windowError = get(element, &window)
        guard windowError == .success, window > 0 else {
            throw NativeFailure("focused_window_unavailable", details: ["stage": "focused_window_identity", "axError": windowError.rawValue, "window": window])
        }
        var owner: pid_t = 0
        let ownerError = AXUIElementGetPid(element, &owner)
        guard ownerError == .success, owner == pid else {
            throw NativeFailure("focused_window_unavailable", details: ["stage": "focused_window_owner", "axError": ownerError.rawValue, "ownerPID": owner])
        }
        _ = try cgBounds(pid: pid, window: window)
        return window
    }

    static func cgBounds(pid: pid_t, window: CGWindowID, allowOffscreen: Bool = false) throws -> [Double] {
        guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, window) as? [[String: Any]] else {
            throw NativeFailure("window_list_unavailable")
        }
        let matches = windows.filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
        guard matches.count == 1, let row = matches.first else { throw NativeFailure("window_missing") }
        if allowOffscreen {
            guard (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { throw NativeFailure("window_missing") }
            return try windowBounds(row)
        }
        return try onScreenBounds(row)
    }

    static func onScreenBounds(_ row: [String: Any]) throws -> [Double] {
        guard (row[kCGWindowIsOnscreen as String] as? Bool) == true else {
            throw NativeFailure("window_not_onscreen")
        }
        return try windowBounds(row)
    }

    private static func windowBounds(_ row: [String: Any]) throws -> [Double] {
        guard let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite, rect.height.isFinite,
              rect.width > 0, rect.height > 0 else {
            throw NativeFailure("window_bounds_unavailable")
        }
        return [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
    }


    @discardableResult
    static func verifyExactWindow(_ element: AXUIElement, pid: pid_t, window: CGWindowID? = nil) throws -> CGWindowID {
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else {
            throw NativeFailure("private_window_identity_unavailable")
        }
        let get = unsafeBitCast(pointer, to: GetWindow.self)
        var found: CGWindowID = 0
        var owner: pid_t = 0
        let windowError = get(element, &found), ownerError = AXUIElementGetPid(element, &owner)
        guard windowError == .success, ownerError == .success, found > 0, window == nil || found == window, owner == pid else {
            throw NativeFailure("window_binding_changed", details: ["expectedWindow": window ?? 0, "actualWindow": found,
                "expectedPID": pid, "actualPID": owner, "windowError": windowError.rawValue, "ownerError": ownerError.rawValue])
        }
        return found
    }
}

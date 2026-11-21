import AppKit
import ApplicationServices
import CoreGraphics

struct ProcessBinding: Equatable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executable: String
    let bundleId: String

    static func kernel(_ pid: pid_t) throws -> (seconds: UInt64, microseconds: UInt64, executable: String) {
        var seconds: UInt64 = 0
        var microseconds: UInt64 = 0
        var path = [CChar](repeating: 0, count: 4096)
        let result = path.withUnsafeMutableBufferPointer {
            rome_process_identity(pid, &seconds, &microseconds, $0.baseAddress, $0.count)
        }
        guard result == 1 else { throw NativeFailure("process_identity_unavailable") }
        return (seconds, microseconds, String(cString: path))
    }

    static func read(_ pid: pid_t) throws -> ProcessBinding {
        let identity = try kernel(pid)
        guard let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated,
              let bundleId = application.bundleIdentifier, application.executableURL?.path == identity.executable else {
            throw NativeFailure("application_identity_unavailable")
        }
        return ProcessBinding(pid: pid, startSeconds: identity.seconds, startMicroseconds: identity.microseconds,
                              executable: identity.executable, bundleId: bundleId)
    }

    func verify() throws {
        // Launch Services metadata can disappear transiently. Kernel birth time and executable
        // keep this binding tied to the same process without relying on that metadata cache.
        let identity = try Self.kernel(pid)
        guard identity.seconds == startSeconds, identity.microseconds == startMicroseconds,
              identity.executable == executable else { throw NativeFailure("process_identity_changed") }
    }
}

struct PeerIdentity: Hashable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executable: String

    static func read(_ pid: pid_t) throws -> PeerIdentity {
        let identity = try ProcessBinding.kernel(pid)
        return PeerIdentity(pid: pid, startSeconds: identity.seconds, startMicroseconds: identity.microseconds,
                            executable: identity.executable)
    }

    func isAlive() -> Bool {
        guard let current = try? ProcessBinding.kernel(pid) else { return false }
        return current.seconds == startSeconds && current.microseconds == startMicroseconds
            && current.executable == executable
    }
}

enum NativePath {
    static func canonical(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    static func requireSafeDirectory(_ url: URL, privateMode: Bool = true, errorCode: String) throws {
        let standardized = url.standardized.path
        var info = stat()
        guard lstat(standardized, &info) == 0,
              info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFDIR,
              info.st_mode & (privateMode ? 0o777 : 0o022) == (privateMode ? 0o700 : 0),
              canonical(standardized) == standardized else {
            throw NativeFailure(errorCode)
        }
    }
}

enum NativeFocus {
    typealias ToPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<Int32>) -> Int32
    typealias GetFocus = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
    static let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    static let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_LAZY)

    static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
        for handle in [sky, carbon, UnsafeMutableRawPointer(bitPattern: -2)] {
            if let handle, let pointer = dlsym(handle, name) { return unsafeBitCast(pointer, to: type) }
        }
        return nil
    }

    static func keyPID() throws -> pid_t {
        guard let get = symbol("SLPSGetKeyFocusProcess", GetFocus.self),
              let convert = symbol("GetProcessPID", ToPID.self) else {
            throw NativeFailure("focus_telemetry_unavailable")
        }
        var psn = [UInt32](repeating: 0, count: 2)
        var extra = [UInt64](repeating: 0, count: 2)
        let status = psn.withUnsafeMutableBytes { p in
            extra.withUnsafeMutableBytes { get(p.baseAddress!, $0.baseAddress!) }
        }
        var pid: Int32 = 0
        let converted = psn.withUnsafeBytes { convert($0.baseAddress!, &pid) }
        guard status == 0, converted == 0, pid > 0 else { throw NativeFailure("focus_telemetry_unavailable") }
        return pid
    }

    static func state() throws -> (front: pid_t, key: pid_t) {
        _ = try consoleState()
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.bundleIdentifier != "com.apple.loginwindow" else {
            throw NativeFailure("console_session_locked_or_unavailable")
        }
        let front = application.processIdentifier
        guard front > 0 else {
            throw NativeFailure("focus_telemetry_unavailable")
        }
        return (front, try keyPID())
    }

    static func consoleState() throws -> [String: Any] {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              let uid = session[kCGSessionUserIDKey as String] as? NSNumber,
              uid.uint32Value == getuid(),
              let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool, onConsole,
              let loggedIn = session[kCGSessionLoginDoneKey as String] as? Bool, loggedIn else {
            throw NativeFailure("console_session_unavailable")
        }
        // On the qualified OS, WindowServer includes this private key only while locked.
        // A missing session/public field or a malformed present lock value never grants access.
        let marker = session["CGSSessionScreenIsLocked"]
        if let marker {
            guard let number = marker as? NSNumber,
                  CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw NativeFailure("console_lock_state_unavailable")
            }
            guard !number.boolValue else { throw NativeFailure("console_session_locked") }
        }
        return ["onConsole": true, "loginDone": true, "lockIndicatorPresent": marker != nil,
                "lockIndicator": marker == nil ? "absent_on_unlocked_session" : "false"]
    }

}

import Foundation
import Darwin

enum NativeInstaller {
    private static func directory(_ path: URL, privateMode: Bool) throws {
        var info = stat()
        guard path.resolvingSymlinksInPath().path == path.standardizedFileURL.path,
              lstat(path.path, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFDIR,
              info.st_mode & (privateMode ? 0o777 : 0o022) == (privateMode ? 0o700 : 0) else {
            throw NativeFailure("unsafe_install_directory")
        }
    }

    static func install(arguments: [String]) throws -> [String: Any] {
        guard let index = arguments.firstIndex(of: "--state-dir"), arguments.indices.contains(index + 1) else {
            throw NativeFailure("install_state_directory_required")
        }
        let state = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardizedFileURL
        try directory(state, privateMode: true)
        let source = Bundle.main.bundleURL.standardizedFileURL
        let stage = source.deletingLastPathComponent()
        guard source.lastPathComponent == "Rome Computer Use.app",
              stage.lastPathComponent.hasPrefix(".staging-"), stage.deletingLastPathComponent().path == state.path,
              Bundle.main.bundleIdentifier == "com.rome.computer-use" else {
            throw NativeFailure("invalid_staged_application")
        }
        try directory(stage, privateMode: true)
        try directory(source, privateMode: false)
        let file = open(state.appendingPathComponent("helper.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard file >= 0 else { throw NativeFailure("install_lock_unavailable") }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, info.st_nlink == 1 else { throw NativeFailure("unsafe_install_lock") }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else { throw NativeFailure("helper_running_install_refused") }
        let destination = state.appendingPathComponent("Rome Computer Use.app", isDirectory: true)
        let previous = state.appendingPathComponent(".previous-app-\(UUID().uuidString.lowercased()).app", isDirectory: true)
        var preserved = false
        if lstat(destination.path, &info) == 0 {
            try directory(destination, privateMode: false)
            guard Bundle(url: destination)?.bundleIdentifier == "com.rome.computer-use" else {
                throw NativeFailure("installed_application_identity_mismatch")
            }
            guard rename(destination.path, previous.path) == 0 else { throw NativeFailure("preserve_installed_application_failed") }
            preserved = true
        } else if errno != ENOENT { throw NativeFailure("installed_application_unavailable") }
        if rename(source.path, destination.path) != 0 {
            let failure = errno
            let restored = !preserved || rename(previous.path, destination.path) == 0
            throw NativeFailure("install_application_failed", details: ["errno": failure, "previousRestored": restored,
                "previousPath": preserved ? previous.path : ""])
        }
        var result: [String: Any] = ["ok": true, "path": destination.path]
        if preserved { result["previousPath"] = previous.path }
        return result
    }
}

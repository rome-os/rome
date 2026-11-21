import Foundation
import Darwin

enum NativeInstaller {
    static func install(arguments: [String]) throws -> [String: Any] {
        guard let index = arguments.firstIndex(of: "--state-dir"), arguments.indices.contains(index + 1) else {
            throw NativeFailure("install_state_directory_required")
        }
        let state = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardized
        try NativePath.requireSafeDirectory(state, privateMode: true, errorCode: "unsafe_install_directory")
        let source = Bundle.main.bundleURL.standardized
        let stage = source.deletingLastPathComponent()
        guard source.lastPathComponent == "Rome Computer Use.app",
              stage.lastPathComponent.hasPrefix(".staging-"), stage.deletingLastPathComponent().path == state.path,
              Bundle.main.bundleIdentifier == "com.rome.computer-use" else {
            throw NativeFailure("invalid_staged_application")
        }
        try NativePath.requireSafeDirectory(stage, privateMode: true, errorCode: "unsafe_install_directory")
        try NativePath.requireSafeDirectory(source, privateMode: false, errorCode: "unsafe_install_directory")
        let file = open(state.appendingPathComponent("helper.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard file >= 0 else { throw NativeFailure("install_lock_unavailable") }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, info.st_nlink == 1 else { throw NativeFailure("unsafe_install_lock") }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else { throw NativeFailure("helper_running_install_refused") }
        let destination = state.appendingPathComponent("Rome Computer Use.app", isDirectory: true)
        var result: [String: Any] = ["ok": true, "path": destination.path]
        if lstat(destination.path, &info) == 0 {
            try NativePath.requireSafeDirectory(destination, privateMode: false, errorCode: "unsafe_install_directory")
            guard Bundle(url: destination)?.bundleIdentifier == "com.rome.computer-use" else {
                throw NativeFailure("installed_application_identity_mismatch")
            }
            // Swap atomically so the installed path is never absent; the displaced bundle lands at the staged path
            // where the caller's staging cleanup removes it without leaving orphaned backups in the state directory.
            guard renamex_np(source.path, destination.path, UInt32(RENAME_SWAP)) == 0 else {
                throw NativeFailure("install_application_failed", details: ["errno": errno, "atomicSwap": true])
            }
            result["previousPath"] = source.path
        } else if errno == ENOENT {
            guard renamex_np(source.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
                throw NativeFailure("install_application_failed", details: ["errno": errno, "atomicSwap": false])
            }
        } else {
            throw NativeFailure("installed_application_unavailable")
        }
        return result
    }
}

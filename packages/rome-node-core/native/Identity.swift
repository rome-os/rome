import Darwin
import Darwin.libproc
import Darwin.sys.proc_info
import Foundation
import Security

struct Failure: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

struct ProcessIdentity: Equatable {
    let pid: pid_t
    let uid: uid_t
    let seconds: UInt64
    let microseconds: UInt64
    let executable: String

    static func read(_ pid: pid_t) throws -> Self {
        func sample() throws -> proc_bsdinfo {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
                  info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000 else {
                throw Failure("process_identity_unavailable")
            }
            return info
        }

        let before = try sample()
        var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        let after = try sample()
        guard length > 0, let end = buffer.firstIndex(of: 0), end == Int(length),
              let path = String(bytes: buffer[..<end], encoding: .utf8), path.hasPrefix("/"),
              before.pbi_uid == after.pbi_uid, before.pbi_ruid == after.pbi_ruid,
              before.pbi_start_tvsec == after.pbi_start_tvsec,
              before.pbi_start_tvusec == after.pbi_start_tvusec else {
            throw Failure("process_identity_unavailable")
        }
        return Self(pid: pid, uid: after.pbi_uid, seconds: after.pbi_start_tvsec,
                    microseconds: after.pbi_start_tvusec, executable: path)
    }

    func verify() throws {
        guard (try? Self.read(pid)) == self else { throw Failure("process_identity_changed") }
    }
}

struct Peer {
    let identity: ProcessIdentity
    let audit: Data
    let cdHash: Data

    static func authenticate(_ fd: Int32, expecting expected: ProcessIdentity) throws -> Self {
        var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
        var token = audit_token_t()
        var pidSize = socklen_t(MemoryLayout.size(ofValue: pid))
        var tokenSize = socklen_t(MemoryLayout.size(ofValue: token))
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(), uid == expected.uid,
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize) == 0,
              pidSize == MemoryLayout.size(ofValue: pid), pid == expected.pid,
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenSize) == 0,
              tokenSize == MemoryLayout.size(ofValue: token),
              token.val.1 == uid, token.val.2 == gid, token.val.5 == UInt32(pid) else {
            throw Failure("peer_rejected")
        }

        try expected.verify()
        let audit = withUnsafeBytes(of: token) { Data($0) }
        let hash = try signingHash(audit)
        try expected.verify()
        return Self(identity: expected, audit: audit, cdHash: hash)
    }

    func revalidate() throws {
        try identity.verify()
        guard try Self.signingHash(audit) == cdHash else { throw Failure("peer_rejected") }
        try identity.verify()
    }

    private static func signingHash(_ audit: Data) throws -> Data {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        let attributes = [kSecGuestAttributeAudit as String: audit] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, [], nil) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let hash = (information as? [String: Any])?[kSecCodeInfoUnique as String] as? Data, !hash.isEmpty else {
            throw Failure("peer_rejected")
        }
        return hash
    }
}

func canonicalPath(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

struct FileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t

    init(_ info: stat) { device = info.st_dev; inode = info.st_ino }
}

final class StateDirectory {
    let path: String
    let fd: Int32
    let identity: FileIdentity

    init(_ path: String) throws {
        var info = stat()
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure("unsafe_state_directory") }
        guard fstat(fd, &info) == 0 else {
            close(fd)
            throw Failure("unsafe_state_directory")
        }
        let identity = FileIdentity(info)
        guard Self.safe(path, identity: identity) else {
            close(fd)
            throw Failure("unsafe_state_directory")
        }
        self.fd = fd
        self.path = path
        self.identity = identity
    }

    deinit { close(fd) }

    var intact: Bool { Self.safe(path, identity: identity) }

    private static func safe(_ path: String, identity: FileIdentity) -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == getuid(),
              info.st_mode & (S_IFMT | 0o7777) == S_IFDIR | 0o700,
              FileIdentity(info) == identity else { return false }
        return canonicalPath(path) == path
    }

    func socketIdentity() -> FileIdentity? {
        var info = stat()
        guard intact, fstatat(fd, "helper.sock", &info, AT_SYMLINK_NOFOLLOW) == 0,
              info.st_uid == getuid(), info.st_mode & (S_IFMT | 0o7777) == S_IFSOCK | 0o600 else { return nil }
        return FileIdentity(info)
    }
}

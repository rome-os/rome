import CryptoKit
import Darwin
import Darwin.libproc
import Darwin.sys.proc_info
import Foundation
import Security

struct Failure: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

struct ProcessGeneration: Equatable {
    let uniqueID: UInt64
    let idVersion: UInt32

    static func read(_ pid: pid_t) throws -> Self {
        // XNU's proc_uniqidentifierinfo ABI is absent from the public SDK.
        let flavor: Int32 = 17 // PROC_PIDUNIQIDENTIFIERINFO
        let size: Int32 = 56
        return try withUnsafeTemporaryAllocation(byteCount: Int(size), alignment: 8) { bytes in
            guard pid > 0, proc_pidinfo(pid, flavor, 0, bytes.baseAddress, size) == size else {
                throw Failure("process_identity_unavailable")
            }
            return Self(uniqueID: bytes.load(fromByteOffset: 16, as: UInt64.self),
                        idVersion: bytes.load(fromByteOffset: 32, as: UInt32.self))
        }
    }
}

struct ProcessIdentity: Equatable {
    let pid: pid_t
    let uid: uid_t
    let seconds: UInt64
    let microseconds: UInt64
    let executable: String
    let generation: ProcessGeneration

    private static func sample(_ pid: pid_t) throws -> proc_bsdinfo {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000 else {
            throw Failure("process_identity_unavailable")
        }
        return info
    }

    static func read(_ pid: pid_t) throws -> Self {
        let generation = try ProcessGeneration.read(pid)
        let before = try sample(pid)
        var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        let after = try sample(pid)
        guard length > 0, let end = buffer.firstIndex(of: 0), end == Int(length),
              let path = String(bytes: buffer[..<end], encoding: .utf8), path.hasPrefix("/"),
              before.pbi_uid == after.pbi_uid, before.pbi_ruid == after.pbi_ruid,
              before.pbi_start_tvsec == after.pbi_start_tvsec,
              before.pbi_start_tvusec == after.pbi_start_tvusec,
              try ProcessGeneration.read(pid) == generation else {
            throw Failure("process_identity_unavailable")
        }
        return Self(pid: pid, uid: after.pbi_uid, seconds: after.pbi_start_tvsec,
                    microseconds: after.pbi_start_tvusec, executable: path, generation: generation)
    }

    func verify() throws {
        guard (try? Self.read(pid)) == self else { throw Failure("process_identity_changed") }
    }

    func verifyPeer() throws {
        guard let current = try? Self.sample(pid), current.pbi_uid == uid,
              current.pbi_start_tvsec == seconds, current.pbi_start_tvusec == microseconds,
              (try? ProcessGeneration.read(pid)) == generation else {
            throw Failure("process_identity_changed")
        }
    }
}

struct Peer {
    struct SigningSummary: Sendable {
        let identifier: String
        let teamID: String?
    }

    let identity: ProcessIdentity
    let audit: Data
    let signingSummary: SigningSummary?

    static func authenticate(_ fd: Int32, expecting expected: ProcessIdentity, signed: Bool) throws -> Self {
        var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
        var token = audit_token_t()
        var pidSize = socklen_t(MemoryLayout.size(ofValue: pid))
        var tokenSize = socklen_t(MemoryLayout.size(ofValue: token))
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(), uid == expected.uid,
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize) == 0,
              pidSize == MemoryLayout.size(ofValue: pid), pid == expected.pid,
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenSize) == 0,
              tokenSize == MemoryLayout.size(ofValue: token),
              token.val.1 == uid, token.val.2 == gid, token.val.5 == UInt32(pid),
              token.val.7 == expected.generation.idVersion else {
            throw Failure("peer_rejected")
        }

        try expected.verify()
        // Keep the token from authentication as a snapshot of the admitted peer.
        let audit = withUnsafeBytes(of: token) { Data($0) }
        var signingSummary: SigningSummary?
        if signed {
            var code: SecCode?
            var staticCode: SecStaticCode?
            var rawInfo: CFDictionary?
            let attributes = [kSecGuestAttributeAudit as String: audit] as CFDictionary
            guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
                  let code, SecCodeCheckValidity(code, [], nil) == errSecSuccess,
                  SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
                  SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
                                                &rawInfo) == errSecSuccess,
                  let info = rawInfo as? [String: Any],
                  let identifier = info[kSecCodeInfoIdentifier as String] as? String else {
                throw Failure("peer_rejected")
            }
            signingSummary = SigningSummary(identifier: identifier, teamID: info[kSecCodeInfoTeamIdentifier as String] as? String)
            try expected.verify()
        }
        return Self(identity: expected, audit: audit, signingSummary: signingSummary)
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

private struct Bootstrap: Decodable {
    let secret: String
    let hostPid: pid_t
    let hostExecutable: String

    func key() throws -> SymmetricKey {
        let hex = Array(secret.utf8)
        guard hex.count == 64, hex.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw Failure("authentication_failed")
        }
        func nibble(_ byte: UInt8) -> UInt8 { byte <= 57 ? byte - 48 : byte - 87 }
        let bytes = stride(from: 0, to: hex.count, by: 2).map { index in
            nibble(hex[index]) << 4 | nibble(hex[index + 1])
        }
        return SymmetricKey(data: bytes)
    }
}

final class StateDirectory: Sendable {
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
        guard canonicalPath(path) == path, Self.safe(path, identity: identity) else {
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
        return lstat(path, &info) == 0 && info.st_uid == getuid() &&
            info.st_mode & (S_IFMT | 0o7777) == S_IFDIR | 0o700 && FileIdentity(info) == identity
    }

    func consumeBootstrap() throws -> (host: ProcessIdentity, key: SymmetricKey) {
        let name = "bootstrap.json"
        let input = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard input >= 0 else { throw Failure("authentication_failed") }
        defer { close(input) }
        var opened = stat(), current = stat()
        guard fstat(input, &opened) == 0,
              opened.st_uid == getuid(), opened.st_mode & (S_IFMT | 0o7777) == S_IFREG | 0o600,
              opened.st_nlink == 1,
              fstatat(fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              FileIdentity(current) == FileIdentity(opened) else { throw Failure("authentication_failed") }

        // The open descriptor keeps the file readable after it is consumed.
        guard unlinkat(fd, name, 0) == 0, (1...16384).contains(opened.st_size),
              let data = try? readBytes(input, count: Int(opened.st_size)) else {
            throw Failure("authentication_failed")
        }
        var extra: UInt8 = 0
        guard read(input, &extra, 1) == 0, let bootstrap = try? JSONDecoder().decode(Bootstrap.self, from: data),
              bootstrap.hostExecutable.hasPrefix("/"), !bootstrap.hostExecutable.utf8.contains(0),
              let executable = canonicalPath(bootstrap.hostExecutable),
              let host = try? ProcessIdentity.read(bootstrap.hostPid),
              host.uid == getuid(), host.executable == executable else { throw Failure("authentication_failed") }
        return (host, try bootstrap.key())
    }

    func socketIdentity() -> FileIdentity? {
        var info = stat()
        guard intact, fstatat(fd, "helper.sock", &info, AT_SYMLINK_NOFOLLOW) == 0,
              info.st_uid == getuid(), info.st_mode & (S_IFMT | 0o7777) == S_IFSOCK | 0o600 else { return nil }
        return FileIdentity(info)
    }
}

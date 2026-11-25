import CryptoKit
import Foundation

enum ControllerScope: String, Codable, Sendable {
    case remote, local
}

struct ControllerKey: Sendable {
    let signingKey: Curve25519.Signing.PublicKey
    let base64: String
    let fingerprint: String

    init(_ base64: String) throws {
        guard base64.utf8.count == 44, let bytes = Data(base64Encoded: base64), bytes.count == 32,
              bytes.base64EncodedString() == base64, Self.validEncoding(bytes),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: bytes) else {
            throw Failure("invalid_request")
        }
        signingKey = key
        self.base64 = base64
        let hash = Array(SHA256.hash(data: bytes).prefix(6))
        fingerprint = stride(from: 0, to: hash.count, by: 2)
            .map { String(format: "%02X%02X", hash[$0], hash[$0 + 1]) }.joined(separator: "-")
    }

    private static let smallOrderY: Set<Data> = Set([
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "JuiVj8KyJ7BFw/SJ8u+Y8NXfrAXTxjM5sTgCiG1T/AU=",
        "xxdqcD1N2E+6PAt2DRBnDyogU/osOczGTsf9d5KsA3o=",
    ].map { Data(base64Encoded: $0)! })
    private static let fieldModulusMinusOne = Data(base64Encoded: "7P///////////////////////////////////////38=")!

    private static func validEncoding(_ bytes: Data) -> Bool {
        // RFC 9381 §5.4.5 lists the small-order points, which cannot prove private-key possession.
        var y = bytes
        y[31] &= 0x7F
        return y.reversed().lexicographicallyPrecedes(fieldModulusMinusOne.reversed()) && !smallOrderY.contains(y)
    }

    static func validFingerprint(_ fingerprint: String) -> Bool {
        let groups = fingerprint.split(separator: "-", omittingEmptySubsequences: false)
        return groups.count == 3 && groups.allSatisfy { group in
            group.utf8.count == 4 && group.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) }
        }
    }
}

struct TrustedKeyRecord: Codable, Equatable, Sendable {
    let publicKey: String
    let fingerprint: String
    let label: String
    let scope: ControllerScope
    let enrolledAt: TimeInterval

    init(key: ControllerKey, label: String, scope: ControllerScope) {
        publicKey = key.base64
        fingerprint = key.fingerprint
        self.label = label
        self.scope = scope
        enrolledAt = Date().timeIntervalSince1970
    }

    var summary: [String: Any] {
        ["fingerprint": fingerprint, "label": label, "scope": scope.rawValue, "enrolledAt": enrolledAt]
    }

    fileprivate var valid: Bool {
        (try? ControllerKey(publicKey).fingerprint) == fingerprint && sanitizeLabel(label) == label &&
            enrolledAt.isFinite && enrolledAt > 0
    }
}

enum TrustedKeySelector: Sendable {
    case publicKey(String), fingerprint(String)
}

protocol TrustedKeyStore: Sendable {
    func list() throws -> [TrustedKeyRecord]
    func lookup(publicKey: String) throws -> TrustedKeyRecord?
    func enroll(_ record: TrustedKeyRecord) throws -> (record: TrustedKeyRecord, enrolled: Bool)
    func revoke(_ selector: TrustedKeySelector) throws
    func revokeAll() throws
}

extension TrustedKeyStore {
    func lookup(publicKey: String) throws -> TrustedKeyRecord? {
        try list().first { $0.publicKey == publicKey }
    }

    func revoke(fingerprint: String) throws {
        guard ControllerKey.validFingerprint(fingerprint) else { throw Failure("invalid_request") }
        try revoke(.fingerprint(fingerprint))
    }
}

private struct TrustedKeyRecords {
    static let limit = 32
    var values: [TrustedKeyRecord]

    mutating func enroll(_ record: TrustedKeyRecord) throws -> (record: TrustedKeyRecord, enrolled: Bool) {
        guard record.valid else { throw Failure("invalid_request") }
        if let index = values.firstIndex(where: { $0.publicKey == record.publicKey }) {
            let previous = values[index]
            if previous.scope == record.scope { return (previous, false) }
            values[index] = record
        } else {
            guard values.count < Self.limit else { throw Failure("trusted_key_limit") }
            values.append(record)
        }
        return (record, true)
    }

    mutating func revoke(_ selector: TrustedKeySelector) throws {
        switch selector {
        case .publicKey(let key):
            values.removeAll { $0.publicKey == key }
        case .fingerprint(let fingerprint):
            let matches = values.indices.filter { values[$0].fingerprint == fingerprint }
            guard matches.count <= 1 else { throw Failure("key_fingerprint_ambiguous") }
            if let index = matches.first { values.remove(at: index) }
        }
    }
}

#if SELF_TEST_BUILD
final class MemoryTrustedKeyStore: TrustedKeyStore, @unchecked Sendable {
    // The lock owns all access to records across test connections.
    private let lock = NSLock()
    private var records = TrustedKeyRecords(values: [])

    func list() -> [TrustedKeyRecord] { lock.withLock { records.values } }

    func enroll(_ record: TrustedKeyRecord) throws -> (record: TrustedKeyRecord, enrolled: Bool) {
        try lock.withLock { try records.enroll(record) }
    }

    func revoke(_ selector: TrustedKeySelector) throws {
        try lock.withLock { try records.revoke(selector) }
    }

    func revokeAll() { lock.withLock { records.values.removeAll() } }
}
#else
import Darwin
import LocalAuthentication
import Security

struct KeychainTrustedKeyStore: TrustedKeyStore {
    private func query() throws -> [String: Any] {
        guard let task = SecTaskCreateFromSelf(nil),
              let group = SecTaskCopyValueForEntitlement(task, "com.apple.application-identifier" as CFString, nil) as? String,
              group.hasSuffix("." + bundleIdentifier) else { throw Failure("key_store_unavailable") }
        let context = LAContext()
        context.interactionNotAllowed = true
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.rome.computer-use.authorized-keys",
            kSecAttrAccount as String: "v1",
            kSecAttrAccessGroup as String: group,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
    }

    func list() throws -> [TrustedKeyRecord] { try read(query()) ?? [] }

    private func read(_ query: [String: Any]) throws -> [TrustedKeyRecord]? {
        var query = query
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 64 * 1024,
              let records = try? JSONDecoder().decode([TrustedKeyRecord].self, from: data),
              records.count <= TrustedKeyRecords.limit, records.allSatisfy(\.valid),
              Set(records.map(\.publicKey)).count == records.count else { throw Failure("key_store_unavailable") }
        return records
    }

    private func withWriteLock<T>(_ operation: () throws -> T) throws -> T {
        // Separate helper and CLI processes serialize read-modify-write on the per-user temp directory inode.
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let count = confstr(_CS_DARWIN_USER_TEMP_DIR, &path, path.count)
        guard count > 2, count <= path.count else { throw Failure("key_store_unavailable") }
        if path[count - 2] == 47 { path[count - 2] = 0 }
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure("key_store_unavailable") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o077 == 0,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure("key_store_unavailable") }
        return try operation()
    }

    private func change<T>(_ update: (inout TrustedKeyRecords) throws -> T) throws -> T {
        try withWriteLock {
            let query = try query()
            let previous = try read(query)
            var records = TrustedKeyRecords(values: previous ?? [])
            let result = try update(&records)
            guard records.values != (previous ?? []) else { return result }
            guard let data = try? JSONEncoder().encode(records.values) else { throw Failure("key_store_unavailable") }
            let status: OSStatus
            if previous == nil {
                var item = query
                item[kSecValueData as String] = data
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                status = SecItemAdd(item as CFDictionary, nil)
            } else {
                status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            }
            guard status == errSecSuccess else { throw Failure("key_store_unavailable") }
            return result
        }
    }

    func enroll(_ record: TrustedKeyRecord) throws -> (record: TrustedKeyRecord, enrolled: Bool) {
        try change { try $0.enroll(record) }
    }

    func revoke(_ selector: TrustedKeySelector) throws {
        try change { try $0.revoke(selector) }
    }

    func revokeAll() throws {
        try withWriteLock {
            let status = SecItemDelete(try query() as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure("key_store_unavailable") }
        }
    }
}
#endif

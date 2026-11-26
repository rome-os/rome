import CryptoKit
import Foundation
import Security
#if !SELF_TEST_BUILD
import LocalAuthentication
#endif

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
        let hash = Array(SHA256.hash(data: bytes).prefix(16))
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
        return groups.count == 8 && groups.allSatisfy { group in
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
    func enroll(_ record: TrustedKeyRecord) throws
    func revoke(_ selector: TrustedKeySelector) throws
    func revokeAll() throws
}

extension TrustedKeyStore {
    func revoke(fingerprint: String) throws {
        guard ControllerKey.validFingerprint(fingerprint) else { throw Failure("invalid_request") }
        try revoke(.fingerprint(fingerprint))
    }
}

protocol KeychainItems: Sendable {
    func copy(_ query: [String: Any]) -> (OSStatus, Any?)
    func add(_ item: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], values: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

struct KeychainTrustedKeyStore: TrustedKeyStore {
    let accessGroup: String?
    let items: any KeychainItems

    private func query(account: String? = nil) throws -> [String: Any] {
        guard let accessGroup else { throw Failure("key_store_unavailable") }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.rome.computer-use.authorized-keys",
            kSecAttrAccessGroup as String: accessGroup,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
        query[kSecAttrAccount as String] = account
        #if !SELF_TEST_BUILD
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        #endif
        return query
    }

    private func copy(_ query: [String: Any]) throws -> Any? {
        let (status, result) = items.copy(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let result else { throw Failure("key_store_unavailable") }
        return result
    }

    private func decode(_ value: Any?, account: String) -> TrustedKeyRecord? {
        guard let data = value as? Data, data.count <= 64 * 1024,
              let record = try? JSONDecoder().decode(TrustedKeyRecord.self, from: data),
              record.publicKey == account, record.valid else { return nil }
        return record
    }

    private func entries() throws -> [[String: Any]] {
        var query = try query()
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        guard let result = try copy(query) else { return [] }
        guard let entries = result as? [[String: Any]] else { throw Failure("key_store_unavailable") }
        return entries
    }

    func list() throws -> [TrustedKeyRecord] {
        try entries().compactMap { item in
            guard let account = item[kSecAttrAccount as String] as? String else { return nil }
            return decode(item[kSecValueData as String], account: account)
        }
    }

    func lookup(publicKey: String) throws -> TrustedKeyRecord? {
        var query = try query(account: publicKey)
        query[kSecReturnData as String] = true
        guard let result = try copy(query) else { return nil }
        guard let record = decode(result, account: publicKey) else { throw Failure("key_store_unavailable") }
        return record
    }

    func enroll(_ record: TrustedKeyRecord) throws {
        guard record.valid else { throw Failure("invalid_request") }
        let entries = try entries()
        // The count is an admission check. Concurrent enrollments of distinct accounts may both pass it.
        guard entries.count < 32 || entries.contains(where: { $0[kSecAttrAccount as String] as? String == record.publicKey })
        else { throw Failure("trusted_key_limit") }

        let query = try query(account: record.publicKey)
        let data = try JSONEncoder().encode(record)
        let values = [kSecValueData as String: data]
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = items.add(item)
        if status == errSecDuplicateItem {
            // A concurrent revoke can make this update fail. Retrying the add would restore a revoked grant.
            guard items.update(query, values: values) == errSecSuccess else { throw Failure("key_store_unavailable") }
        } else if status != errSecSuccess {
            throw Failure("key_store_unavailable")
        }
    }

    func revoke(_ selector: TrustedKeySelector) throws {
        switch selector {
        case .publicKey(let key):
            try delete(account: key)
        case .fingerprint(let fingerprint):
            let matches = try list().filter { $0.fingerprint == fingerprint }
            guard matches.count <= 1 else { throw Failure("key_fingerprint_ambiguous") }
            if let match = matches.first { try delete(account: match.publicKey) }
        }
    }

    func revokeAll() throws { try delete(account: nil) }

    private func delete(account: String?) throws {
        let status = items.delete(try query(account: account))
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure("key_store_unavailable") }
    }
}

#if !SELF_TEST_BUILD
extension KeychainTrustedKeyStore {
    private static let applicationGroup: String? = {
        guard let task = SecTaskCreateFromSelf(nil),
              let group = SecTaskCopyValueForEntitlement(task, "com.apple.application-identifier" as CFString, nil) as? String,
              let separator = group.firstIndex(of: "."), separator != group.startIndex,
              group[group.index(after: separator)...] == bundleIdentifier else { return nil }
        return group
    }()

    init() {
        self.init(accessGroup: Self.applicationGroup, items: SystemKeychainItems())
    }
}

private struct SystemKeychainItems: KeychainItems {
    func copy(_ query: [String: Any]) -> (OSStatus, Any?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }

    func add(_ item: [String: Any]) -> OSStatus {
        SecItemAdd(item as CFDictionary, nil)
    }

    func update(_ query: [String: Any], values: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, values as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}
#endif

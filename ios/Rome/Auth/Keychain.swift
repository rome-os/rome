import Foundation
import Security

/// Small wrapper over generic-password Keychain items. Items stay on this
/// device and are readable after the first unlock, like the old app's store.
enum Keychain {
    private static let service = "cc.romeos.mobile"

    static func set(_ data: Data, for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func data(for key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Every key the app keeps here.
    static func keys() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]]
        else { return [] }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    static func removeAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func set<T: Encodable>(_ value: T, for key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        set(data, for: key)
    }

    static func value<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let data = data(for: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

/// Where Cloud sign-in keeps its credential and instance sessions.
protocol SecretStore: Sendable {
    func data(for key: String) -> Data?
    func set(_ data: Data, for key: String)
    func remove(_ key: String)
    func removeAll()
    func keys() -> [String]
}

extension SecretStore {
    func set<T: Encodable>(_ value: T, for key: String) {
        if let data = try? JSONEncoder().encode(value) { set(data, for: key) }
    }

    func value<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        data(for: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}

/// The app's Keychain.
struct KeychainStore: SecretStore {
    func data(for key: String) -> Data? { Keychain.data(for: key) }
    func set(_ data: Data, for key: String) { Keychain.set(data, for: key) }
    func remove(_ key: String) { Keychain.remove(key) }
    func removeAll() { Keychain.removeAll() }
    func keys() -> [String] { Keychain.keys() }
}

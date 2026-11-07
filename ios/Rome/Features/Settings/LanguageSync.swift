import Foundation

/// Tells the instance when the guardian switched the app's language, so what
/// the server writes (push bodies, notices) follows it. Like the dashboard,
/// it writes only on a change, never on a first sight: a first run or a new
/// instance only remembers the language, so it never overwrites a choice
/// made on another device.
@MainActor
final class LanguageSync {
    private let defaults: UserDefaults
    private var writing = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The server's code for the app's language, as the dashboard names it.
    nonisolated static func code(_ localization: String?) -> String {
        guard let localization, localization.hasPrefix("zh") else { return "en" }
        return "zh-CN"
    }

    nonisolated static func key(host: String) -> String { "guardianLanguage.\(host)" }

    /// Compares the app's language with the last one seen on this instance,
    /// and writes it when it changed. A failed write is tried again next time.
    func check(host: String, current: String, isGuardian: () async -> Bool, write: (String) async throws -> Void) async {
        let key = Self.key(host: host)
        guard let seen = defaults.string(forKey: key) else {
            defaults.set(current, forKey: key)
            return
        }
        guard seen != current, !writing else { return }
        writing = true
        defer { writing = false }
        // The setting is the guardian's: a visitor's phone leaves it alone.
        guard await isGuardian() else { return }
        do {
            try await write(current)
            defaults.set(current, forKey: key)
        } catch {
            // Remembered as it was, so the next foreground tries again.
        }
    }
}

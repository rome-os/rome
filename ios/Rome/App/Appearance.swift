import Observation
import SwiftUI
import UIKit

/// Light, dark, or the system's choice: one setting for the whole app, kept
/// on this phone across sign-out, apart from the web dashboard's.
enum Appearance: String, CaseIterable, Identifiable, Sendable {
    case automatic, light, dark

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .automatic: return "Automatic"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var style: UIUserInterfaceStyle {
        switch self {
        case .automatic: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// Holds the setting and applies it to every window of the app, so sheets,
/// menus and system pickers follow it too, at once.
@MainActor
@Observable
final class AppearanceSetting {
    static let key = "appearance"

    private(set) var current: Appearance
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        current = defaults.string(forKey: Self.key).flatMap(Appearance.init(rawValue:)) ?? .automatic
    }

    func set(_ appearance: Appearance) {
        current = appearance
        defaults.set(appearance.rawValue, forKey: Self.key)
        apply()
    }

    /// Sets the style on every window of every scene.
    func apply() {
        #if DEBUG
        // Snapshot runs pick light and dark themselves.
        if SnapshotRunner.directory != nil { return }
        #endif
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows { window.overrideUserInterfaceStyle = current.style }
        }
    }
}

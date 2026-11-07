import Foundation
import SwiftUI

/// What the phone needs to know about the instance's apps, kept apart from
/// the screens so it can be tested.
enum AppLinks {
    /// Apps that only carry skills, never a destination (as on the web).
    static let carriers: Set<String> = ["user-skills"]

    /// The apps the guardian made or installed: not the ones that ship with
    /// Rome, not those that opt out of the launcher. The web splits them the same way.
    static func mine(_ apps: [InstalledApp]) -> [InstalledApp] {
        apps.filter { app in
            guard let origin = app.origin, origin != "builtin" else { return false }
            return app.hideInLauncher != true && !carriers.contains(app.id)
        }
    }

    /// The app's full-screen page on the instance: its `fullHref`, or
    /// `/full/apps/<id>` built the way the server builds it.
    static func fullURL(origin: URL, app: InstalledApp) -> URL? {
        let path: String
        if let href = app.fullHref, href.hasPrefix("/") {
            path = href
        } else {
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            guard let segment = app.id.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
            path = "/full/apps/\(segment)"
        }
        return URL(string: APIClient.originString(origin) + path)
    }

    /// Whether a link stays in the app's web view: only the instance's own
    /// origin, which alone gets the session cookie. Anything else opens in Safari.
    static func staysInApp(_ url: URL, origin: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "about", "blob", "data": return true
        case "http", "https":
            func port(_ url: URL) -> Int? { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }
            return url.scheme?.lowercased() == origin.scheme?.lowercased()
                && url.host()?.lowercased() == origin.host()?.lowercased()
                && port(url) == port(origin)
        default: return false
        }
    }
}

/// An app the guardian can ask Chat to make, as a ready prompt.
enum AppIdea: CaseIterable, Identifiable {
    /// A blank start: the guardian writes the idea.
    case own
    case habitTracker, packingList, readingLog

    var id: Self { self }

    var title: LocalizedStringKey {
        switch self {
        case .own: return "Your own idea…"
        case .habitTracker: return "A habit tracker"
        case .packingList: return "A trip packing list"
        case .readingLog: return "A reading log"
        }
    }

    /// What goes into Chat's composer, unsent, for the guardian to edit.
    var prompt: String {
        switch self {
        case .own: return String(localized: "Make an app: ")
        case .habitTracker: return String(localized: "Make me an app: a habit tracker")
        case .packingList: return String(localized: "Make me an app: a trip packing list")
        case .readingLog: return String(localized: "Make me an app: a reading log")
        }
    }
}

/// A starting prompt put into a composer that may already hold a draft.
enum ComposerPrefill {
    /// The draft stays and the prompt goes after it on a new line; an empty
    /// draft gives way to the prompt. A draft already ending with the prompt,
    /// as after a second tap, stays as it is.
    static func merged(draft: String, prompt: String) -> String {
        let kept = draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        if kept.isEmpty { return prompt }
        let wanted = prompt.trimmingCharacters(in: .whitespaces)
        if kept.hasSuffix(wanted) { return draft }
        return kept + "\n" + prompt
    }
}

/// The letter tile of an app with no icon.
enum AppTile {
    /// The tile's color in `Palette.appTiles`, the same for a name on every
    /// launch and every phone: Swift's own hash changes per launch.
    static func colorIndex(for name: String, count: Int = Palette.appTiles.count) -> Int {
        var hash: UInt32 = 2_166_136_261
        for scalar in name.lowercased().unicodeScalars {
            hash = (hash ^ scalar.value) &* 16_777_619
        }
        return Int(hash % UInt32(count))
    }
}

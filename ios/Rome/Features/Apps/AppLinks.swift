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
    case habitTracker, packingList, readingLog

    var id: Self { self }

    var title: LocalizedStringKey {
        switch self {
        case .habitTracker: return "A habit tracker"
        case .packingList: return "A trip packing list"
        case .readingLog: return "A reading log"
        }
    }

    /// What goes to Chat, as a starter's text does.
    var prompt: String {
        switch self {
        case .habitTracker: return String(localized: "Make me an app: a habit tracker")
        case .packingList: return String(localized: "Make me an app: a trip packing list")
        case .readingLog: return String(localized: "Make me an app: a reading log")
        }
    }
}

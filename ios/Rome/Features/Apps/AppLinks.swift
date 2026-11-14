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

    /// Where a link in chat text goes.
    enum ChatLink: Equatable {
        /// One of the instance's apps, full screen. `page` is the link on the
        /// instance, for when the app cannot be found.
        case app(id: String, page: URL?)
        /// A page of the instance, in the in-app web view with the session.
        case page(URL)
        /// Another site: Safari.
        case external
        /// `mailto:`, `tel:` and the like: the system.
        case system
    }

    /// Classifies a link the Concierge wrote. A relative link, as Markdown
    /// gives `/apps/<id>`, is on the instance. `/apps/<id>`, `/full/apps/<id>`
    /// and an app's own `fullHref` name that app.
    static func chatLink(_ url: URL, origin: URL?, apps: [InstalledApp]) -> ChatLink {
        let page: URL?
        let path: String
        switch url.scheme?.lowercased() {
        case nil:
            page = origin.flatMap { URL(string: url.relativeString, relativeTo: $0)?.absoluteURL }
            path = URLComponents(string: url.relativeString)?.path ?? url.relativeString
        case "http", "https":
            guard let origin, staysInApp(url, origin: origin) else { return .external }
            page = url
            path = url.path(percentEncoded: true)
        default:
            return .system
        }
        if let id = appId(path: path, apps: apps) { return .app(id: id, page: page) }
        return page.map(ChatLink.page) ?? .system
    }

    /// The app a path on the instance opens, if any.
    private static func appId(path: String, apps: [InstalledApp]) -> String? {
        let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        if let app = apps.first(where: { $0.fullHref.map { $0 == trimmed || $0 == path } ?? false }) { return app.id }
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        let segment: String?
        switch parts.count {
        case 2 where parts[0] == "apps": segment = parts[1]
        case 3 where parts[0] == "full" && parts[1] == "apps": segment = parts[2]
        default: segment = nil
        }
        guard let segment, !segment.isEmpty, let id = segment.removingPercentEncoding, !id.isEmpty else { return nil }
        return id
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
        case .habitTracker: return "Habit tracker"
        case .packingList: return "Trip packing list"
        case .readingLog: return "Reading log"
        }
    }

    /// One line on what the idea is, under its title in the New app sheet.
    var detail: LocalizedStringKey {
        switch self {
        case .own: return ""
        case .habitTracker: return "Check off habits every day"
        case .packingList: return "Never forget the charger again"
        case .readingLog: return "Books, pages and notes"
        }
    }

    var systemImage: String {
        switch self {
        case .own: return "plus"
        case .habitTracker: return "checkmark.circle"
        case .packingList: return "suitcase"
        case .readingLog: return "book"
        }
    }

    /// The ideas a sheet lists, without the blank start.
    static var ideas: [AppIdea] { allCases.filter { $0 != .own } }

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

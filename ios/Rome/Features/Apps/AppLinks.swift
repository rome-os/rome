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
        /// One of the instance's apps, in its sheet. `page` is the link on the
        /// instance, for when the app cannot be found; `start`, the app's own
        /// page the link names, when it names one past the app's first.
        case app(id: String, page: URL?, start: URL? = nil)
        /// A chat by its server id: the main Chat, a topic chat or a task
        /// chat. `page` is the link on the instance, for a chat the app does
        /// not open.
        case chat(id: String, page: URL?)
        /// A file of the instance, opened on the phone.
        case file(LinkedFile)
        /// A file on the instance's disk that no route serves.
        case unopenableFile
        /// A page of the instance, in the in-app web view with the session.
        case page(URL)
        /// Another site: Safari.
        case external
        /// `mailto:`, `tel:` and the like: the system.
        case system
    }

    /// Classifies a link the Concierge wrote. A relative link, as Markdown
    /// gives `/apps/<id>`, is on the instance. `/apps/<id>`, `/full/apps/<id>`
    /// and an app's own `fullHref` name that app, and anything after the id
    /// names a page of it. `/chat/<id>` names a chat. `/projects/…` and
    /// `/memory/…` files and `/api/assets/…` are files to download. A path on
    /// the instance's disk, absolute or `file://`, is the project or memory
    /// file it names, else a file the phone cannot open.
    static func chatLink(_ url: URL, origin: URL?, apps: [InstalledApp]) -> ChatLink {
        let page: URL?
        let path: String
        let tail: String
        switch url.scheme?.lowercased() {
        case nil:
            let components = URLComponents(string: url.relativeString)
            page = origin.flatMap { URL(string: url.relativeString, relativeTo: $0)?.absoluteURL }
            path = components?.percentEncodedPath ?? url.relativeString
            tail = (components?.percentEncodedQuery.map { "?" + $0 } ?? "") + (components?.percentEncodedFragment.map { "#" + $0 } ?? "")
        case "http", "https":
            guard let origin, staysInApp(url, origin: origin) else { return .external }
            page = url
            path = url.path(percentEncoded: true)
            tail = (url.query(percentEncoded: true).map { "?" + $0 } ?? "") + (url.fragment(percentEncoded: true).map { "#" + $0 } ?? "")
        case "file":
            return diskFile(url.path(percentEncoded: false), origin: origin).map(ChatLink.file) ?? .unopenableFile
        default:
            return .system
        }
        if let named = app(path: path, apps: apps) {
            let (id, rest) = named
            let start = rest.isEmpty ? nil : origin.flatMap { origin in
                id.addingPercentEncoding(withAllowedCharacters: segmentAllowed).flatMap {
                    URL(string: APIClient.originString(origin) + "/full/apps/\($0)/" + rest + tail)
                }
            }
            return .app(id: id, page: page, start: start)
        }
        let decoded = path.removingPercentEncoding ?? path
        let parts = decoded.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        if parts.count == 2, parts[0] == "chat", !parts[1].isEmpty {
            return .chat(id: parts[1], page: page)
        }
        if let file = routeFile(decoded, origin: origin) ?? diskFile(decoded, origin: origin) { return .file(file) }
        if let first = parts.first, diskRoots.contains(first) { return .unopenableFile }
        return page.map(ChatLink.page) ?? .system
    }

    private static let segmentAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    /// The first folder of a path that is on a disk, never a page of the
    /// dashboard: a link under one that names no project or memory file
    /// cannot be opened.
    private static let diskRoots: Set<String> = [
        "Users", "home", "root", "tmp", "private", "var", "opt", "mnt", "srv", "Volumes", "workspace", "etc", "usr",
    ]

    /// The app a path on the instance opens, if any, and the rest of the path
    /// after its id, percent-encoded: a page of the app.
    private static func app(path: String, apps: [InstalledApp]) -> (String, String)? {
        let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        if let app = apps.first(where: { $0.fullHref.map { $0 == trimmed || $0 == path } ?? false }) { return (app.id, "") }
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        let at: Int
        if parts.count >= 2, parts[0] == "apps" {
            at = 1
        } else if parts.count >= 3, parts[0] == "full", parts[1] == "apps" {
            at = 2
        } else {
            return nil
        }
        guard let id = parts[at].removingPercentEncoding, !id.isEmpty else { return nil }
        return (id, parts[(at + 1)...].joined(separator: "/"))
    }

    /// A file a route of the instance serves: a path under `/projects/` or
    /// `/memory/`, which `/resolve` later tells from a folder, and
    /// `/api/assets/<file>`. `path` is percent-decoded.
    private static func routeFile(_ path: String, origin: URL?) -> LinkedFile? {
        for folder in ["projects", "memory"] where path.hasPrefix("/\(folder)/") {
            let logical = String(path.dropFirst()).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard logical.count > folder.count else { return nil }
            let name = (logical as NSString).lastPathComponent
            let encoded = logical.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? logical
            return LinkedFile(
                apiPath: "/\(folder)/download",
                query: "path=" + APIClient.strictQueryValue(logical),
                name: name,
                logicalPath: logical,
                page: origin.flatMap { URL(string: APIClient.originString($0) + "/" + encoded) }
            )
        }
        let name = (path as NSString).lastPathComponent
        if path.hasPrefix("/api/assets/"), !path.dropFirst("/api/assets/".count).contains("/"),
           name.range(of: #"\.[A-Za-z0-9]{1,8}$"#, options: .regularExpression) != nil {
            guard let encoded = name.addingPercentEncoding(withAllowedCharacters: segmentAllowed) else { return nil }
            return LinkedFile(apiPath: "/assets/" + encoded, query: nil, name: name)
        }
        return nil
    }

    /// The project or memory path a path on the instance's disk names: one in
    /// `.rome/<profile>/projects/` or `.rome/<profile>/memory/`, where an
    /// instance keeps them unless it was set up with other folders.
    private static func diskFile(_ path: String, origin: URL?) -> LinkedFile? {
        let parts = path.split(separator: "/").map(String.init)
        guard let rome = parts.firstIndex(of: ".rome"), rome + 3 < parts.count,
              ["projects", "memory"].contains(parts[rome + 2]) else { return nil }
        return routeFile("/" + parts[(rome + 2)...].joined(separator: "/"), origin: origin)
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

/// A file a chat links to, downloaded with the session.
struct LinkedFile: Hashable, Sendable {
    /// The path after `/api` that serves it.
    let apiPath: String
    /// The request's query, percent-encoded.
    let query: String?
    /// Its file name, as Quick Look and the share sheet show it.
    let name: String
    /// A project or memory path, `projects/…` or `memory/…`, which may name
    /// a folder: `/<its folder>/resolve` says which before it is downloaded.
    var logicalPath: String? = nil
    /// The dashboard's page for it, which a folder opens.
    var page: URL? = nil
    /// What it previews as, when the server said; else its name says.
    var kind: FileKind? = nil

    var previewKind: FileKind { kind ?? FileKind(name: name) }
}

/// What a linked project or memory path names on the instance.
enum LinkedFileKind: Sendable {
    case file, folder, missing
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

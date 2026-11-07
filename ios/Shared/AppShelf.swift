import Foundation
import SwiftUI

// Shared by the app and its widget: the open instance's apps as the app last
// loaded them, kept in the App Group container. The widget only reads this
// copy; it never calls the network or holds the session.

/// One app as the widget shows it.
struct ShelfApp: Codable, Equatable, Hashable, Sendable, Identifiable {
    let id: String
    let name: String
    /// Running with a page: a tap opens it.
    let opens: Bool
    /// The app has an icon file beside the list.
    let hasIcon: Bool
}

/// The open instance's apps, in the Apps page's order.
struct Shelf: Codable, Equatable, Sendable {
    let instanceId: String
    let apps: [ShelfApp]
}

/// The App Group container: the list, the icons and the recently opened apps.
struct AppShelfStore: Sendable {
    let root: URL
    /// The group's defaults suite: `UserDefaults` itself is not `Sendable`.
    let suite: String

    private var defaults: UserDefaults { UserDefaults(suiteName: suite) ?? .standard }

    /// The group named in the bundle's `RomeAppGroup` key, or nil where the
    /// build has none (Mac Catalyst, tests).
    static var shared: AppShelfStore? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "RomeAppGroup") as? String, !group.isEmpty,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        return AppShelfStore(root: root.appending(path: "Shelf", directoryHint: .isDirectory), suite: group)
    }

    /// The widget's kind, for reloading its timeline.
    static let widgetKind = "cc.romeos.apps"

    /// Opens kept per instance, newest first.
    static let recentLimit = 16
    static let iconPixels: CGFloat = 120

    private var listURL: URL { root.appending(path: "apps.json") }
    private var iconsURL: URL { root.appending(path: "icons", directoryHint: .isDirectory) }

    func read() -> Shelf? {
        guard let data = try? Data(contentsOf: listURL) else { return nil }
        return try? JSONDecoder().decode(Shelf.self, from: data)
    }

    /// Writes the list; true when it changed. Icons of another instance go.
    @discardableResult
    func write(_ shelf: Shelf) -> Bool {
        let old = read()
        guard old != shelf else { return false }
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if old?.instanceId != shelf.instanceId { try? FileManager.default.removeItem(at: iconsURL) }
        if let data = try? JSONEncoder().encode(shelf) { try? data.write(to: listURL, options: .atomic) }
        return true
    }

    /// Signed out: the widget shows its empty state.
    func clear() {
        try? FileManager.default.removeItem(at: root)
    }

    func iconURL(_ appId: String) -> URL {
        iconsURL.appending(path: "\(Self.fileName(appId)).png")
    }

    /// Keeps an icon, made small enough for a widget. True when it changed.
    @discardableResult
    func writeIcon(_ data: Data, for appId: String) -> Bool {
        guard let png = Self.smallPNG(data) else { return false }
        let url = iconURL(appId)
        if (try? Data(contentsOf: url)) == png { return false }
        try? FileManager.default.createDirectory(at: iconsURL, withIntermediateDirectories: true)
        try? png.write(to: url, options: .atomic)
        return true
    }

    func recent(instanceId: String) -> [String] {
        defaults.stringArray(forKey: Self.recentKey(instanceId)) ?? []
    }

    func recordOpen(instanceId: String, appId: String) {
        let list = [appId] + recent(instanceId: instanceId).filter { $0 != appId }
        defaults.set(Array(list.prefix(Self.recentLimit)), forKey: Self.recentKey(instanceId))
    }

    private static func recentKey(_ instanceId: String) -> String { "recentApps.\(instanceId)" }

    private static func fileName(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "_"
    }

    private static func smallPNG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let side = iconPixels
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }.pngData()
    }
}

/// Which apps fill the widget's slots.
enum WidgetSlots {
    static let medium = 8

    /// The apps the guardian picked, in their order, then the ones opened
    /// last, then the rest of the list: each once, only apps the list still
    /// has, at most `limit`.
    static func choose(picked: [String], recent: [String], apps: [ShelfApp], limit: Int = medium) -> [ShelfApp] {
        let byId = Dictionary(apps.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var chosen: [ShelfApp] = []
        for id in picked + recent + apps.map(\.id) where chosen.count < limit {
            guard let app = byId[id], seen.insert(id).inserted else { continue }
            chosen.append(app)
        }
        return chosen
    }
}

/// What a tap on the widget opens.
enum WidgetLink: Equatable, Sendable {
    /// One app full screen, on its instance.
    case app(instanceId: String, appId: String)
    /// The Apps page.
    case apps
    /// Chat with "Make an app: " in the composer, unsent.
    case newApp

    /// `rome` for Release, `rome-dev` for Debug: each build on one phone gets its own links.
    static let schemes: Set<String> = ["rome", "rome-dev"]

    init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(), Self.schemes.contains(scheme) else { return nil }
        // Split before decoding, so an id holding an encoded slash stays one part.
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
            .map { $0.removingPercentEncoding ?? String($0) }
        switch url.host {
        case "app":
            guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
            self = .app(instanceId: parts[0], appId: parts[1])
        case "apps" where parts.allSatisfy(\.isEmpty):
            self = .apps
        case "new-app" where parts.allSatisfy(\.isEmpty):
            self = .newApp
        default:
            return nil
        }
    }

    func url(scheme: String) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        switch self {
        case .app(let instanceId, let appId):
            components.host = "app"
            components.percentEncodedPath = "/" + [instanceId, appId].map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? $0 }.joined(separator: "/")
        case .apps:
            components.host = "apps"
        case .newApp:
            components.host = "new-app"
        }
        return components.url!
    }
}

/// The letter tile of an app with no icon.
enum AppTile {
    /// One per app by its name; white letters read on each, light and dark.
    static let colors: [Color] = [
        dynamic(0xD86F4C, 0xC4603F), // ember
        dynamic(0x2E8F84, 0x2A8075), // teal
        dynamic(0x3B74C9, 0x3768B5), // blue
        dynamic(0x8460C8, 0x7655B4), // violet
        dynamic(0x4E8B47, 0x467D40), // green
        dynamic(0xC9506F, 0xB44864), // rose
    ]

    /// The tile's color in `colors`, the same for a name on every launch and
    /// every phone: Swift's own hash changes per launch.
    static func colorIndex(for name: String, count: Int = colors.count) -> Int {
        var hash: UInt32 = 2_166_136_261
        for scalar in name.lowercased().unicodeScalars {
            hash = (hash ^ scalar.value) &* 16_777_619
        }
        return Int(hash % UInt32(count))
    }

    static func color(for name: String) -> Color { colors[colorIndex(for: name)] }

    /// The tile's letter: the name's first character, upper-cased.
    static func letter(for name: String) -> String { String(name.prefix(1)).uppercased() }

    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

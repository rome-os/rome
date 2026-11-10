import SwiftUI
import UIKit

/// Opens a page of the open instance in the app's web view, signed in with
/// the app's session, so the guardian never has to sign in to the dashboard
/// in Safari. The main stack sets it; outside it, the page opens in Safari.
struct OpenInstancePageAction {
    let handler: @MainActor (URL) -> Void

    @MainActor func callAsFunction(_ url: URL) { handler(url) }
}

extension EnvironmentValues {
    @Entry var openInstancePage = OpenInstancePageAction { url in UIApplication.shared.open(url) }
}

/// The dashboard pages the app links to.
enum InstancePages {
    /// A chat's page: `/chat/<id>` for a topic or task chat. The main chat,
    /// a visitor's too, is `/message`: the dashboard opens the signed-in
    /// person's main chat there (every supported release has the route),
    /// while `/chat` starts a new chat.
    static func chat(origin: URL, sessionId: String?, mainChatServerID: String? = nil) -> URL {
        guard let sessionId, !sessionId.isEmpty else { return origin }
        if sessionId == conciergeChatID || sessionId == mainChatServerID { return origin.appending(path: "message") }
        return origin.appending(path: "chat").appending(path: sessionId)
    }

    /// Settings → Connections.
    static func connections(origin: URL) -> URL {
        origin.appending(path: String(ConnectRunner.settingsConnectionsPath.dropFirst()))
    }

    /// A routine's page, or the Routines list when there is no routine yet.
    static func routines(origin: URL, routineId: String? = nil) -> URL {
        let list = origin.appending(path: "routines")
        return routineId.map { list.appending(path: $0) } ?? list
    }

    /// `RomeiOS/<version>` at the end of the web view's user agent, after
    /// WebKit's own application name. The dashboard reads it to tell its page
    /// in this app from a browser, and counts only a browser as a guardian
    /// at the dashboard.
    static func applicationName(webKitDefault: String?, version: String?) -> String {
        let rome = "RomeiOS/\(version ?? "0")"
        guard let webKitDefault, !webKitDefault.isEmpty else { return rome }
        return "\(webKitDefault) \(rome)"
    }
}

import Foundation

/// Debug builds only: the Cloudflare Access service token that lets the app
/// reach Rome's test hosts (`*.romeos.dev`), which sit behind Access. The two
/// values come from `Config/Local.xcconfig` (`CF_ACCESS_CLIENT_ID`,
/// `CF_ACCESS_CLIENT_SECRET`) through `Info-Debug.plist`; a Release build has
/// neither and sends nothing.
enum DevAccess {
    static func stamp(_ request: inout URLRequest) {
        #if DEBUG
        guard let host = request.url?.host()?.lowercased(),
              host == "romeos.dev" || host.hasSuffix(".romeos.dev"),
              let id = value("CFAccessClientId"), let secret = value("CFAccessClientSecret")
        else { return }
        request.setValue(id, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(secret, forHTTPHeaderField: "CF-Access-Client-Secret")
        #endif
    }

    private static func value(_ key: String) -> String? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: key) as? String, !text.isEmpty else { return nil }
        return text
    }
}

import Foundation

/// A card an app described as data: a `widget` message part with `ui`. The
/// shape is the A2UI v0.9 subset `checkWidgetUi` in `@rome-os/app-runtime`
/// accepts; Google's A2UI engine reads it (`WidgetUICardView`), as the
/// dashboard's does, so both draw the same card.
struct WidgetUIPart: Hashable, Sendable {
    let toolUseId: String
    /// The widget's id: the id of the message that holds it, since a widget
    /// is a message of its own. Set by whoever reads the message; its events
    /// go to core by it.
    var widgetId = ""
    let appId: String
    /// The widget's line, for when the card cannot be drawn or read.
    let text: String
    /// The card's components, as stored.
    let components: [JSONValue]
    /// JSON Pointer in the card's data model → GET path in the app's API.
    let bind: [String: String]

    /// The data model the card starts from.
    let data: JSONValue
    /// Whether the agent waits on the card. Core decides what its events mean;
    /// the card only sends them.
    let waits: Bool

    /// A `widget` part with `ui`.
    init?(json value: JSONValue) {
        self.init(toolUseId: value["toolUseId"]?.string, appId: value["appId"]?.string, ui: value["ui"], text: value["text"]?.string, bind: value["bind"], waits: false)
    }

    /// A card the agent waits on, described as data: a `pending_interaction`
    /// part whose `render.ui` is set.
    init?(interaction value: JSONValue) {
        self.init(toolUseId: value["toolUseId"]?.string, appId: value["appId"]?.string, ui: value["render"]?["ui"], text: value["text"]?.string, bind: value["render"]?["bind"], waits: true)
    }

    private init?(toolUseId: String?, appId: String?, ui: JSONValue?, text: String?, bind: JSONValue?, waits: Bool) {
        guard let toolUseId, let appId, let components = ui?["components"]?.array,
              components.contains(where: { $0["id"]?.string == "root" }) else { return nil }
        self.toolUseId = toolUseId
        self.appId = appId
        self.text = text ?? ""
        self.components = components
        self.bind = (bind?.object ?? [:]).compactMapValues(\.string)
        self.data = ui?["data"] ?? .object([:])
        self.waits = waits
    }

    /// Whether this app may draw the card and call the app with it. A stored
    /// part is read back as data, so the reader checks its paths again with
    /// the rule core used before storing it.
    var isDrawable: Bool {
        guard WidgetPaths.appAPIPath(appId: appId, path: "x") != nil else { return false }
        let posts = components.compactMap { $0["action"]?["event"]?["name"]?.string }
            // A card stored before its events were its own names them `rome:…`.
            .filter { !(waits && $0.hasPrefix("rome:")) }
        return (Array(bind.values) + posts).allSatisfy(WidgetPaths.isAppPath)
    }
}

/// The paths a card reads and writes, and the images it loads.
/// What core said to an event a widget fired: whether it answered the agent
/// waiting on the widget, and a link the reply asks the client to open.
struct WidgetEventReply: Sendable, Equatable {
    var answered = false
    var open: URL? = nil

    init(answered: Bool = false, open: URL? = nil) {
        self.answered = answered
        self.open = open
    }

    /// Read from core's JSON reply. Core vets the link; a web link opens as given.
    init(json: JSONValue) {
        answered = json["answered"]?.bool == true
        open = json["open"]?.string.flatMap(URL.init(string:)).flatMap { url in
            ["https", "http"].contains(url.scheme?.lowercased() ?? "") ? url : nil
        }
    }
}

enum WidgetPaths {
    /// Rome's own strings a card names with `{ string }`: the question card's labels.
    static func hostString(_ name: String) -> String {
        switch name {
        case "send": String(localized: "Send")
        case "dismiss": String(localized: "Dismiss")
        case "typeOwn": String(localized: "Or type your own…")
        case "addOwn": String(localized: "Add your own…")
        case "typeAnswer": String(localized: "Type your answer…")
        case "optional": String(localized: "optional")
        default: ""
        }
    }

    /// An app API path a card may use, such as `days/2026-11-11`:
    /// `/`-separated segments of letters, digits and `-_.~`, none of them `.`
    /// or `..`. Anything else, such as `%2e%2e` or a backslash, could resolve
    /// outside the app once the URL is normalized.
    static func isAppPath(_ path: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { segment in
            !segment.isEmpty && segment != "." && segment != ".."
                && segment.unicodeScalars.allSatisfy(allowed.contains)
        }
    }

    /// `/api/apps/<appId>/<path>`, with the app id as one path segment: a
    /// Store app's id such as `@alice/meals` holds a `/`.
    static func appAPIPath(appId: String, path: String) -> String? {
        guard isAppPath(path), !appId.isEmpty, appId != ".", appId != "..",
              let app = appId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))
        else { return nil }
        return "/api/apps/\(app)/\(path)"
    }

    /// An image URL a card may load: `https:` only, so it never reads the
    /// instance, and loads the same as on the dashboard.
    static func httpsURL(_ text: String) -> URL? {
        guard text.hasPrefix("https://"), let url = URL(string: text), url.host() != nil else { return nil }
        return url
    }
}

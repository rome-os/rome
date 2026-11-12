import Foundation

/// A card an app described as data: a `widget` message part with `ui`. The
/// shape is the A2UI v0.9 subset `checkWidgetUi` in `@rome-os/app-runtime`
/// accepts, so this app draws exactly what the dashboard draws. Components
/// name their children by id, values are literals or `{ path }` JSON Pointers
/// into a data model, and the data model is filled from the app's own API.
struct WidgetUIPart: Hashable, Sendable {
    let toolUseId: String
    let appId: String
    /// The widget's line, for when the card's data cannot be read.
    let text: String
    let components: [String: WidgetComponent]
    /// JSON Pointer in the data model → GET path in the app's API.
    let bind: [String: String]
    /// The data model the card starts from.
    let data: JSONValue

    /// A `widget` part with `ui`.
    init?(json value: JSONValue) {
        self.init(toolUseId: value["toolUseId"]?.string, appId: value["appId"]?.string, ui: value["ui"], text: value["text"]?.string, bind: value["bind"])
    }

    /// A card the agent waits on, described as data: a `pending_interaction`
    /// part whose `render.ui` is set.
    init?(interaction value: JSONValue) {
        self.init(toolUseId: value["toolUseId"]?.string, appId: value["appId"]?.string, ui: value["render"]?["ui"], text: nil, bind: nil)
    }

    private init?(toolUseId: String?, appId: String?, ui: JSONValue?, text: String?, bind: JSONValue?) {
        guard let toolUseId, let appId, let list = ui?["components"]?.array else { return nil }
        var components: [String: WidgetComponent] = [:]
        for item in list {
            guard let id = item["id"]?.string, let kind = item["component"]?.string else { continue }
            components[id] = WidgetComponent(id: id, kind: WidgetComponent.Kind(rawValue: kind) ?? .unknown, props: item)
        }
        guard components["root"] != nil else { return nil }
        self.toolUseId = toolUseId
        self.appId = appId
        self.text = text ?? ""
        self.components = components
        self.bind = (bind?.object ?? [:]).compactMapValues(\.string)
        self.data = ui?["data"] ?? .object([:])
    }
}

struct WidgetComponent: Hashable, Sendable {
    /// Rome's catalog. A kind this build does not know draws nothing.
    enum Kind: String, Sendable {
        case text = "Text", stat = "Stat", list = "List", row = "Row", column = "Column"
        case image = "Image", progress = "Progress", button = "Button"
        case choicePicker = "ChoicePicker", textField = "TextField"
        case unknown
    }

    let id: String
    let kind: Kind
    let props: JSONValue

    subscript(key: String) -> JSONValue? { props[key] }

    /// The children to draw, each with the data path its relative paths read
    /// from: fixed ids keep the parent's scope, and a template is drawn once
    /// per element of the array it names.
    func children(in data: JSONValue, scope: String) -> [(id: String, scope: String)] {
        if kind == .button, let child = props["child"]?.string { return [(child, scope)] }
        guard let children = props["children"] else { return [] }
        if let ids = children.array { return ids.compactMap(\.string).map { ($0, scope) } }
        guard let template = children["componentId"]?.string, let path = children["path"]?.string else { return [] }
        let base = WidgetData.absolute(path, scope: scope)
        let count = WidgetData.read(data, pointer: base)?.array?.count ?? 0
        return (0..<min(count, 200)).map { (template, "\(base)/\($0)") }
    }
}

/// Reading a card's data model.
enum WidgetData {
    /// A path inside a `List` item is relative to that item.
    static func absolute(_ path: String, scope: String) -> String {
        if path.hasPrefix("/") { return path }
        return scope.isEmpty ? "/\(path)" : "\(scope)/\(path)"
    }

    /// RFC 6901: `~1` is `/` and `~0` is `~`; an array step is an index.
    static func read(_ root: JSONValue, pointer: String) -> JSONValue? {
        guard pointer != "/" && !pointer.isEmpty else { return root }
        var value: JSONValue? = root
        for raw in pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst() {
            let key = raw.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
            if let array = value?.array {
                guard let index = Int(key), array.indices.contains(index) else { return nil }
                value = array[index]
            } else {
                value = value?[key]
            }
        }
        return value
    }

    /// The model with `value` stored at `pointer`, such as `/today` or
    /// `/answers/0/values`. Missing objects on the way are made; a step into
    /// an array past its end leaves the model as it was.
    static func storing(_ value: JSONValue, at pointer: String, in root: JSONValue) -> JSONValue {
        let keys = pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
            $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        }
        func set(_ node: JSONValue, _ keys: ArraySlice<String>) -> JSONValue {
            guard let key = keys.first else { return value }
            if var array = node.array {
                guard let index = Int(key), array.indices.contains(index) else { return node }
                array[index] = set(array[index], keys.dropFirst())
                return .array(array)
            }
            var object = node.object ?? [:]
            object[key] = set(object[key] ?? .object([:]), keys.dropFirst())
            return .object(object)
        }
        return set(root, ArraySlice(keys))
    }

    /// The model after an input writes `value` at `pointer`. A non-empty write
    /// also empties the input's `clears` target (Rome's: an empty list where
    /// the input writes text, an empty string where it writes a list), so the
    /// last of two inputs edited wins.
    static func editing(_ value: JSONValue, at pointer: String, clears: JSONValue?, scope: String, in root: JSONValue) -> JSONValue {
        let next = storing(value, at: pointer, in: root)
        let written: Bool
        switch value {
        case .string(let text): written = !text.isEmpty
        case .array(let list): written = !list.isEmpty
        default: written = false
        }
        guard written, let target = clears?["path"]?.string else { return next }
        let empty: JSONValue = value.array == nil ? .array([]) : .string("")
        return storing(empty, at: absolute(target, scope: scope), in: next)
    }

    /// Whether a check's condition holds: `required` is a non-empty string or
    /// list, `or` any of its values. Any other function fails, which the
    /// server never lets through.
    static func passes(_ condition: JSONValue?, in root: JSONValue, scope: String) -> Bool {
        switch condition?["call"]?.string {
        case "required":
            switch resolve(condition?["args"]?["value"], in: root, scope: scope) {
            case .string(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .array(let list): return !list.isEmpty
            default: return false
            }
        case "or":
            return (condition?["args"]?["values"]?.array ?? []).contains { passes($0, in: root, scope: scope) }
        default:
            return false
        }
    }

    /// Rome's own strings a card names with `{ string }`: the question card's labels.
    static func hostString(_ name: String) -> String {
        switch name {
        case "send": return String(localized: "Send")
        case "dismiss": return String(localized: "Dismiss")
        case "typeOwn": return String(localized: "Or type your own…")
        case "addOwn": return String(localized: "Add your own…")
        case "typeAnswer": return String(localized: "Type your answer…")
        case "optional": return String(localized: "optional")
        default: return ""
        }
    }

    /// A literal, or the value its `{ path }` names.
    static func resolve(_ value: JSONValue?, in root: JSONValue, scope: String) -> JSONValue? {
        guard let value else { return nil }
        if let path = value["path"]?.string, value.object?.count == 1 {
            return read(root, pointer: absolute(path, scope: scope))
        }
        return value
    }

    static func text(_ value: JSONValue?, in root: JSONValue, scope: String) -> String {
        if let name = value?["string"]?.string, value?.object?.count == 1 { return hostString(name) }
        switch resolve(value, in: root, scope: scope) {
        case .string(let text): return text
        case .number(let number):
            return number.rounded() == number && abs(number) < 1e15
                ? Int(number).formatted() : number.formatted()
        case .bool(let flag): return flag ? "true" : "false"
        case .some(let other) where other != .null: return other.prettyText
        default: return ""
        }
    }

    static func number(_ value: JSONValue?, in root: JSONValue, scope: String) -> Double? {
        resolve(value, in: root, scope: scope)?.number
    }

    /// `/api/apps/<appId>/<path>`, with the app id as one path segment: a
    /// Store app's id such as `@alice/meals` holds a `/`.
    static func appAPIPath(appId: String, path: String) -> String? {
        guard isAppPath(path),
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

    /// A button's context with its paths read, as the POST body.
    static func context(_ value: JSONValue?, in root: JSONValue, scope: String) -> JSONValue {
        guard let object = value?.object else { return .object([:]) }
        return .object(object.mapValues { resolve($0, in: root, scope: scope) ?? .null })
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
}

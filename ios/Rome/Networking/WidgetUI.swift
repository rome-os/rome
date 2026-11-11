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

    init?(json value: JSONValue) {
        guard let toolUseId = value["toolUseId"]?.string,
              let appId = value["appId"]?.string,
              let list = value["ui"]?["components"]?.array else { return nil }
        var components: [String: WidgetComponent] = [:]
        for item in list {
            guard let id = item["id"]?.string, let kind = item["component"]?.string else { continue }
            components[id] = WidgetComponent(id: id, kind: WidgetComponent.Kind(rawValue: kind) ?? .unknown, props: item)
        }
        guard components["root"] != nil else { return nil }
        self.toolUseId = toolUseId
        self.appId = appId
        self.text = value["text"]?.string ?? ""
        self.components = components
        self.bind = (value["bind"]?.object ?? [:]).compactMapValues(\.string)
    }
}

struct WidgetComponent: Hashable, Sendable {
    /// Rome's catalog. A kind this build does not know draws nothing.
    enum Kind: String, Sendable {
        case text = "Text", stat = "Stat", list = "List", row = "Row", column = "Column"
        case image = "Image", progress = "Progress", button = "Button"
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

    /// The model with `value` stored at a top-level pointer such as `/today`.
    static func storing(_ value: JSONValue, at pointer: String, in root: JSONValue) -> JSONValue {
        var object = root.object ?? [:]
        let key = String(pointer.dropFirst()).replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        object[key] = value
        return .object(object)
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

    /// A button's context with its paths read, as the POST body.
    static func context(_ value: JSONValue?, in root: JSONValue, scope: String) -> JSONValue {
        guard let object = value?.object else { return .object([:]) }
        return .object(object.mapValues { resolve($0, in: root, scope: scope) ?? .null })
    }

    /// An app API path a card may use: relative, inside the app.
    static func isAppPath(_ path: String) -> Bool {
        !path.isEmpty && !path.hasPrefix("/") && !path.contains("://") && !path.contains("?")
            && !path.contains("#") && !path.split(separator: "/").contains { $0 == ".." || $0 == "." }
    }
}

import A2UICore
import A2UIJSON
import A2UISwiftUI
import BasicCatalog
import JSONSchema
import SwiftUI

/// Rome's A2UI catalog for chat cards, drawn with the app's own `Palette` and
/// `romeFont`. Google's A2UI engine reads the card, resolves its paths and
/// keeps its data, as it does for the dashboard; these views only draw. The
/// components from A2UI's basic catalog keep its schemas; `Stat`,
/// `Progress` and `Markdown` are Rome's.
@MainActor
enum WidgetCatalog {
    /// The id the dashboard's catalog uses too, so a card names one catalog.
    static let id = "https://rome.app/a2ui/catalogs/chat-widget/v1.json"

    static let catalog = Catalog<ComponentImplementation>(
        id: id,
        protocolVersion: .v09,
        components: [text, markdown, stat, progress, image, row, column, list, button, choicePicker, textField],
        // The only functions a card may call, in its `checks`.
        functions: [TrimmedRequired(), OrFunction()]
    )

    private static let text = ComponentImplementation(api: BasicCatalogComponents.text) { node in
        WidgetText(node: node)
    }

    /// Markdown notes, with links drawn as their text and images as their
    /// description, so a card opens and loads nothing.
    private static let markdown = ComponentImplementation(
        name: "Markdown",
        schema: schema(["text": "DynamicString"], required: ["text"])
    ) { node in
        MarkdownText(source: node.string(for: "text") ?? "", fontSize: CardScale.body, lineSpacing: 3, textOnly: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private static let stat = ComponentImplementation(
        name: "Stat",
        schema: schema(["label": "DynamicString", "value": "DynamicValue", "unit": "DynamicString", "caption": "DynamicString"], required: ["label", "value"])
    ) { node in
        WidgetStat(node: node)
    }

    private static let progress = ComponentImplementation(
        name: "Progress",
        schema: schema(["value": "DynamicNumber", "max": "DynamicNumber", "label": "DynamicString"], required: ["value"])
    ) { node in
        WidgetProgress(node: node)
    }

    private static let image = ComponentImplementation(api: BasicCatalogComponents.image) { node in
        WidgetImage(node: node)
    }

    private static let row = ComponentImplementation(api: BasicCatalogComponents.row) { node in
        WidgetRow(node: node)
    }

    private static let column = ComponentImplementation(api: BasicCatalogComponents.column) { node in
        WidgetStack(node: node)
    }

    private static let list = ComponentImplementation(api: BasicCatalogComponents.list) { node in
        WidgetStack(node: node)
    }

    private static let button = ComponentImplementation(api: BasicCatalogComponents.button) { node in
        WidgetButton(node: node)
    }

    // Rome's inputs keep A2UI's names and add what the question card needs:
    // an option's `description` and a field's `placeholder`.
    private static let choicePicker = ComponentImplementation(
        name: "ChoicePicker",
        schema: schema(
            ["label": "DynamicString", "value": "DynamicStringList"],
            raw: [
                "variant": #"{"enum":["multipleSelection","mutuallyExclusive"]}"#,
                "options": #"{"type":"array","items":{"type":"object","properties":{"label":\#(ref("DynamicString")),"value":{"type":"string"},"description":\#(ref("DynamicString"))},"required":["label","value"]}}"#,
            ],
            required: ["options", "value"]
        )
    ) { node in
        WidgetChoicePicker(node: node)
    }

    private static let textField = ComponentImplementation(
        name: "TextField",
        schema: schema(
            ["label": "DynamicString", "value": "DynamicString", "placeholder": "DynamicString"],
            raw: ["variant": #"{"enum":["longText","number","shortText","obscured"]}"#],
            required: ["label"]
        )
    ) { node in
        WidgetTextField(node: node)
    }

    private static func ref(_ type: String) -> String {
        #"{"$ref":"https://a2ui.org/schemas/v0_9_1/common.json#/$defs/\#(type)"}"#
    }

    /// A Rome component's schema: an object whose properties each name one of
    /// A2UI's common types, which tells the engine to resolve a `{ path }` in
    /// that property against the card's data.
    private static func schema(_ properties: KeyValuePairs<String, String>, raw: [String: String] = [:], required: [String]) -> Schema {
        let props = (properties.map { #""\#($0.key)":\#(ref($0.value))"# } + raw.map { #""\#($0.key)":\#($0.value)"# }).joined(separator: ",")
        let names = required.map { #""\#($0)""# }.joined(separator: ",")
        // swiftlint:disable:next force_try
        return try! Schema(
            instance: #"{"type":"object","properties":{\#(props)},"required":[\#(names)]}"#,
            remoteSchemas: A2UICommonSchema.allSchemas
        )
    }

    /// A number grouped as the guardian's locale writes it, or the value as text.
    static func shown(_ node: Node, _ key: String) -> String {
        if let number = node.double(for: key), node.string(for: key).flatMap(Double.init) != nil {
            return number.rounded() == number && abs(number) < 1e15 ? Int(number).formatted() : number.formatted()
        }
        return node.string(for: key) ?? ""
    }
}

/// Whether a component draws inside a button, whose label takes the button's color.
private struct InButtonKey: EnvironmentKey {
    static let defaultValue = false
}

/// Set once a card the agent waits on is answered or dismissed: inputs stop
/// taking input and buttons are hidden.
struct WidgetLockedKey: EnvironmentKey {
    static let defaultValue = false
}

/// Rome's `clears`, by component id: the value an input empties when it is
/// edited, and how to empty it. A2UI's schemas have no such field, so the
/// card hands it here.
struct WidgetClears {
    var targets: [String: String] = [:]
    var clear: @MainActor (_ path: String, _ list: Bool) -> Void = { _, _ in }
}

struct WidgetClearsKey: EnvironmentKey {
    static let defaultValue = WidgetClears()
}

/// Set inside a grid of tiles, so each tile takes its row's height.
private struct WidgetInTileGridKey: EnvironmentKey {
    static let defaultValue = false
}

/// Set while a button's request runs: every button is disabled, so a press is sent once.
struct WidgetBusyKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    fileprivate var widgetInButton: Bool {
        get { self[InButtonKey.self] }
        set { self[InButtonKey.self] = newValue }
    }

    var widgetLocked: Bool {
        get { self[WidgetLockedKey.self] }
        set { self[WidgetLockedKey.self] = newValue }
    }

    var widgetClears: WidgetClears {
        get { self[WidgetClearsKey.self] }
        set { self[WidgetClearsKey.self] = newValue }
    }

    fileprivate var widgetInTileGrid: Bool {
        get { self[WidgetInTileGridKey.self] }
        set { self[WidgetInTileGridKey.self] = newValue }
    }

    var widgetBusy: Bool {
        get { self[WidgetBusyKey.self] }
        set { self[WidgetBusyKey.self] = newValue }
    }
}

private struct WidgetText: View {
    let node: Node
    @Environment(\.widgetInButton) private var inButton

    var body: some View {
        let variant = node.string(for: "variant")
        let (size, weight): (CGFloat, Font.Weight) = switch variant {
        // One type scale, two weights: headings medium, everything else regular.
        case "h1", "h2": (20, .medium)
        case "h3", "h4", "h5": (CardScale.title, .medium)
        case "caption": (CardScale.caption, .regular)
        default: (CardScale.body, .regular)
        }
        let label = Text(verbatim: WidgetCatalog.shown(node, "text"))
            .romeFont(inButton ? CardScale.actionFont : size, inButton ? .medium : weight)
            .fixedSize(horizontal: false, vertical: true)
        if inButton {
            label
        } else {
            label.foregroundStyle(variant == "caption" ? Palette.sub : Palette.fg)
        }
    }
}

/// A tile on a subtle fill: the label above, the value below it with its
/// unit, and an optional caption such as the usual range. In a row of tiles
/// it takes the row's height.
private struct WidgetStat: View {
    let node: Node
    @Environment(\.widgetInTileGrid) private var inGrid

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: node.string(for: "label") ?? "").romeFont(CardScale.label).foregroundStyle(Palette.sub)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: WidgetCatalog.shown(node, "value")).romeFont(20, .medium, monospacedDigits: true).foregroundStyle(Palette.fg)
                if let unit = node.string(for: "unit") {
                    Text(verbatim: unit).romeFont(CardScale.label).foregroundStyle(Palette.sub)
                }
            }
            // The value stays on one line: a long one shrinks to fit.
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            if let caption = node.string(for: "caption") {
                Text(verbatim: caption).romeFont(CardScale.label).foregroundStyle(Palette.sub)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: inGrid ? .infinity : nil, alignment: .topLeading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Palette.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// The label on the left and the share on the right, above a thin track.
private struct WidgetProgress: View {
    let node: Node

    var body: some View {
        let max = node.double(for: "max").flatMap { $0 > 0 ? $0 : nil } ?? 1
        let share = Swift.min(Swift.max((node.double(for: "value") ?? 0) / max, 0), 1)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: node.string(for: "label") ?? "").romeFont(CardScale.caption).foregroundStyle(Palette.fg)
                Spacer(minLength: 12)
                Text(verbatim: "\(Int((share * 100).rounded()))%")
                    .romeFont(CardScale.caption, monospacedDigits: true).foregroundStyle(Palette.sub)
            }
            Capsule().fill(Palette.fill).frame(height: 6)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule().fill(Palette.primary).frame(width: proxy.size.width * share)
                    }
                }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(node.string(for: "label") ?? "")
        .accessibilityValue("\(Int((share * 100).rounded()))%")
    }
}

private struct WidgetImage: View {
    let node: Node

    var body: some View {
        if let url = WidgetPaths.httpsURL(node.string(for: "url") ?? "") {
            let fit = ["contain", "scaleDown", "none"].contains(node.string(for: "fit") ?? "")
            let image = AsyncImage(url: url) { image in
                image.resizable().aspectRatio(contentMode: fit ? .fit : .fill)
            } placeholder: {
                Palette.fill
            }
            let description = node.string(for: "description") ?? ""
            // As the dashboard draws them: an icon is a 20 pt tile, an avatar a
            // 32 pt circle, any other variant fills the card's width.
            switch node.string(for: "variant") {
            case "icon":
                image.frame(width: 20, height: 20)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .accessibilityLabel(description)
            case "avatar":
                image.frame(width: 32, height: 32).clipShape(Circle()).accessibilityLabel(description)
            default:
                // Zero minimums make the frame take the width it is offered, so
                // a wide image is clipped instead of widening the card.
                image.frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityLabel(description)
            }
        }
    }
}

private struct WidgetRow: View {
    let node: Node
    @Environment(\.a2uiCatalogs) private var catalogs
    @Environment(\.a2uiDefaultCatalogID) private var defaultCatalogID

    var body: some View {
        let kids = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: defaultCatalogID)
        // Numbers side by side read as an even two-column grid.
        if kids.count > 1, kids.allSatisfy({ $0.type == "Stat" }) {
            let rows = stride(from: 0, to: kids.count, by: 2).map { Array(kids[$0 ..< Swift.min($0 + 2, kids.count)]) }
            // A Grid, not a lazy one, so the tiles of a row share its height.
            Grid(alignment: .topLeading, horizontalSpacing: 10, verticalSpacing: 10) {
                ForEach(rows, id: \.first?.id) { pair in
                    GridRow {
                        ForEach(pair) { kid in ComponentNodeView(node: kid).environment(\.widgetInTileGrid, true) }
                        if pair.count == 1 { Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                    }
                }
            }
        } else {
            row(kids)
        }
    }

    @ViewBuilder private func row(_ kids: [Node]) -> some View {
        // A2UI's `justify` as spacers: before the first child, between
        // children, and after the last.
        let justify = node.string(for: "justify") ?? "start"
        let lead = ["end", "center", "spaceAround", "spaceEvenly"].contains(justify)
        let between = ["spaceBetween", "spaceAround", "spaceEvenly"].contains(justify)
        let trail = ["start", "stretch", "center", "spaceAround", "spaceEvenly"].contains(justify)
        let align: VerticalAlignment = switch node.string(for: "align") {
        case "start": .top
        case "end": .bottom
        default: .center
        }
        // A row too narrow for its children (buttons keep their labels on
        // one line) stacks them instead, on the side it was justified to.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: align, spacing: 12) {
                if lead { Spacer(minLength: 0) }
                ForEach(Array(kids.enumerated()), id: \.element.id) { index, kid in
                    if between && index > 0 { Spacer(minLength: 8) }
                    ComponentNodeView(node: kid)
                }
                if trail { Spacer(minLength: 0) }
            }
            VStack(alignment: lead && !trail ? .trailing : .leading, spacing: 8) {
                ForEach(kids) { kid in ComponentNodeView(node: kid) }
            }
            .frame(maxWidth: .infinity, alignment: lead && !trail ? .trailing : .leading)
        }
    }
}

/// A `Column`, or a `List` (vertical or horizontal), as the dashboard lays them out.
/// A Column's children sit 12 apart, except a caption right under a heading,
/// its subtitle, 4 under it. A List's rows have a hairline between them.
private struct WidgetStack: View {
    let node: Node
    @Environment(\.a2uiCatalogs) private var catalogs
    @Environment(\.a2uiDefaultCatalogID) private var defaultCatalogID

    private static let headings: Set<String> = ["h1", "h2", "h3", "h4", "h5"]

    private func isSubtitle(_ kids: [Node], _ index: Int) -> Bool {
        guard index > 0 else { return false }
        let kid = kids[index], above = kids[index - 1]
        return kid.type == "Text" && kid.string(for: "variant") == "caption"
            && above.type == "Text" && Self.headings.contains(above.string(for: "variant") ?? "")
    }

    var body: some View {
        let kids = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: defaultCatalogID)
        let isList = node.type == "List"
        if isList && node.string(for: "direction") == "horizontal" {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) { ForEach(kids) { kid in ComponentNodeView(node: kid) } }
            }
        } else {
            let align: HorizontalAlignment = switch node.string(for: "align") {
            case "center": .center
            case "end": .trailing
            default: .leading
            }
            let frame: Alignment = align == .center ? .center : align == .trailing ? .trailing : .leading
            VStack(alignment: align, spacing: 0) {
                ForEach(Array(kids.enumerated()), id: \.element.id) { index, kid in
                    if isList {
                        ComponentNodeView(node: kid)
                            .frame(maxWidth: .infinity, alignment: frame)
                            .padding(.top, index == 0 ? 0 : 10)
                            .padding(.bottom, index == kids.count - 1 ? 0 : 10)
                            .overlay(alignment: .bottom) {
                                if index < kids.count - 1 { Rectangle().fill(Palette.hair).frame(height: 1) }
                            }
                    } else {
                        ComponentNodeView(node: kid)
                            .padding(.top, index == 0 ? 0 : isSubtitle(kids, index) ? 4 : 12)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: frame)
        }
    }
}

private struct WidgetButton: View {
    let node: Node
    @Environment(\.widgetBusy) private var busy
    @Environment(\.widgetLocked) private var locked

    var body: some View {
        if !locked { button }
    }

    @ViewBuilder private var button: some View {
        let variant = node.string(for: "variant")
        let primary = variant == "primary"
        let borderless = variant == "borderless"
        Button {
            node.action(for: "action", userActivation: true)?()
        } label: {
            HStack(spacing: 6) {
                if busy { Spinner(size: 12, color: primary ? .white : Palette.sub) }
                if let child = node.child(for: "child") {
                    ComponentNodeView(node: child).environment(\.widgetInButton, true)
                }
            }
            // A label never breaks mid-word: the row stacks instead.
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(primary ? Color.white : borderless ? Palette.sub : Palette.primaryText)
            .padding(.horizontal, 14)
            .frame(minHeight: CardScale.actionHeight)
            .background(primary ? Palette.primary : borderless ? Color.clear : Palette.primarySoft, in: Capsule())
            .opacity(node.isValid ? 1 : 0.45)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(busy || !node.isValid)
    }
}

/// Options drawn as the question card's chips: a picked chip is filled.
private struct WidgetChoicePicker: View {
    let node: Node
    @Environment(\.widgetLocked) private var locked
    @Environment(\.widgetClears) private var clears

    private struct Option: Identifiable {
        let label: String
        let value: String
        let description: String?
        var id: String { value }
    }

    private var options: [Option] {
        (node.array(for: "options") ?? []).compactMap { element in
            guard let option = element as? ResolvedDictionary, let value = option.string(for: "value") else { return nil }
            return Option(label: option.string(for: "label") ?? value, value: value, description: option.string(for: "description"))
        }
    }

    private var picked: [String] {
        (node.dataBinding(for: "value") as DataBinding<[String]>?)?.value ?? []
    }

    var body: some View {
        let picked = picked
        let multi = node.string(for: "variant") == "multipleSelection"
        VStack(alignment: .leading, spacing: 8) {
            ForEach(options) { option in
                let selected = picked.contains(option.value)
                Button {
                    let next = multi ? (selected ? picked.filter { $0 != option.value } : picked + [option.value]) : [option.value]
                    (node.dataBinding(for: "value") as DataBinding<[String]>?)?.set(next)
                    if !next.isEmpty, let target = clears.targets[node.id] { clears.clear(target, false) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: option.label)
                            .romeFont(CardScale.body, .medium)
                            .foregroundStyle(selected ? Color.white : Palette.fg)
                        if let description = option.description {
                            Text(verbatim: description)
                                .romeFont(CardScale.caption)
                                .foregroundStyle(selected ? Color.white.opacity(0.8) : Palette.sub)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(selected ? Palette.primary : Palette.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(PressScaleStyle())
                .disabled(locked)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }
}

private struct WidgetTextField: View {
    let node: Node
    @Environment(\.widgetLocked) private var locked
    @Environment(\.widgetClears) private var clears

    var body: some View {
        let value: Binding<String> = node.binding(for: "value", default: "")
        let text = Binding(
            get: { value.wrappedValue },
            set: { typed in
                value.wrappedValue = typed
                if !typed.isEmpty, let target = clears.targets[node.id] { clears.clear(target, true) }
            }
        )
        let label = node.string(for: "label") ?? ""
        TextField(node.string(for: "placeholder") ?? label, text: text, axis: .vertical)
            .lineLimit(node.string(for: "variant") == "longText" ? 3...6 : 1...4)
            .romeFont(CardScale.body)
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Palette.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .disabled(locked)
            .accessibilityLabel(label)
    }
}

/// A2UI's `required`, except that a string of spaces is no answer, as the
/// question card and the dashboard have always read it.
private final class TrimmedRequired: FunctionImplementation, Sendable {
    let api = FunctionAPI(
        name: "required",
        returnType: .boolean,
        // swiftlint:disable:next force_try
        schema: try! Schema(instance: #"{"type":"object","properties":{"value":{}},"required":["value"]}"#)
    )

    func evaluate(arguments: [String: JSONSchema.JSONValue], context: DataContext) throws -> JSONSchema.JSONValue {
        switch arguments["value"] {
        case .string(let text): .boolean(!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        case .array(let list): .boolean(!list.isEmpty)
        case .null, nil: .boolean(false)
        default: .boolean(true)
        }
    }
}

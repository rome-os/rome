import A2UICore
import A2UIJSON
import A2UISwiftUI
import BasicCatalog
import JSONSchema
import SwiftUI

/// Rome's A2UI catalog for chat cards, drawn with the app's own `Palette` and
/// `romeFont`. Google's A2UI engine reads the card, resolves its paths and
/// keeps its data, as it does for the dashboard; these views only draw. The
/// components from A2UI's basic catalog keep its schemas; `Stat` and
/// `Progress` are Rome's.
@MainActor
enum WidgetCatalog {
    /// The id the dashboard's catalog uses too, so a card names one catalog.
    static let id = "https://rome.app/a2ui/catalogs/chat-widget/v1.json"

    static let catalog = Catalog<ComponentImplementation>(
        id: id,
        protocolVersion: .v09,
        components: [text, stat, progress, image, row, column, list, button]
    )

    private static let text = ComponentImplementation(api: BasicCatalogComponents.text) { node in
        WidgetText(node: node)
    }

    private static let stat = ComponentImplementation(
        name: "Stat",
        schema: schema(["label": "DynamicString", "value": "DynamicValue", "unit": "DynamicString", "caption": "DynamicString"], required: ["label", "value"])
    ) { node in
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: node.string(for: "label") ?? "").romeFont(CardScale.caption).foregroundStyle(Palette.sub)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: shown(node, "value")).romeFont(22, .semibold, monospacedDigits: true).foregroundStyle(Palette.fg)
                if let unit = node.string(for: "unit") {
                    Text(verbatim: unit).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                }
            }
            if let caption = node.string(for: "caption") {
                Text(verbatim: caption).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
            }
        }
        .accessibilityElement(children: .combine)
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
        WidgetStack(node: node, spacing: 8)
    }

    private static let list = ComponentImplementation(api: BasicCatalogComponents.list) { node in
        WidgetStack(node: node, spacing: 4)
    }

    private static let button = ComponentImplementation(api: BasicCatalogComponents.button) { node in
        WidgetButton(node: node)
    }

    /// A Rome component's schema: an object whose properties each name one of
    /// A2UI's common types, which tells the engine to resolve a `{ path }` in
    /// that property against the card's data.
    private static func schema(_ properties: KeyValuePairs<String, String>, required: [String]) -> Schema {
        let props = properties.map { #""\#($0.key)":{"$ref":"https://a2ui.org/schemas/v0_9_1/common.json#/$defs/\#($0.value)"}"# }.joined(separator: ",")
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

/// Set while a button's request runs: every button is disabled, so a press is sent once.
struct WidgetBusyKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    fileprivate var widgetInButton: Bool {
        get { self[InButtonKey.self] }
        set { self[InButtonKey.self] = newValue }
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
        case "h1", "h2": (20, .semibold)
        case "h3", "h4": (CardScale.title, .semibold)
        case "h5": (CardScale.title, .medium)
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

private struct WidgetProgress: View {
    let node: Node

    var body: some View {
        let max = node.double(for: "max").flatMap { $0 > 0 ? $0 : nil } ?? 1
        let value = node.double(for: "value") ?? 0
        VStack(alignment: .leading, spacing: 4) {
            if let label = node.string(for: "label") {
                Text(verbatim: label).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
            }
            ProgressView(value: Swift.min(Swift.max(value, 0), max), total: max).tint(Palette.primary)
        }
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
        HStack(alignment: align, spacing: 12) {
            if lead { Spacer(minLength: 0) }
            ForEach(Array(kids.enumerated()), id: \.element.id) { index, kid in
                if between && index > 0 { Spacer(minLength: 8) }
                ComponentNodeView(node: kid)
            }
            if trail { Spacer(minLength: 0) }
        }
    }
}

/// A `Column`, or a `List` (vertical or horizontal), as the dashboard lays them out.
private struct WidgetStack: View {
    let node: Node
    let spacing: CGFloat
    @Environment(\.a2uiCatalogs) private var catalogs
    @Environment(\.a2uiDefaultCatalogID) private var defaultCatalogID

    var body: some View {
        let kids = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: defaultCatalogID)
        let items = ForEach(kids) { kid in ComponentNodeView(node: kid) }
        if node.type == "List" && node.string(for: "direction") == "horizontal" {
            ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 8) { items } }
        } else {
            let align: HorizontalAlignment = switch node.string(for: "align") {
            case "center": .center
            case "end": .trailing
            default: .leading
            }
            let frame: Alignment = align == .center ? .center : align == .trailing ? .trailing : .leading
            VStack(alignment: align, spacing: spacing) { items }
                .frame(maxWidth: .infinity, alignment: frame)
        }
    }
}

private struct WidgetButton: View {
    let node: Node
    @Environment(\.widgetBusy) private var busy

    var body: some View {
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

import SwiftUI

/// A card an app described as data, drawn natively. Each `bind` is read from
/// the app's API when the card appears, so it shows the app's data as it
/// stands. A button POSTs its context to the app's API and reads every
/// `bind` again; nothing is said in the chat.
struct WidgetUICardView: View {
    let part: WidgetUIPart
    /// A call on the card's own app: method, path in its API, JSON body.
    let call: (String, String, JSONValue?) async throws -> ConnectReply

    @State private var data: JSONValue = .object([:])
    @State private var loaded = false
    @State private var failed = false
    @State private var pressing: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            node("root", scope: "", depth: 0)
            if failed {
                Text("Could not read this card's data. \(part.text)")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
        .padding(.top, 4)
        .redacted(reason: loaded || failed ? [] : .placeholder)
        .task(id: part) { await load() }
    }

    private func load() async {
        var next = data
        do {
            for (pointer, path) in part.bind.sorted(by: { $0.key < $1.key }) {
                guard WidgetData.isAppPath(path) else { throw APIError.notFound }
                let reply = try await call("GET", path, nil)
                guard reply.ok else { throw APIError.server(status: 500, message: nil) }
                next = WidgetData.storing(reply.body, at: pointer, in: next)
            }
            data = next
            failed = false
        } catch {
            failed = true
        }
        loaded = true
    }

    private func press(_ button: WidgetComponent, scope: String) async {
        guard let name = button["action"]?["event"]?["name"]?.string, WidgetData.isAppPath(name) else { return }
        pressing = button.id
        defer { pressing = nil }
        let body = WidgetData.context(button["action"]?["event"]?["context"], in: data, scope: scope)
        do {
            let reply = try await call("POST", name, body)
            if !reply.ok { failed = true; return }
            await load()
        } catch {
            failed = true
        }
    }

    // A card is a tree of a few dozen components at most; `depth` stops a
    // malformed one that slipped past the server's cycle check.
    private func node(_ id: String, scope: String, depth: Int, inButton: Bool = false) -> AnyView {
        guard depth < 24, let c = part.components[id] else { return AnyView(EmptyView()) }
        let text = { (key: String) in WidgetData.text(c[key], in: data, scope: scope) }
        let kids = c.children(in: data, scope: scope)
        switch c.kind {
        case .text:
            return AnyView(textView(text("text"), variant: c["variant"]?.string, inButton: inButton))
        case .stat:
            return AnyView(VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: text("label")).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(verbatim: text("value")).romeFont(22, .semibold, monospacedDigits: true).foregroundStyle(Palette.fg)
                    if c["unit"] != nil {
                        Text(verbatim: text("unit")).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                    }
                }
                if c["caption"] != nil {
                    Text(verbatim: text("caption")).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                }
            }
            .accessibilityElement(children: .combine))
        case .progress:
            let max = WidgetData.number(c["max"], in: data, scope: scope).flatMap { $0 > 0 ? $0 : nil } ?? 1
            let value = WidgetData.number(c["value"], in: data, scope: scope) ?? 0
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                if c["label"] != nil {
                    Text(verbatim: text("label")).romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                }
                ProgressView(value: Swift.min(Swift.max(value, 0), max), total: max)
                    .tint(Palette.primary)
            })
        case .image:
            let url = URL(string: text("url"))
            return AnyView(AsyncImage(url: url) { image in
                image.resizable().aspectRatio(contentMode: c["fit"]?.string == "contain" ? .fit : .fill)
            } placeholder: {
                Palette.fill
            }
            .frame(maxWidth: .infinity, maxHeight: 180)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel(text("description")))
        case .row:
            let between = c["justify"]?.string == "spaceBetween"
            return AnyView(HStack(alignment: .center, spacing: 12) {
                ForEach(Array(kids.enumerated()), id: \.offset) { index, kid in
                    if between && index > 0 { Spacer(minLength: 8) }
                    node(kid.id, scope: kid.scope, depth: depth + 1)
                }
            })
        case .column, .list:
            let horizontal = c.kind == .list && c["direction"]?.string == "horizontal"
            let stack = ForEach(Array(kids.enumerated()), id: \.offset) { _, kid in
                node(kid.id, scope: kid.scope, depth: depth + 1)
            }
            if horizontal {
                return AnyView(ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 8) { stack } })
            }
            return AnyView(VStack(alignment: .leading, spacing: c.kind == .list ? 4 : 8) { stack })
        case .button:
            let primary = c["variant"]?.string == "primary"
            return AnyView(Button {
                Task { await press(c, scope: scope) }
            } label: {
                HStack(spacing: 6) {
                    if pressing == c.id { Spinner(size: 12, color: primary ? .white : Palette.sub) }
                    ForEach(Array(kids.enumerated()), id: \.offset) { _, kid in
                        node(kid.id, scope: kid.scope, depth: depth + 1, inButton: true)
                    }
                }
                .foregroundStyle(primary ? Color.white : Palette.primaryText)
                .padding(.horizontal, 14)
                .frame(minHeight: CardScale.actionHeight)
                .background(primary ? Palette.primary : Palette.primarySoft, in: Capsule())
            }
            .buttonStyle(PressScaleStyle())
            .disabled(pressing != nil))
        case .unknown:
            return AnyView(EmptyView())
        }
    }

    private func textView(_ text: String, variant: String?, inButton: Bool) -> some View {
        let size: CGFloat
        let weight: Font.Weight
        switch variant {
        case "h1", "h2": size = 20; weight = .semibold
        case "h3", "h4": size = CardScale.title; weight = .semibold
        case "h5": size = CardScale.title; weight = .medium
        case "caption": size = CardScale.caption; weight = .regular
        default: size = CardScale.body; weight = .regular
        }
        // A button's label takes the button's own color.
        let label = Text(verbatim: text)
            .romeFont(inButton ? CardScale.actionFont : size, inButton ? .medium : weight)
            .fixedSize(horizontal: false, vertical: true)
        return Group {
            if inButton { label } else { label.foregroundStyle(variant == "caption" ? Palette.sub : Palette.fg) }
        }
    }
}

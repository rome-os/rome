import SwiftUI

/// A card described as data, drawn natively. Each `bind` is read from the
/// app's API when the card appears, so it shows the app's data as it stands.
/// A button POSTs its context to the app's API and reads every `bind` again;
/// nothing is said in the chat. On a card the agent waits on, `rome:answer`
/// and `rome:dismiss` answer the interaction instead.
struct WidgetUICardView: View {
    /// What a card the agent waits on needs: the stored answer once there is
    /// one, which locks the card, and how to answer or dismiss it.
    struct Waiting {
        let answered: JSONValue?
        let sending: Bool
        let answer: (JSONValue) -> Void
        let dismiss: () -> Void
    }

    let part: WidgetUIPart
    /// A call on the card's own app: method, path in its API, JSON body.
    let call: (String, String, JSONValue?) async throws -> ConnectReply
    var waiting: Waiting? = nil

    @State private var data: JSONValue = .object([:])
    @State private var loaded = false
    @State private var failed = false
    @State private var pressing: String?

    private var locked: Bool { waiting.map { $0.answered != nil || $0.sending } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            node("root", scope: "", depth: 0)
            if let waiting, waiting.answered != nil {
                Text(waiting.answered?["dismissed"]?.bool == true ? "Dismissed" : "Answered")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
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
        .onChange(of: waiting?.answered) { showAnswered() }
    }

    /// An answered card shows what the guardian sent, which core keeps as `card`.
    private func showAnswered() {
        if let card = waiting?.answered?["card"] {
            data = WidgetData.storing(card, at: "/answers", in: data)
        }
    }

    private func load() async {
        if !loaded {
            data = part.data
            showAnswered()
        }
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
        let name = button["action"]?["event"]?["name"]?.string ?? ""
        if name == "rome:answer" || name == "rome:dismiss" {
            guard let waiting, !locked else { return }
            if name == "rome:dismiss" { waiting.dismiss() }
            else { waiting.answer(WidgetData.context(button["action"]?["event"]?["context"], in: data, scope: scope)) }
            return
        }
        // A card the agent waits on is Rome's own; it reaches no app.
        guard waiting == nil, WidgetData.isAppPath(name) else { return }
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
            guard let url = WidgetData.httpsURL(text("url")) else { return AnyView(EmptyView()) }
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
            let end = c["justify"]?.string == "end"
            return AnyView(HStack(alignment: .center, spacing: 12) {
                if end { Spacer(minLength: 0) }
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
        case .choicePicker:
            return AnyView(choicePicker(c, scope: scope))
        case .textField:
            let pointer = WidgetData.absolute(c["value"]?["path"]?.string ?? "", scope: scope)
            let placeholder = c["placeholder"] != nil ? text("placeholder") : text("label")
            let field = Binding(
                get: { WidgetData.read(data, pointer: pointer)?.string ?? "" },
                set: { data = WidgetData.editing(.string($0), at: pointer, clears: c["clears"], scope: scope, in: data) }
            )
            return AnyView(TextField(placeholder, text: field, axis: .vertical)
                .lineLimit(c["variant"]?.string == "longText" ? 3...6 : 1...4)
                .romeFont(CardScale.body)
                .foregroundStyle(Palette.fg)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .disabled(locked)
                .accessibilityLabel(text("label")))
        case .button:
            if waiting != nil && locked { return AnyView(EmptyView()) }
            let primary = c["variant"]?.string == "primary"
            let borderless = c["variant"]?.string == "borderless"
            let checked = (c["checks"]?.array ?? []).allSatisfy { WidgetData.passes($0["condition"], in: data, scope: scope) }
            return AnyView(Button {
                Task { await press(c, scope: scope) }
            } label: {
                HStack(spacing: 6) {
                    if pressing == c.id { Spinner(size: 12, color: primary ? .white : Palette.sub) }
                    ForEach(Array(kids.enumerated()), id: \.offset) { _, kid in
                        node(kid.id, scope: kid.scope, depth: depth + 1, inButton: true)
                    }
                }
                .foregroundStyle(primary ? Color.white : borderless ? Palette.sub : Palette.primaryText)
                .padding(.horizontal, 14)
                .frame(minHeight: CardScale.actionHeight)
                .background(primary ? Palette.primary : borderless ? Color.clear : Palette.primarySoft, in: Capsule())
                .opacity(checked ? 1 : 0.45)
            }
            .buttonStyle(PressScaleStyle())
            .disabled(pressing != nil || !checked))
        case .unknown:
            return AnyView(EmptyView())
        }
    }

    /// Options read as the question card's chips: a picked chip is filled.
    private func choicePicker(_ c: WidgetComponent, scope: String) -> some View {
        let pointer = WidgetData.absolute(c["value"]?["path"]?.string ?? "", scope: scope)
        let picked = (WidgetData.read(data, pointer: pointer)?.array ?? []).compactMap(\.string)
        let multi = c["variant"]?.string == "multipleSelection"
        let options = c["options"]?.array ?? []
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let value = option["value"]?.string ?? ""
                let selected = picked.contains(value)
                Button {
                    let next = multi ? (selected ? picked.filter { $0 != value } : picked + [value]) : [value]
                    data = WidgetData.editing(.array(next.map(JSONValue.string)), at: pointer, clears: c["clears"], scope: scope, in: data)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: WidgetData.text(option["label"], in: data, scope: scope))
                            .romeFont(CardScale.body, .medium)
                            .foregroundStyle(selected ? Color.white : Palette.fg)
                        if option["description"] != nil {
                            Text(verbatim: WidgetData.text(option["description"], in: data, scope: scope))
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

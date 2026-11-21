import SwiftUI

/// A card Chat shows to connect a service: its mark, its name, and one button
/// that connects it on this phone, as the web dashboard's connect card does.
struct ConnectCardView: View {
    let part: MessagePart.ConnectCardPart
    let phase: ConnectPhase
    let onConnect: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.openInstancePage) private var openInstancePage

    /// Rome Cloud cannot connect it from here: say why, and point to Settings on the web.
    private var unavailable: String? {
        guard case .romeOAuth(let url, let available, let reason) = part.connect,
              !available || (url ?? "").isEmpty
        else { return nil }
        return reason ?? String(localized: "Cannot be connected here")
    }

    var body: some View {
        HStack(spacing: 12) {
            ConnectorMark(icon: part.icon, label: part.label, size: CardScale.connectMark)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: part.label)
                    .romeFont(CardScale.title, .medium)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                if let line = subline {
                    Text(verbatim: line.text)
                        .romeFont(CardScale.caption)
                        .foregroundStyle(line.error ? Palette.destructive : Palette.sub)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    private var subline: (text: String, error: Bool)? {
        if let unavailable { return (unavailable, false) }
        switch phase {
        case .connected(let account?): return (account, false)
        case .failed(let reason): return (reason ?? String(localized: "Not connected yet"), true)
        default: return nil
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch phase {
        case .connected:
            Label("Connected", systemImage: "checkmark")
                .romeFont(CardScale.body)
                .foregroundStyle(Palette.sub)
        case .connecting:
            HStack(spacing: 8) {
                Spinner(size: 14, color: Palette.sub)
                Text("Connecting…")
                    .romeFont(CardScale.body)
                    .foregroundStyle(Palette.sub)
            }
        case .idle, .failed:
            if unavailable != nil {
                Button("Settings") { openSettings() }
                    .romeFont(CardScale.body, .medium)
                    .foregroundStyle(Palette.primaryText)
                    .buttonStyle(PressScaleStyle())
            } else {
                Button(action: onConnect) {
                    Text(phase == .idle ? "Connect" : "Try again")
                        .romeFont(CardScale.actionFont, .medium)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(minHeight: CardScale.actionHeight)
                        .background(Palette.primary, in: Capsule())
                }
                .buttonStyle(PressScaleStyle())
            }
        }
    }

    private func openSettings() {
        guard let web = model.webURL else { return }
        openInstancePage(InstancePages.connections(origin: web))
    }
}

/// A service's mark from its connector id, as the web's `ConnectorIcon` draws
/// it: `brand:<connection kind>` on its brand badge, `glyph:<id>` on a neutral
/// tile; anything this build does not draw gets a neutral tile with the
/// label's initial.
struct ConnectorMark: View {
    let icon: String?
    let label: String
    var size: CGFloat = 36

    @Environment(\.colorScheme) private var scheme
    @State private var image: UIImage?

    private enum Mark {
        case brand(svg: String, badge: String, mark: String?)
        case glyph(svg: String, multicolor: Bool)
        case initial
    }

    private var mark: Mark {
        guard let icon, let colon = icon.firstIndex(of: ":") else { return .initial }
        let source = icon[..<colon], id = String(icon[icon.index(after: colon)...])
        if source == "brand", let entry = ConnectorMarks.brands[ConnectorMarks.brandOf[id] ?? id] {
            return .brand(svg: entry.svg, badge: entry.badge, mark: entry.mark)
        }
        if source == "glyph", let entry = ConnectorMarks.glyphs[id] {
            return .glyph(svg: entry.svg, multicolor: entry.multicolor)
        }
        return .initial
    }

    var body: some View {
        let mark = mark
        ZStack {
            switch mark {
            case .brand(_, let badge, let tint):
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(color(badge))
                glyph(tint.map(color))
            case .glyph(_, let multicolor):
                tile
                glyph(multicolor ? nil : Palette.fg)
            case .initial:
                tile
                Text(verbatim: String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
                    .font(.system(size: size * 0.4, weight: .medium))
                    .foregroundStyle(Palette.sub)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .task(id: icon) {
            image = nil
            let svg: String
            switch mark {
            case .brand(let s, _, _), .glyph(let s, _): svg = s
            case .initial: return
            }
            image = await AppIconImage.decode(Data(svg.utf8), side: size * 0.56)
        }
    }

    private var tile: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Palette.elevated)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.hair, lineWidth: 1))
    }

    /// The mark itself: a single-color one takes `tint`, a multicolor one keeps its colors.
    @ViewBuilder
    private func glyph(_ tint: Color?) -> some View {
        if let image {
            if let tint {
                Image(uiImage: image.withRenderingMode(.alwaysTemplate))
                    .resizable().scaledToFit()
                    .foregroundStyle(tint)
                    .frame(width: size * 0.56, height: size * 0.56)
            } else {
                Image(uiImage: image)
                    .resizable().scaledToFit()
                    .frame(width: size * 0.56, height: size * 0.56)
            }
        }
    }

    /// A badge color: a brand hex, white, or the theme's text or page color.
    private func color(_ name: String) -> Color {
        switch name {
        case "white": return .white
        case "foreground": return Palette.fg
        case "background": return Palette.bg
        default:
            let hex = UInt32(name.dropFirst(), radix: 16) ?? 0
            return Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        }
    }
}

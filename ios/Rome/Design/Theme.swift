import SwiftUI
import UIKit

/// The design's color tokens. Each one has a light and a dark value, taken
/// from the design boards (Ember theme). OKLCH values were converted to sRGB.
enum Palette {
    static let bg = dynamic(0xF4F3EF, 0x0B0907)
    static let sheet = dynamic(0xF4F3EF, 0x120F0D)
    static let elevated = dynamic(0xFFFFFF, 0x191513)
    static let bubble = dynamic(0xEBE4DA, 0x1C1916)
    static let fill = dynamic(0xEFE9E1, 0x272320)
    static let fillStrong = dynamic(0xE8E1D7, 0x2A2523)
    static let pressed = dynamic(0xF1ECE5, 0x221E1C)
    static let drawer = dynamic(0xECE7DF, 0x050404)
    static let drawerField = dynamic(0xE3DCD1, 0x1E1A17)

    static let fg = dynamic(0x1A130F, 0xF4F3EF)
    static let sub = dynamic(0x7A6857, 0xB0A294)
    static let hair = dynamic(rgba: (0x1A130F, 0.09), (0xFFFFFF, 0.08))
    static let glass = dynamic(rgba: (0xFFFFFF, 0.78), (0x1E1A17, 0.8))
    static let grabber = dynamic(rgba: (0x1A130F, 0.18), (0xFFFFFF, 0.22))
    static let scrim = dynamic(rgba: (0x1A130F, 0.25), (0x000000, 0.55))
    /// The page pushed aside by the open drawer: a step above the page,
    /// below the agent bubble in dark.
    static let drawerPage = dynamic(0xE4DED4, 0x151210)
    static let cardShadow = dynamic(rgba: (0x3C2814, 0.16), (0x000000, 0.5))
    static let softShadow = dynamic(rgba: (0x1A130F, 0.06), (0x000000, 0.3))
    /// Behind the chat header's name, over its glass: the dark pill keeps
    /// its name readable when bright messages pass under it.
    static let headerPillTint = dynamic(rgba: (0xFFFFFF, 0), (0x000000, 0.28))
    /// Under the chat header's avatar, so it sits on the pill.
    static let avatarShadow = dynamic(rgba: (0x3C2814, 0.18), (0x000000, 0.35))

    static let primary = dynamic(0xD86F4C, 0xD86F4C)
    static let primaryIcon = dynamic(0xD86F4C, 0xE07C5A)
    static let primarySoft = dynamic(rgba: (0xD86F4C, 0.14), (0xD86F4C, 0.2))
    static let primaryText = dynamic(0xB4532F, 0xEE9A7C)

    static let destructive = dynamic(0xE0232B, 0xFF6056)
    static let dangerSoft = dynamic(rgba: (0xE0232B, 0.09), (0xFF6056, 0.14))
    static let warning = dynamic(0xE9AB2B, 0xF3B94C)
    static let warningText = dynamic(0x8A5600, 0xF7C15F)
    static let warnSoft = dynamic(rgba: (0xE9AB2B, 0.17), (0xF3B94C, 0.14))
    static let warnRing = dynamic(rgba: (0xE9AB2B, 0.55), (0xF3B94C, 0.45))
    static let running = dynamic(0x0089ED, 0x39A3FF)
    static let runningText = dynamic(0x0069CA, 0x58B0FF)
    static let runningSoft = dynamic(rgba: (0x0089ED, 0.10), (0x39A3FF, 0.16))
    static let success = dynamic(0x5B7A4A, 0x4AC06C)

    /// Letter tiles of apps with no icon, one per app by its name
    /// (`AppTile.colorIndex`). White letters read on each, light and dark.
    static let appTiles: [Color] = [
        dynamic(0xD86F4C, 0xC4603F), // ember
        dynamic(0x2E8F84, 0x2A8075), // teal
        dynamic(0x3B74C9, 0x3768B5), // blue
        dynamic(0x8460C8, 0x7655B4), // violet
        dynamic(0x4E8B47, 0x467D40), // green
        dynamic(0xC9506F, 0xB44864), // rose
    ]

    /// `from` blended toward `to` by `amount` (0…1), in each appearance.
    static func blend(_ from: Color, _ to: Color, _ amount: CGFloat) -> Color {
        let t = min(1, max(0, amount))
        return Color(UIColor { traits in
            let a = UIColor(from).resolvedColor(with: traits)
            let b = UIColor(to).resolvedColor(with: traits)
            var (r1, g1, b1, a1) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
            var (r2, g2, b2, a2) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
            a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
            b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
            return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
        })
    }

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        dynamic(rgba: (light, 1), (dark, 1))
    }

    private static func dynamic(rgba light: (UInt32, Double), _ dark: (UInt32, Double)) -> Color {
        Color(UIColor { traits in
            let (hex, alpha) = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: alpha
            )
        })
    }
}

/// Corner radii and spacing the boards repeat.
enum Metrics {
    static let pagePadding: CGFloat = 16
    static let bubbleRadius: CGFloat = 20
    static let bubbleTight: CGFloat = 6
    static let cardRadius: CGFloat = 18
    static let groupRadius: CGFloat = 16
    static let bigCardRadius: CGFloat = 18
    static let bubbleMaxWidthRatio: CGFloat = 0.78
    /// The widest a conversation runs, its page padding included. On a phone
    /// the screen is narrower; on an iPad the column stays this wide and
    /// centered, so a line never runs across the whole screen.
    static let readableWidth: CGFloat = 720
    /// The widest a full-width button grows, as on the largest phone; an
    /// iPad's page keeps its buttons this wide and centered.
    static let buttonWidth: CGFloat = 400

    /// The width a conversation's column takes in a container this wide.
    static func column(_ container: CGFloat) -> CGFloat {
        min(container, readableWidth)
    }
}

extension View {
    /// Keeps a conversation's rows, composer and banners in one centered
    /// column of `Metrics.readableWidth` at most (DESIGN.md 4).
    func readableColumn() -> some View {
        frame(maxWidth: Metrics.readableWidth).frame(maxWidth: .infinity)
    }
}

/// One scale for every card a chat draws, kept at the size of the chat's
/// own text: a card's title is the bubble's size and only bolder, its body
/// a step smaller, so a card never speaks louder than the conversation
/// (DESIGN.md 3 and 4).
enum CardScale {
    /// The card's title, semibold: the bubble's body size.
    static let title: CGFloat = 16
    /// Body text, option labels, field values.
    static let body: CGFloat = 15
    /// The small label above a title ("Needs approval", "Task"), semibold.
    static let label: CGFloat = 12
    /// Secondary lines and field labels.
    static let caption: CGFloat = 13
    /// Inside a card's edge.
    static let paddingH: CGFloat = 14
    static let paddingV: CGFloat = 12
    /// A box inside a card: a card's fields, a question's options.
    static let fieldCorner: CGFloat = 12
    /// Above and below each row of fields.
    static let fieldRowPadding: CGFloat = 8
    /// The square behind a card's glyph, and the glyph.
    static let iconBox: CGFloat = 30
    static let iconGlyph: CGFloat = 15
    static let iconCorner: CGFloat = 9
    /// A service's mark on a connect card.
    static let connectMark: CGFloat = 32
    /// A card's main buttons (Approve, Reject).
    static let buttonHeight: CGFloat = 40
    static let buttonFont: CGFloat = 16
    /// A question's option row.
    static let optionMinHeight: CGFloat = 40
    /// A small action beside a row (Connect, Open).
    static let actionHeight: CGFloat = 32
    static let actionFont: CGFloat = 14
}

extension View {
    /// A card's padding on the shared scale.
    func cardPadding() -> some View {
        padding(.horizontal, CardScale.paddingH).padding(.vertical, CardScale.paddingV)
    }
}

extension EnvironmentValues {
    /// The background of a page that can sit beside the drawer. The shell
    /// moves it toward `Palette.drawerPage` as the drawer opens.
    @Entry var pageBackground: Color = Palette.bg
}

/// Paints the page's background from the environment.
private struct PageBackground: ViewModifier {
    @Environment(\.pageBackground) private var color

    func body(content: Content) -> some View {
        content.background(color.ignoresSafeArea())
    }
}

extension View {
    /// The page background of a page that can sit beside the drawer.
    func pageBackground() -> some View { modifier(PageBackground()) }

    /// The design's "soft" elevation: a hairline ring plus a faint two-layer drop shadow.
    func softElevation(radius: CGFloat) -> some View {
        self
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
            .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
    }

    /// A hairline ring with no shadow.
    func hairline(radius: CGFloat) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
    }
}

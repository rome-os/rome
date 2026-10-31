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
    static let drawerScrim = dynamic(rgba: (0x1A130F, 0.12), (0x000000, 0.35))
    static let cardShadow = dynamic(rgba: (0x3C2814, 0.16), (0x000000, 0.5))
    static let softShadow = dynamic(rgba: (0x1A130F, 0.06), (0x000000, 0.3))

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
    static let bigCardRadius: CGFloat = 22
    static let bubbleMaxWidthRatio: CGFloat = 0.78
}

extension View {
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

import SwiftUI

/// A design point size that grows with Dynamic Type, the way the body style does.
struct ScaledFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let size: CGFloat
    var weight: Font.Weight = .regular
    var design: Font.Design = .default
    var monospacedDigits = false

    func body(content: Content) -> some View {
        var font = Font.system(size: Self.scaled(size, for: dynamicTypeSize), weight: weight, design: design)
        if monospacedDigits { font = font.monospacedDigit() }
        return content.font(font)
    }
}

extension ScaledFont {
    /// The body style's point size at each text size; everything scales with it.
    static func scaled(_ size: CGFloat, for dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        let body: CGFloat
        switch dynamicTypeSize {
        case .xSmall: body = 14
        case .small: body = 15
        case .medium: body = 16
        case .large: body = 17
        case .xLarge: body = 19
        case .xxLarge: body = 21
        case .xxxLarge: body = 23
        case .accessibility1: body = 28
        case .accessibility2: body = 33
        case .accessibility3: body = 40
        case .accessibility4: body = 47
        case .accessibility5: body = 53
        @unknown default: body = 17
        }
        return (size * body / 17).rounded()
    }
}

extension View {
    /// The app's type: a design point size and weight that scale with Dynamic Type.
    func romeFont(_ size: CGFloat, _ weight: Font.Weight = .regular, design: Font.Design = .default, monospacedDigits: Bool = false) -> some View {
        modifier(ScaledFont(size: size, weight: weight, design: design, monospacedDigits: monospacedDigits))
    }
}

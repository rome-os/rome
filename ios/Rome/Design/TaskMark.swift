import SwiftUI
import UIKit

extension TaskMarkTone {
    /// How much of a status hue a mark shows. The guardian wanted the marks a
    /// little softer than the full-strength tokens, which are made for text
    /// and fills; the quiet grey is already soft and stays as it is.
    static let hueOpacity = 0.8

    var color: Color {
        switch self {
        case .running: Palette.running.opacity(Self.hueOpacity)
        case .needsYou: Palette.warning.opacity(Self.hueOpacity)
        case .done: Palette.success.opacity(Self.hueOpacity)
        case .failed: Palette.destructive.opacity(Self.hueOpacity)
        case .quiet: Palette.sub
        }
    }
}

/// The running ring as frames for a line of text. SwiftUI's concatenated
/// `Text` holds images but no views, so a chip in a paragraph cannot carry
/// `Spinner`; the paragraph is drawn again with the next frame instead, while
/// one of its chips is active (`MarkdownParagraph`). The ring is `Spinner`'s:
/// a faint track and a quarter arc that turns once every `period`.
@MainActor
enum TaskMarkRing {
    nonisolated static let period: TimeInterval = 0.9
    nonisolated static let frames = 18
    nonisolated static var frameInterval: TimeInterval { period / Double(frames) }

    /// The frame to draw at `date`.
    nonisolated static func frame(at date: Date) -> Int {
        Int((date.timeIntervalSinceReferenceDate / frameInterval).rounded(.down)) % frames
    }

    private static var cache: [String: UIImage] = [:]

    /// The ring at `size` points turned to `frame`, a template image, so the
    /// text's foreground colour tints it.
    static func image(size: CGFloat, frame: Int) -> UIImage {
        let frame = ((frame % frames) + frames) % frames
        let key = "\(size)-\(frame)"
        if let held = cache[key] { return held }
        // As wide and as heavy as the SF circles beside it.
        let lineWidth = max(1.1, size * 0.085)
        let side = size
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { context in
            let inset = lineWidth / 2 + size * 0.02
            let rect = CGRect(x: 0, y: 0, width: side, height: side).insetBy(dx: inset, dy: inset)
            let center = CGPoint(x: rect.midX, y: rect.midY)
            let radius = rect.width / 2
            let cg = context.cgContext
            cg.setLineWidth(lineWidth)
            cg.setLineCap(.round)
            cg.setStrokeColor(UIColor.black.withAlphaComponent(0.22).cgColor)
            cg.strokeEllipse(in: rect)
            let start = -CGFloat.pi / 2 + CGFloat(frame) / CGFloat(frames) * 2 * .pi
            cg.setStrokeColor(UIColor.black.cgColor)
            cg.addArc(center: center, radius: radius, startAngle: start, endAngle: start + .pi / 2, clockwise: false)
            cg.strokePath()
        }.withRenderingMode(.alwaysTemplate)
        cache[key] = image
        return image
    }
}

/// The size and the ring's frame the marks of one paragraph are drawn at.
struct TaskMarkStyle: Equatable {
    /// The mark's point size: about 80% of the text beside it, as the web's
    /// 14px mark is to its 16–17px text.
    var size: CGFloat
    var frame = 0

    /// The mark for text set at `fontSize` design points, scaled with Dynamic Type.
    static func forText(_ fontSize: CGFloat, _ dynamicTypeSize: DynamicTypeSize, frame: Int = 0) -> TaskMarkStyle {
        TaskMarkStyle(size: ScaledFont.scaled(fontSize * 0.8, for: dynamicTypeSize), frame: frame)
    }

    /// A status mark as text, in its tone, on the baseline of the name after it.
    @MainActor
    func mark(_ info: TaskLinkInfo) -> Text {
        let tone = info.tone
        let glyph: Text
        if tone == .running {
            // The SF circles sit a little below the baseline; the ring follows them.
            glyph = Text(Image(uiImage: TaskMarkRing.image(size: size, frame: frame)))
                .baselineOffset(-size * 0.09)
        } else {
            // Sized by the design scale, so it grows with Dynamic Type like romeFont.
            glyph = Text(Image(systemName: info.symbol)).font(.system(size: size))
        }
        return glyph.foregroundColor(tone.color)
    }
}

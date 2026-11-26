import SwiftUI

// Shared by the app and its widget: Rome's mascot as the web icon draws it.
// The app's `Mascot` moves it; the widget draws it still (`MascotMark`).

/// The mascot standing still: the head and body in `ink`, the screen in `screen`.
struct MascotMark: View {
    var ink: Color
    var screen: Color

    var body: some View {
        GeometryReader { geometry in
            let scale = geometry.size.width / MascotPaths.viewBox.width
            let box = MascotPaths.viewBox
            ZStack {
                SVGShape(MascotPaths.body, viewBox: box).fill(ink)
                SVGShape(MascotPaths.headFill, viewBox: box).fill(ink)
                SVGShape(MascotPaths.headRing, viewBox: box).fill(ink)
                SVGShape(MascotPaths.screen, viewBox: box).fill(screen)
                SVGShape(MascotPaths.screen, viewBox: box)
                    .stroke(ink, style: StrokeStyle(lineWidth: 4 * scale, lineCap: .round, lineJoin: .round))
                ForEach([MascotPaths.leftEye, MascotPaths.rightEye], id: \.self) { eye in
                    SVGShape(eye, viewBox: box).fill(ink)
                    SVGShape(eye, viewBox: box)
                        .stroke(ink, style: StrokeStyle(lineWidth: 2 * scale, lineJoin: .round))
                }
            }
        }
        .aspectRatio(MascotPaths.viewBox, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// The web icon's paths, in its own units (before the icon's group transform).
enum MascotPaths {
    /// The paths' own size.
    static let viewBox = CGSize(width: 51, height: 47.53)
    static let headFill = "M9.27213 35.3331H38.9233C41.3072 35.3331 43.5668 34.27 45.0866 32.4335L48.0715 28.8265C48.7983 27.9482 49.1158 26.8016 48.9444 25.6747L45.8596 5.39837C45.5623 3.44405 43.8819 2 41.9051 2H16.9889C14.4932 2 12.1405 3.16467 10.6273 5.14922L2.81921 15.3892C2.19692 16.2053 1.91212 17.2294 2.02374 18.2496L3.30773 29.9857C3.64065 33.0287 6.21098 35.3331 9.27213 35.3331Z"
    static let headRing = "M41.9056 0C44.8706 0.000307729 47.3913 2.16638 47.8373 5.09766L50.9213 25.374C51.1784 27.0644 50.7027 28.7843 49.6127 30.1016L46.6273 33.709C44.7276 36.0044 41.9028 37.333 38.9232 37.333H9.27185C5.19048 37.3328 1.76359 34.2603 1.3197 30.2031L0.0355225 18.4668C-0.131792 16.9367 0.295602 15.4008 1.22888 14.1768L9.03748 3.93652C10.929 1.45612 13.8693 0.000108882 16.9886 0H41.9056ZM16.9886 4C15.1171 4.00011 13.353 4.87404 12.2181 6.3623L4.40955 16.6016C4.0984 17.0096 3.95628 17.5221 4.01208 18.0322L5.29626 29.7686C5.51839 31.7969 7.23139 33.3328 9.27185 33.333H38.9232C40.711 33.333 42.4065 32.5356 43.5463 31.1582L46.5306 27.5518C46.8939 27.1127 47.0528 26.539 46.9672 25.9756L43.8822 5.69922C43.7336 4.72226 42.8938 4.00031 41.9056 4H16.9886Z"
    static let body = "M12.3794 47.5269C12.3794 45.5392 12.7709 43.571 13.5315 41.7347C14.2922 39.8983 15.4071 38.2298 16.8126 36.8243C18.218 35.4188 19.8866 34.3039 21.7229 33.5433C23.5593 32.7826 25.5275 32.3911 27.5151 32.3911C29.5028 32.3911 31.471 32.7826 33.3073 33.5433C35.1437 34.3039 36.8122 35.4188 38.2177 36.8243C39.6232 38.2298 40.7381 39.8983 41.4987 41.7347C42.2594 43.571 42.6509 45.5392 42.6509 47.5269L12.3794 47.5269Z"
    static let screen = "M13.5613 6.47284L15.7849 25.1512C16.0244 27.1632 17.7306 28.6784 19.7568 28.6784H44.6983C47.1437 28.6784 49.0167 26.5036 48.6541 24.0853L45.8536 5.40689C45.56 3.4487 43.8779 2 41.8978 2H17.5333C15.1367 2 13.278 4.09306 13.5613 6.47284Z"
    static let rightEye = "M35.2279 11.8394H38.2279L36.6069 15.2237L39.2279 18.8394H36.2279L33.8544 15.2237L35.2279 11.8394Z"
    static let leftEye = "M25.5321 11.8394H28.5321L29.5321 18.8394H26.5321L25.5321 11.8394Z"

    /// The eyes' middle, for the blink.
    static let eyeAnchor = UnitPoint(x: 32.4 / 51, y: 15.34 / 47.53)
    /// Where the head meets the body, for the nod.
    static let neckAnchor = UnitPoint(x: 27.5 / 51, y: 33.5 / 47.53)
}

/// An SVG path (absolute M, L, H, V, C and Z, as the icon uses) scaled from
/// its view box into the shape's frame.
struct SVGShape: Shape {
    let data: String
    let viewBox: CGSize

    init(_ data: String, viewBox: CGSize) {
        self.data = data
        self.viewBox = viewBox
    }

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        return SVGPath.cached(data).applying(CGAffineTransform(scaleX: scale, y: scale).translatedBy(x: rect.minX / scale, y: rect.minY / scale))
    }
}

enum SVGPath {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var parsed: [String: Path] = [:]

    /// Each path parsed once, however often it is drawn.
    static func cached(_ data: String) -> Path {
        lock.lock()
        defer { lock.unlock() }
        if let path = parsed[data] { return path }
        let path = parse(data)
        parsed[data] = path
        return path
    }

    /// Parses absolute M, L, H, V, C and Z commands.
    static func parse(_ data: String) -> Path {
        var path = Path()
        var tokens = Tokens(data)
        var current = CGPoint.zero
        var command: Character = "M"
        while let next = tokens.next() {
            if case .command(let c) = next {
                command = c
                if c == "Z" {
                    path.closeSubpath()
                    continue
                }
            } else {
                tokens.pushBack(next)
            }
            switch command {
            case "M":
                guard let x = tokens.number(), let y = tokens.number() else { return path }
                current = CGPoint(x: x, y: y)
                path.move(to: current)
                command = "L"
            case "L":
                guard let x = tokens.number(), let y = tokens.number() else { return path }
                current = CGPoint(x: x, y: y)
                path.addLine(to: current)
            case "H":
                guard let x = tokens.number() else { return path }
                current = CGPoint(x: x, y: current.y)
                path.addLine(to: current)
            case "V":
                guard let y = tokens.number() else { return path }
                current = CGPoint(x: current.x, y: y)
                path.addLine(to: current)
            case "C":
                guard let x1 = tokens.number(), let y1 = tokens.number(),
                      let x2 = tokens.number(), let y2 = tokens.number(),
                      let x = tokens.number(), let y = tokens.number() else { return path }
                current = CGPoint(x: x, y: y)
                path.addCurve(to: current, control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            default:
                return path
            }
        }
        return path
    }

    private enum Token {
        case command(Character)
        case number(CGFloat)
    }

    private struct Tokens {
        private let scalars: [Character]
        private var index = 0
        private var pushed: Token?

        init(_ data: String) { scalars = Array(data) }

        mutating func pushBack(_ token: Token) { pushed = token }

        mutating func number() -> CGFloat? {
            guard case .number(let value)? = next() else { return nil }
            return value
        }

        mutating func next() -> Token? {
            if let pushed {
                self.pushed = nil
                return pushed
            }
            while index < scalars.count, scalars[index] == " " || scalars[index] == "," { index += 1 }
            guard index < scalars.count else { return nil }
            let character = scalars[index]
            if character.isLetter {
                index += 1
                return .command(character)
            }
            var text = ""
            while index < scalars.count {
                let c = scalars[index]
                let startsNumber = text.isEmpty && (c == "-" || c == "+")
                let exponentSign = (c == "-" || c == "+") && (text.last == "e" || text.last == "E")
                if c.isNumber || c == "." || c == "e" || c == "E" || startsNumber || exponentSign {
                    // A second dot or a sign starts the next number ("0.5.5", "1-2").
                    if c == "." && text.contains(".") && !text.contains("e") { break }
                    text.append(c)
                    index += 1
                } else if (c == "-" || c == "+") && !text.isEmpty {
                    break
                } else {
                    break
                }
            }
            return Double(text).map { .number(CGFloat($0)) }
        }
    }
}

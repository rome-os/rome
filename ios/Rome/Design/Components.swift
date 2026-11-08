import SwiftUI
import UIKit

/// The 44 pt round glass button the headers use (menu, tasks, back, more).
struct GlassCircleButton<Label: View>: View {
    let accessibilityLabel: LocalizedStringKey
    let action: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        Button(action: action) {
            label()
                .foregroundStyle(Palette.fg)
                .frame(width: 44, height: 44)
                .glassSurface(Circle(), interactive: true)
                .contentShape(Circle())
        }
        .buttonStyle(GlassPressStyle())
        .accessibilityLabel(accessibilityLabel)
    }
}

/// The on-screen keyboard.
enum Keyboard {
    /// Takes focus from whatever field has it; the text it holds stays.
    @MainActor static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Scroll views of the app.
enum Scrolling {
    /// Stops every glide where it is, as a finger on the list would: for
    /// touches that land on something above the list, such as the drawer's
    /// edge, which the scroll view never sees.
    @MainActor static func stopGlides() {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows { stop(in: window) }
        }
    }

    @MainActor private static func stop(in view: UIView) {
        if let scroll = view as? UIScrollView, scroll.isDecelerating {
            scroll.setContentOffset(scroll.contentOffset, animated: false)
        }
        for subview in view.subviews { stop(in: subview) }
    }
}

/// How much page color lies on a floating control's glass: enough that
/// text scrolling behind is softened, light enough that the glass shows.
enum Frost {
    /// The composer, and the controls that sit with it.
    static var composer: Double {
        #if DEBUG
        // Side-by-side checks of strengths, from the scheme or simctl.
        if let value = ProcessInfo.processInfo.environment["ROME_FROST"].flatMap(Double.init) { return value }
        #endif
        return 0.3
    }
}

extension View {
    /// The system glass behind a floating control: Liquid Glass on iOS 26 and
    /// later, a thin material with a hairline before it. `frost` lays the
    /// page's color lightly on top, the glass's edge and blur still showing.
    @ViewBuilder
    func glassSurface<S: InsettableShape>(_ shape: S, interactive: Bool = false, frost: Double = 0) -> some View {
        if #available(iOS 26, *) {
            // A fill above the glass, not its tint: iOS 27 draws a tinted
            // glass far clearer than iOS 26, a fill looks the same on both.
            background(Palette.bg.opacity(frost), in: shape)
                .glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(Palette.bg.opacity(frost), in: shape)
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.strokeBorder(Palette.hair, lineWidth: 0.5))
                .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
        }
    }

    /// A bar pinned to the top that the content scrolls under. On iOS 26 and
    /// later the system softens the content's edge beneath it.
    @ViewBuilder
    func floatingTopBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .top, spacing: 0, content: bar)
        } else {
            safeAreaInset(edge: .top, spacing: 0, content: bar)
        }
    }
}

/// Behind a header whose title has no pill: the page's color from the top
/// down to just below the header, so rows scrolling under never show through
/// the title.
private struct HeaderFade: ViewModifier {
    @Environment(\.pageBackground) private var page

    func body(content: Content) -> some View {
        content.background(alignment: .top) {
            LinearGradient(
                stops: [
                    .init(color: page, location: 0),
                    .init(color: page, location: 0.62),
                    .init(color: page.opacity(0), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .padding(.bottom, -22)
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        }
    }
}

extension View {
    /// A page-colored fade behind a header with a plain title.
    func headerFade() -> some View { modifier(HeaderFade()) }

    /// Fades scrolled content gradually under a floating top bar, instead of
    /// the hard cut-off line the system can choose.
    @ViewBuilder
    func softTopScrollEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

/// The press on a glass control: interactive glass answers the touch itself on
/// iOS 26 and later; before that, the usual scale-and-dim.
struct GlassPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        if #available(iOS 26, *) {
            configuration.label
        } else {
            configuration.label
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .opacity(configuration.isPressed ? 0.85 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
        }
    }
}

/// A light scale-and-dim press, used on every custom tappable surface.
struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.96

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// A row press: the background darkens instead of the content scaling.
struct RowPressStyle: ButtonStyle {
    var pressed: Color = Palette.pressed

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? pressed : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// The design's spinner: a faint ring with a quarter arc turning on it.
struct Spinner: View {
    var size: CGFloat = 18
    var lineWidth: CGFloat = 2.2
    var color: Color = Palette.running
    var trackOpacity: Double = 0.22
    @State private var turning = false

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(trackOpacity), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: 0.25)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(turning ? 360 : 0))
        }
        .frame(width: size, height: size)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turning = true }
        }
        .accessibilityHidden(true)
    }
}

/// Three dots that rise in turn: the agent is writing.
struct TypingDots: View {
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation) { context in
            let elapsed = context.date.timeIntervalSince(start)
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    let phase = ((elapsed - Double(index) * 0.18).truncatingRemainder(dividingBy: 1.3) + 1.3)
                        .truncatingRemainder(dividingBy: 1.3) / 1.3
                    let lift = phase < 0.4 ? phase / 0.4 : (phase < 0.8 ? 1 - (phase - 0.4) / 0.4 : 0)
                    Circle()
                        .fill(Palette.sub)
                        .frame(width: 7, height: 7)
                        .opacity(0.25 + 0.75 * lift)
                        .offset(y: -1.5 * lift)
                }
            }
        }
        .padding(.horizontal, 15)
        .frame(height: 38)
        .background(Palette.bubble, in: Capsule())
        .accessibilityElement()
        .accessibilityLabel("Typing")
    }
}

/// The four ways a task can look, shared by the task card, the Tasks sheet and the task chat header.
enum TaskTone: Sendable {
    case needsYou, running, failed, done, neutral

    var label: String {
        switch self {
        case .needsYou: return String(localized: "Needs you")
        case .running: return String(localized: "Working")
        case .failed: return String(localized: "Failed")
        case .done: return String(localized: "Done")
        case .neutral: return ""
        }
    }

    var text: Color {
        switch self {
        case .needsYou: return Palette.warningText
        case .running: return Palette.runningText
        case .failed: return Palette.destructive
        case .done, .neutral: return Palette.sub
        }
    }

    var soft: Color {
        switch self {
        case .needsYou: return Palette.warnSoft
        case .running: return Palette.runningSoft
        case .failed: return Palette.dangerSoft
        case .done, .neutral: return Palette.fill
        }
    }

    var dot: Color {
        switch self {
        case .needsYou: return Palette.warning
        case .running: return Palette.running
        case .failed: return Palette.destructive
        case .done: return Palette.success
        case .neutral: return Palette.sub
        }
    }
}

/// The filled round status icon in Tasks rows.
struct StatusGlyph: View {
    let tone: TaskTone
    var size: CGFloat = 18

    var body: some View {
        Group {
            switch tone {
            case .running:
                Spinner(size: size, lineWidth: 2.2, color: Palette.running)
            case .needsYou:
                ZStack {
                    Circle().fill(Palette.warning)
                    Image(systemName: "exclamationmark")
                        .font(.system(size: size * 0.55, weight: .heavy))
                        .foregroundStyle(Color(red: 0.1, green: 0.075, blue: 0.06))
                }
            case .failed:
                ZStack {
                    Circle().fill(Palette.destructive)
                    Image(systemName: "xmark")
                        .font(.system(size: size * 0.45, weight: .bold))
                        .foregroundStyle(.white)
                }
            case .done:
                ZStack {
                    Circle().fill(Palette.success)
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.48, weight: .bold))
                        .foregroundStyle(.white)
                }
            case .neutral:
                Circle().strokeBorder(Palette.sub, lineWidth: 1.6)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(tone.label)
    }
}

/// A small filled red circle with "!" — failure markers on bubbles and banners.
struct AlertGlyph: View {
    var size: CGFloat = 16
    var color: Color = Palette.destructive

    var body: some View {
        ZStack {
            Circle().fill(color)
            Image(systemName: "exclamationmark")
                .font(.system(size: size * 0.6, weight: .heavy))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The capsule banner under the header: offline, session expired, first-open hint.
struct TopBanner: View {
    enum Kind { case warning, error, info }

    let kind: Kind
    let text: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 7) {
            switch kind {
            case .warning:
                Image(systemName: "wifi.slash").romeFont(14, .semibold)
            case .error:
                AlertGlyph(size: 15)
            case .info:
                Image(systemName: "arrow.left.arrow.right").romeFont(13, .semibold)
            }
            Text(text).romeFont(14, .medium)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .romeFont(13, .semibold)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .background(Palette.destructive, in: Capsule())
                    .buttonStyle(PressScaleStyle())
            }
        }
        .foregroundStyle(foreground)
        .padding(.leading, 12)
        .padding(.trailing, actionTitle == nil ? 14 : 4)
        .frame(minHeight: 34)
        .background(background, in: Capsule())
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private var foreground: Color {
        switch kind {
        case .warning: return Palette.warningText
        case .error: return Palette.destructive
        case .info: return Palette.fg
        }
    }

    private var background: Color {
        switch kind {
        case .warning: return Palette.warnSoft
        case .error: return Palette.dangerSoft
        case .info: return Palette.elevated.opacity(0.9)
        }
    }
}

/// The signed-in person's avatar, as the web dashboard draws it: their Rome
/// Cloud picture, else the initial of their name on the primary tint.
struct InitialAvatar: View {
    let text: String
    var imageURL: URL? = nil
    /// Whose disk cache the picture lives in: the open instance's host.
    var instance: String = ""
    var size: CGFloat = 40
    @State private var image: UIImage?

    init(text: String, imageURL: URL? = nil, instance: String = "", size: CGFloat = 40) {
        self.text = text
        self.imageURL = imageURL
        self.instance = instance
        self.size = size
        // Last time's picture from disk, in the first frame.
        _image = State(initialValue: imageURL.flatMap { CachedImage.cached(instance: instance, key: Self.cacheKey($0)) })
    }

    static func cacheKey(_ url: URL) -> String { "avatar-" + ImageDiskCache.hash(Data(url.absoluteString.utf8)).prefix(16) }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: imageURL) {
            guard let url = imageURL else { image = nil; return }
            let key = Self.cacheKey(url)
            if image == nil { image = CachedImage.cached(instance: instance, key: key) }
            // Checked again in the background; replaced only when it changed.
            let side = size
            if let fresh = await CachedImage.refresh(
                instance: instance, key: key, version: nil,
                fetch: { try await URLSession.shared.data(from: url).0 },
                draw: { data in Self.drawn(data, side: side) }
            ) {
                image = fresh
            }
        }
    }

    /// The picture at the size it shows, so the cache holds no more than that.
    private static func drawn(_ data: Data, side: CGFloat) -> UIImage? {
        guard let source = UIImage(data: data) else { return nil }
        let size = CGSize(width: side, height: side)
        let scale = max(size.width / source.size.width, size.height / source.size.height)
        let drawSize = CGSize(width: source.size.width * scale, height: source.size.height * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in
            source.draw(in: CGRect(x: (side - drawSize.width) / 2, y: (side - drawSize.height) / 2, width: drawSize.width, height: drawSize.height))
        }
    }

    private var initial: some View {
        Text(String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(size: size * 0.4, weight: .bold))
            .foregroundStyle(Palette.primaryText)
            .frame(width: size, height: size)
            .background(Palette.primarySoft, in: Circle())
    }
}

extension View {
    /// Light haptic on tap-like actions.
    func hapticTap<T: Equatable>(_ trigger: T) -> some View {
        sensoryFeedback(.impact(weight: .light), trigger: trigger)
    }
}

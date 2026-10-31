import SwiftUI

/// The 44 pt round glass button the headers use (menu, tasks, back, more).
struct GlassCircleButton<Label: View>: View {
    let accessibilityLabel: String
    let action: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        Button(action: action) {
            label()
                .foregroundStyle(Palette.fg)
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
                .background(Palette.glass, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(accessibilityLabel)
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
        .accessibilityLabel("正在回复")
    }
}

/// The four ways a task can look, shared by the task card, the Tasks sheet and the task chat header.
enum TaskTone: Sendable {
    case needsYou, running, failed, done, neutral

    var label: String {
        switch self {
        case .needsYou: return "等你处理"
        case .running: return "进行中"
        case .failed: return "失败"
        case .done: return "已完成"
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

/// A small status capsule: a dot (or spinner) and a word.
struct StatusPill: View {
    let tone: TaskTone
    var label: String? = nil
    var compact = true

    var body: some View {
        HStack(spacing: 5) {
            if tone == .running {
                Spinner(size: compact ? 10 : 12, lineWidth: 2.4, color: tone.text, trackOpacity: 0.3)
            } else {
                Circle().fill(tone.dot).frame(width: compact ? 6 : 7, height: compact ? 6 : 7)
            }
            Text(label ?? tone.label)
                .romeFont(compact ? 12 : 13, .semibold)
                .foregroundStyle(tone.text)
        }
        .padding(.horizontal, compact ? 8 : 10)
        .frame(height: compact ? 22 : 28)
        .background(tone.soft, in: Capsule())
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

/// "即将推出".
struct ComingSoonTag: View {
    var body: some View {
        Text("即将推出")
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Palette.fill, in: Capsule())
    }
}

/// Initial-letter avatar on the primary tint.
struct InitialAvatar: View {
    let text: String
    var size: CGFloat = 40

    var body: some View {
        Text(String(text.prefix(1)).uppercased())
            .font(.system(size: size * 0.4, weight: .bold))
            .foregroundStyle(Palette.primaryText)
            .frame(width: size, height: size)
            .background(Palette.primarySoft, in: Circle())
            .accessibilityHidden(true)
    }
}

extension View {
    /// Light haptic on tap-like actions.
    func hapticTap<T: Equatable>(_ trigger: T) -> some View {
        sensoryFeedback(.impact(weight: .light), trigger: trigger)
    }
}

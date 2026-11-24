import SwiftUI
import UIKit

/// Starts a voice conversation in this chat. Sits beside the voice input microphone.
struct VoiceConversationButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "waveform")
                .romeFont(17, .medium)
                .foregroundStyle(Palette.sub)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .accessibilityLabel("Voice conversation")
        .accessibilityIdentifier("voice-conversation")
    }
}

/// Mutes the microphone during a voice conversation: the microphone, struck
/// through and filled while muted.
struct VoiceConversationMuteButton: View {
    let muted: Bool
    let action: () -> Void

    private var label: LocalizedStringKey { muted ? "Unmute" : "Mute" }

    var body: some View {
        Button(action: action) {
            Image(systemName: muted ? "mic.slash.fill" : "mic")
                .romeFont(17, .medium)
                .foregroundStyle(muted ? Palette.bg : Palette.sub)
                .frame(width: 36, height: 36)
                .background(muted ? Palette.fg : Color.clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .accessibilityLabel(label)
        .accessibilityAddTraits(muted ? .isSelected : [])
        .accessibilityIdentifier("voice-conversation-mute")
    }
}

/// Ends the voice conversation.
struct VoiceConversationEndButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("End")
                .romeFont(15, .semibold)
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .frame(height: 36)
                .background(Palette.primary, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressScaleStyle(scale: 0.95))
        .accessibilityIdentifier("voice-conversation-end")
    }
}

/// Why the last voice conversation ended on its own, above the field. A
/// blocked microphone's line opens the app's page in Settings.
struct VoiceConversationNotice: View {
    let reason: VoiceConversationStopReason

    var body: some View {
        Group {
            if reason == .microphoneBlocked, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settings) { line }
            } else {
                line
            }
        }
        .accessibilityIdentifier("voice-conversation-notice")
    }

    private var line: some View {
        Text(verbatim: reason.notice)
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The capsule above the message field during a voice conversation: the
/// Rome mascot and a row of bars, on the composer's glass with no edge.
/// Listening, the bars follow the guardian's microphone in the text color;
/// speaking, they follow Rome's voice in the accent color; thinking, a slow
/// wave runs over low dots; muted, the capsule turns grey and the bars rest.
/// With Reduce Motion the bars stay still and only the color changes, as on
/// the dashboard.
struct VoiceConversationCapsule: View {
    let state: VoiceConversationState
    let muted: Bool
    /// Read once a frame.
    let level: @MainActor () -> Float

    static let height: CGFloat = 48
    static let barsSize = CGSize(width: 108, height: 28)
    static let barWidth: CGFloat = 4
    /// Each bar's share of the loudness, so the row reads as a voice rather than a meter.
    static let shape: [CGFloat] = [0.5, 0.75, 1, 0.82, 0.95, 0.7, 0.55, 0.85, 0.62, 0.72, 0.48, 0.58, 0.36, 0.3]

    enum Shown: Equatable { case listening, thinking, speaking, muted }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.offScreen) private var offScreen
    @State private var easing = LevelEasing()

    private var shown: Shown {
        if muted { return .muted }
        switch state {
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .speaking
        }
    }

    private var barColor: Color {
        switch shown {
        case .speaking: Palette.primary
        case .muted: Palette.faint
        case .listening, .thinking: Palette.fg
        }
    }

    private var stateLabel: String {
        switch shown {
        case .listening: String(localized: "Listening")
        case .thinking: String(localized: "Thinking")
        case .speaking: String(localized: "Speaking")
        case .muted: String(localized: "Muted")
        }
    }

    var body: some View {
        let shown = shown
        let color = barColor
        HStack(spacing: 12) {
            Mascot()
                .frame(width: 22)
                .opacity(shown == .muted ? 0.4 : 1)
            TimelineView(.animation(paused: offScreen || reduceMotion)) { timeline in
                Canvas { context, size in
                    let reading = shown == .listening || shown == .speaking ? level() : 0
                    let values = Self.values(shown, at: timeline.date.timeIntervalSinceReferenceDate,
                                             eased: easing.next(reading), still: reduceMotion)
                    Self.draw(values, in: &context, size: size, color: color, dimmed: shown == .thinking)
                }
            }
            .frame(width: Self.barsSize.width, height: Self.barsSize.height)
        }
        .padding(.horizontal, 16)
        .frame(height: Self.height)
        .glassSurface(Capsule(), frost: Frost.composer)
        .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
        .animation(.easeOut(duration: 0.2), value: shown)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stateLabel)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("voice-conversation-capsule")
    }

    /// Each bar's height, 0 to 1, at `time` seconds. `eased` is the loudness
    /// eased toward each new reading, so a syllable rises and falls.
    static func values(_ shown: Shown, at time: TimeInterval, eased: Float, still: Bool) -> [CGFloat] {
        shape.enumerated().map { index, share in
            let i = CGFloat(index)
            let t = CGFloat(time)
            if still { return shown == .muted ? 0 : share * 0.5 }
            switch shown {
            case .muted: return 0
            case .thinking:
                let wave = 0.5 + 0.5 * sin(t * 2.4 - i * 0.5)
                return 0.12 + 0.3 * wave * wave
            case .listening, .speaking:
                return CGFloat(eased).squareRoot() * share * (0.7 + 0.3 * sin(t * (8 + i * 0.7) + i * 1.9))
            }
        }
    }

    /// Round-ended bars spread across `size`, each at least a dot.
    static func draw(_ values: [CGFloat], in context: inout GraphicsContext, size: CGSize, color: Color, dimmed: Bool) {
        guard values.count > 1 else { return }
        let gap = (size.width - CGFloat(values.count) * barWidth) / CGFloat(values.count - 1)
        context.opacity = dimmed ? 0.6 : 1
        for (index, value) in values.enumerated() {
            let height = barWidth + (size.height - barWidth) * min(1, max(0, value))
            let rect = CGRect(x: CGFloat(index) * (barWidth + gap), y: (size.height - height) / 2, width: barWidth, height: height)
            context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(color))
        }
    }
}

/// The loudness eased from frame to frame; a class so drawing a frame can
/// move it without redrawing the view.
final class LevelEasing {
    private var value: Float = 0

    func next(_ reading: Float) -> Float {
        value += (reading - value) * 0.35
        return value
    }
}

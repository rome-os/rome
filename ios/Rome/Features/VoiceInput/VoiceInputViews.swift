import SwiftUI
import UIKit

/// The microphone beside the message field: one tap starts listening, one stops it.
struct VoiceInputButton: View {
    let state: VoiceInputController.State
    let action: () -> Void

    private var label: LocalizedStringKey {
        switch state {
        case .idle: "Start voice input"
        case .listening: "Stop voice input"
        case .finishing: "Finishing voice input"
        }
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: state == .listening ? "stop.circle.fill" : "mic")
                .romeFont(17, .medium)
                .foregroundStyle(state == .listening ? Palette.primary : Palette.sub)
                .opacity(state == .finishing ? 0.5 : 1)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .disabled(state == .finishing)
        .accessibilityLabel(label)
        .accessibilityAddTraits(state == .listening ? .isSelected : [])
        .accessibilityIdentifier("voice-input")
    }
}

/// Why listening stopped on its own, above the field. A blocked microphone's
/// notice opens the app's page in Settings.
struct VoiceInputNotice: View {
    let stop: VoiceInputStop

    var body: some View {
        Group {
            if stop.reason == .microphoneBlocked, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settings) { line }
            } else {
                line
            }
        }
        .accessibilityIdentifier("voice-input-notice")
    }

    private var line: some View {
        Text(verbatim: stop.notice)
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The microphone's recent sound as bars scrolling in from the right, so the
/// guardian sees voice input hears them. It scrolls while audio comes in, and
/// silence draws only flat dots, so a bar that rises means sound. Decoration
/// only: the voice control says whether it listens.
struct VoiceInputWaveform: View {
    let meter: VoiceLevelMeter

    static let height: CGFloat = 28
    static let barWidth: CGFloat = 3
    static let gap: CGFloat = 2
    /// Loudness below this is a quiet room, not speech.
    static let silence: Float = 0.02

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bars = Bars()

    var body: some View {
        // Fewer, slower steps when the guardian asks for less motion.
        let steps = reduceMotion ? 4 : 1
        TimelineView(.periodic(from: .now, by: 0.05 * Double(steps))) { timeline in
            Canvas { context, size in
                bars.advance(to: timeline.date, meter: meter, steps: steps)
                Self.draw(bars.values, in: &context, size: size)
            }
        }
        .frame(height: Self.height)
        .foregroundStyle(Palette.primary)
        .accessibilityHidden(true)
        .accessibilityIdentifier("voice-input-waveform")
    }

    /// The newest bar at the right edge, each older one a step to the left and
    /// fainter, down to 25% at the left edge. A quiet bar is a dot.
    static func draw(_ values: [Float], in context: inout GraphicsContext, size: CGSize) {
        let pitch = barWidth + gap
        let capacity = max(1, Int((size.width / pitch).rounded(.up)))
        for index in 0..<capacity {
            let x = size.width - CGFloat(index + 1) * pitch + gap
            guard x + barWidth > 0 else { break }
            let value = index < values.count ? values[values.count - 1 - index] : 0
            let barHeight = max(barWidth, CGFloat(value) * size.height)
            let rect = CGRect(x: x, y: (size.height - barHeight) / 2, width: barWidth, height: barHeight)
            var bar = context
            bar.opacity = max(0.25, 1 - Double(index) / Double(capacity) * 0.75)
            bar.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .foreground)
        }
    }

    /// The bars drawn so far, oldest first. A reference type, so that stepping
    /// while drawing does not redraw the view.
    final class Bars {
        private(set) var values: [Float] = []
        private var steppedAt: Date?

        /// Takes one step of the meter for each 50 ms since the last, at most
        /// `steps` at once, and adds a bar for the loudest. Silence adds a dot.
        func advance(to now: Date, meter: VoiceLevelMeter, steps: Int) {
            if let steppedAt, now.timeIntervalSince(steppedAt) < 0.045 * Double(steps) { return }
            steppedAt = now
            var peak: Float?
            for _ in 0..<steps {
                guard let step = meter.next() else { break }
                peak = max(peak ?? 0, step)
            }
            guard let peak else { return }
            values.append(peak > VoiceInputWaveform.silence ? peak : 0)
            // The last 5 s, whatever the width.
            if values.count > 100 { values.removeFirst(values.count - 100) }
        }
    }
}

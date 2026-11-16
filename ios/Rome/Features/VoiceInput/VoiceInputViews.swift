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
                .foregroundStyle(Palette.sub)
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

/// The microphone's recent sound as bars scrolling in from the right, across
/// the message field's bottom row, so the guardian sees voice input hears them. It scrolls while audio comes in, and
/// silence draws only flat dots, so a bar that rises means sound. Decoration
/// only: the voice control says whether it listens.
struct VoiceInputWaveform: View {
    let meter: VoiceLevelMeter

    static let height: CGFloat = 28
    static let barWidth: CGFloat = 3
    static let gap: CGFloat = 3
    /// A quiet step is a dot this wide.
    static let dot: CGFloat = 2
    /// Loudness below this is a quiet room, not speech.
    static let silence: Float = 0.02

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bars = Bars()

    var body: some View {
        // Fewer, slower steps that jump rather than slide when the guardian
        // asks for less motion.
        let steps = reduceMotion ? 4 : 1
        TimelineView(.animation(minimumInterval: reduceMotion ? 0.2 : nil)) { timeline in
            Canvas { context, size in
                let now = timeline.date
                bars.advance(to: now, meter: meter, steps: steps)
                Self.draw(bars.values, in: &context, size: size, slide: reduceMotion ? 0 : bars.slide(at: now))
            }
        }
        .frame(height: Self.height)
        // The oldest steps fade out at the left edge.
        .mask {
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12)],
                           startPoint: .leading, endPoint: .trailing)
        }
        .accessibilityHidden(true)
        .accessibilityIdentifier("voice-input-waveform")
    }

    /// The newest step at the right edge, each older one a step to the left.
    /// Sound is a bar in the text color; a quiet step is a dimmer dot.
    /// `slide`, 0 to 1, is how much of a step the newest still has to travel
    /// in from the right, so the row moves smoothly between steps.
    static func draw(_ values: [Float], in context: inout GraphicsContext, size: CGSize, slide: CGFloat = 0) {
        let pitch = barWidth + gap
        let capacity = max(1, Int((size.width / pitch).rounded(.up)))
        // A row of dots shifted by a whole step looks the same, so silence
        // holds one steady image instead of sliding.
        let slide = values.suffix(capacity + 1).allSatisfy { $0 == 0 } ? 0 : slide
        for index in 0..<capacity {
            let x = size.width - CGFloat(index + 1) * pitch + gap + slide * pitch
            guard x + barWidth > 0 else { break }
            let value = index < values.count ? values[values.count - 1 - index] : 0
            if value > 0 {
                let barHeight = max(barWidth, CGFloat(value) * size.height)
                let rect = CGRect(x: x, y: (size.height - barHeight) / 2, width: barWidth, height: barHeight)
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(Palette.fg))
            } else {
                let rect = CGRect(x: x + (barWidth - dot) / 2, y: (size.height - dot) / 2, width: dot, height: dot)
                context.fill(Path(ellipseIn: rect), with: .color(Palette.sub))
            }
        }
    }

    /// The bars drawn so far, oldest first. A reference type, so that stepping
    /// while drawing does not redraw the view.
    final class Bars {
        private(set) var values: [Float] = []
        private var steppedAt: Date?

        /// How much of a step the newest bar still has to slide in, 1 just
        /// after it is added and 0 once 50 ms have passed.
        func slide(at now: Date) -> CGFloat {
            guard let steppedAt else { return 0 }
            return CGFloat(max(0, 1 - now.timeIntervalSince(steppedAt) / 0.05))
        }

        /// When the next step is due. Steps keep their own 50 ms beat, so a
        /// slower or uneven frame rate takes every due step and none is lost.
        private var nextDue: Date?

        /// Takes each step of the meter due by `now`, `steps` readings a bar,
        /// and adds a bar for the loudest of each. Silence adds a dot.
        func advance(to now: Date, meter: VoiceLevelMeter, steps: Int) {
            let period = 0.05 * Double(steps)
            var due = nextDue ?? now
            // A millisecond's slack for timestamps that land a hair early.
            while now.timeIntervalSince(due) >= -0.001 {
                var peak: Float?
                for _ in 0..<steps {
                    guard let step = meter.next() else { break }
                    peak = max(peak ?? 0, step)
                }
                // No audio yet: wait for it without owing steps.
                guard let peak else {
                    nextDue = now
                    return
                }
                add(peak, steps: steps)
                steppedAt = due
                due += period
            }
            nextDue = due
        }

        private func add(_ peak: Float, steps: Int) {
            values.append(peak > VoiceInputWaveform.silence ? peak : 0)
            // The last 5 s, whatever the width: each value holds `steps` of 50 ms.
            let kept = 100 / steps
            if values.count > kept { values.removeFirst(values.count - kept) }
        }
    }
}

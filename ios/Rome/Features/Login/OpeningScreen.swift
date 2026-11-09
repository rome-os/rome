import SwiftUI

/// While the app opens an instance: the mascot, alive, in the middle of the
/// screen exactly where the launch screen drew it, "Rome" under it, and three
/// pulsing dots. VoiceOver reads "Opening your Rome".
struct OpeningScreen: View {
    static var accessibilityText: String { String(localized: "Opening your Rome") }

    @State private var wordmarkShown = false

    var body: some View {
        ZStack {
            Palette.bg
            Mascot(alive: true)
                .frame(width: Mascot.width)
                .overlay(alignment: .top) {
                    // Hung below the logo, so the logo stays where the launch screen had it.
                    VStack(spacing: 12) {
                        Text(verbatim: "Rome")
                            .romeFont(22, .medium)
                            .tracking(-0.4)
                            .foregroundStyle(Palette.fg)
                        LoadingDots()
                    }
                    .fixedSize()
                    .offset(y: Mascot.width * Mascot.viewBox.height / Mascot.viewBox.width + 20)
                    .opacity(wordmarkShown ? 1 : 0)
                }
        }
        .ignoresSafeArea()
        .onAppear { withAnimation(.easeOut(duration: 0.4)) { wordmarkShown = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityText)
    }
}

/// Three dots that light up one after another.
struct LoadingDots: View {
    var body: some View {
        TimelineView(.animation(paused: Self.frozen)) { context in
            let time = Self.frozen ? 0 : context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Palette.sub)
                        .frame(width: 6, height: 6)
                        .opacity(Self.opacity(at: time, index: index))
                }
            }
        }
    }

    /// Each dot brightens for a third of a 1.2 s cycle, in order.
    static func opacity(at time: TimeInterval, index: Int) -> Double {
        let phase = (time / 1.2 - Double(index) / 3).truncatingRemainder(dividingBy: 1)
        let wave = 0.5 + 0.5 * cos(2 * .pi * (phase < 0 ? phase + 1 : phase))
        return 0.25 + 0.75 * wave
    }

    /// Snapshot runs draw a still frame.
    private static var frozen: Bool {
        #if DEBUG
        SnapshotRunner.directory != nil
        #else
        false
        #endif
    }
}

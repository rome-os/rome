import SwiftUI

/// Something to ask the Concierge, offered above the composer of an empty chat.
struct Suggestion: Identifiable, Hashable, Sendable {
    let id: String
    let systemImage: String
    /// Sent as the guardian's message, in the app's language.
    let text: String

    static var all: [Suggestion] {
        [
            Suggestion(id: "trip", systemImage: "point.topleft.down.to.point.bottomright.curvepath", text: String(localized: "Plan my weekend trip and check the weather")),
            Suggestion(id: "gmail", systemImage: "envelope", text: String(localized: "Watch my Gmail inbox for me")),
            Suggestion(id: "watch", systemImage: "dot.radiowaves.left.and.right", text: String(localized: "What can you watch for me?")),
        ]
    }
}

/// The starters a Concierge chat shows while it has no messages: one row
/// each, and a tap sends that exact text.
struct ConciergeStarters: View {
    let onPick: (Suggestion) -> Void

    /// Only before the chat has anything in it, a message being sent included.
    static func visible(loaded: Bool, rows: [TranscriptRow]) -> Bool {
        loaded && rows.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Suggestion.all) { suggestion in
                Button { onPick(suggestion) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: suggestion.systemImage)
                            .romeFont(14, .medium)
                            .foregroundStyle(Palette.sub)
                            .frame(width: 22)
                            .accessibilityHidden(true)
                        Text(verbatim: suggestion.text)
                            .romeFont(15)
                            .foregroundStyle(Palette.fg)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Palette.elevated.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .hairline(radius: 14)
                    .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(PressScaleStyle(scale: 0.98))
                .accessibilityHint("Sends this message")
            }
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

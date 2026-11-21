import SwiftUI

/// Chat's one quiet offer to turn notifications on, under the header.
struct PushPromptCard: View {
    let onTurnOn: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge")
                    .romeFont(15)
                    .foregroundStyle(Palette.primaryIcon)
                    .frame(width: 34, height: 34)
                    .background(Palette.primarySoft, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Turn on notifications")
                        .romeFont(15, .semibold)
                        .foregroundStyle(Palette.fg)
                    Text("Results, questions and reminders")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Spacer()
                Button(action: onNotNow) {
                    Text("Not now")
                        .romeFont(15, .medium)
                        .foregroundStyle(Palette.sub)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 36)
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                Button(action: onTurnOn) {
                    Text("Turn on")
                        .romeFont(15, .medium)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 36)
                        .background(Palette.primary, in: Capsule())
                }
                .buttonStyle(PressScaleStyle())
            }
        }
        .padding(14)
        // Raised off the page, as a card is, in light and dark alike.
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
        .shadow(color: Palette.cardShadow, radius: 12, x: 0, y: 4)
    }
}

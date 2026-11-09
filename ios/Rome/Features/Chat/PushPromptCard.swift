import SwiftUI

/// Chat's one quiet offer to turn notifications on, under the header.
struct PushPromptCard: View {
    let onTurnOn: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge")
                    .romeFont(15, .semibold)
                    .foregroundStyle(Palette.primaryIcon)
                    .frame(width: 34, height: 34)
                    .background(Palette.primarySoft, in: Circle())
                    .accessibilityHidden(true)
                Text("Get notified when Rome has something for you")
                    .romeFont(15, .medium)
                    .foregroundStyle(Palette.fg)
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
                        .romeFont(15, .semibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 36)
                        .background(Palette.primary, in: Capsule())
                }
                .buttonStyle(PressScaleStyle())
            }
        }
        .padding(14)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .softElevation(radius: Metrics.cardRadius)
    }
}

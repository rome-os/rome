import SwiftUI

/// Slides down when the open Rome has a release it can do without: Update
/// opens the update page, the cross closes it for that release.
struct UpdateBanner: View {
    let onUpdate: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.down.circle")
                .romeFont(15, .semibold)
                .foregroundStyle(Palette.primaryText)
            Text("A new version of Rome is available")
                .romeFont(14, .medium)
                .foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: onUpdate) {
                Text("Update")
                    .romeFont(13, .semibold)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .background(Palette.primary, in: Capsule())
            }
            .buttonStyle(PressScaleStyle())
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .romeFont(12, .semibold)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(Text("Close"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(Palette.elevated.opacity(0.9), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .softElevation(radius: 20)
        .padding(.horizontal, Metrics.pagePadding)
    }
}

/// The drawer's quiet line above the account row while the open Rome is
/// behind; it opens the update page.
struct DrawerUpdateRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle")
                    .romeFont(14, .medium)
                Text("New version available")
                    .romeFont(14)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
    }
}

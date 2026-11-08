import SwiftUI

/// Words that name the Rome being updated, so no one reads them as an update
/// to this app. A long name is cut in the middle, keeping each line to one.
enum UpdateCopy {
    static let nameLimit = 18

    static func shortName(_ name: String, limit: Int = nameLimit) -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.count > limit else { return name }
        let head = (limit - 1) / 2 + (limit - 1) % 2, tail = (limit - 1) / 2
        return String(name.prefix(head)) + "…" + String(name.suffix(tail))
    }

    static func banner(_ name: String) -> String { String(localized: "\(shortName(name)) has an update") }
    static func action(_ name: String) -> String { String(localized: "Update \(shortName(name))") }
}

/// Slides down when the open Rome has a release it can do without: Update
/// opens the update page, the cross closes it for that release.
struct UpdateBanner: View {
    let instanceName: String
    let onUpdate: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.down.circle")
                .romeFont(15, .semibold)
                .foregroundStyle(Palette.primaryText)
            Text(verbatim: UpdateCopy.banner(instanceName))
                .romeFont(14, .medium)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
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

/// The drawer's one row that asks for action while the open Rome is behind:
/// the accent on a light tint, shaped like the drawer's rows, never raised
/// like the selected one. It opens the update page.
struct DrawerUpdateRow: View {
    let instanceName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.down.circle")
                    .romeFont(16, .medium)
                    .frame(width: 22)
                Text(verbatim: UpdateCopy.action(instanceName))
                    .romeFont(15, .medium)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .romeFont(12, .semibold)
            }
            .foregroundStyle(Palette.primaryText)
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
    }
}

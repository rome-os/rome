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
    static func updated(_ name: String, version: String) -> String { String(localized: "\(shortName(name)) updated to \(version)") }

    /// The Agent's name as the chat header shows it, or Rome before it is known.
    static func agent(_ name: String?) -> String {
        shortName(AgentName.shown(name))
    }
}

/// The drawer's one row that asks for action while the open Rome is behind:
/// the accent on a light tint, shaped like the drawer's rows, never raised
/// like the selected one. It opens the update page.
struct DrawerUpdateRow: View {
    /// The Agent's display name, as the Chat pill names it.
    let agentName: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.down.circle")
                    .romeFont(16, .medium)
                    .frame(width: 22)
                Text(verbatim: UpdateCopy.banner(UpdateCopy.agent(agentName)))
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

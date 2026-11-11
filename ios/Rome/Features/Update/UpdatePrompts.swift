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

/// Just above the composer in Chat and topic chats, centred: the open Rome
/// has a release it can do without, or an upgrade from this phone just
/// finished. It sits in the composer's inset, so the last message rests
/// above it and the header is never covered.
struct UpdatePill: View {
    /// The Agent's display name, as the header shows it.
    let agentName: String?

    @Environment(AppModel.self) private var model

    private var updater: InstanceUpdater { model.update }

    var body: some View {
        let name = UpdateCopy.agent(agentName)
        Group {
            if updater.showsBanner {
                offer(name)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let version = updater.updatedTo {
                done(name, version: version)
                    .transition(.opacity)
                    // Said once, for about three seconds.
                    .task(id: version) {
                        try? await Task.sleep(for: .seconds(3))
                        withAnimation(.easeOut(duration: 0.4)) { updater.clearUpdated() }
                    }
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: updater.showsBanner)
    }

    /// Update opens the update page; the cross closes it for this release.
    private func offer(_ name: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.down.circle")
                .romeFont(14, .semibold)
                .foregroundStyle(Palette.primaryText)
            Text(verbatim: UpdateCopy.banner(name))
                .romeFont(14, .medium)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
            Button { updater.openPage() } label: {
                Text("Update")
                    .romeFont(13, .semibold)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .background(Palette.primary, in: Capsule())
            }
            .buttonStyle(PressScaleStyle())
            Button { updater.dismissBanner() } label: {
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
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .glassSurface(Capsule(), frost: Frost.composer)
    }

    private func done(_ name: String, version: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .romeFont(14, .semibold)
                .foregroundStyle(Palette.primaryText)
            Text(verbatim: UpdateCopy.updated(name, version: version))
                .romeFont(14, .medium)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .glassSurface(Capsule(), frost: Frost.composer)
        .accessibilityElement(children: .combine)
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

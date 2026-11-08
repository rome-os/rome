import SwiftUI

/// Board 2: search, Chat, Apps (for the guardian), the topic chats, and the account row.
struct DrawerView: View {
    let workspace: Workspace
    let section: MainSection
    let onSection: (MainSection) -> Void
    let onNewTopic: () -> Void
    let onSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { onSection(.search) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").romeFont(16, .medium)
                    Text("Search").romeFont(17)
                    Spacer()
                }
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 14)
                .frame(height: 42)
                .background(Palette.drawerField, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(PressScaleStyle(scale: 0.98))

            VStack(spacing: 2) {
                DrawerItem(title: "Chat", selected: section == .chat, action: { onSection(.chat) }) {
                    Image(systemName: "bubble.left")
                }
                // The apps are the guardian's: a visitor does not see them.
                if workspace.isGuardian {
                    DrawerItem(title: "Apps", selected: section == .apps, action: { onSection(.apps) }) {
                        Image(systemName: "square.grid.2x2")
                    }
                }
            }
            .padding(.top, 22)

            Rectangle()
                .fill(Palette.hair)
                .frame(height: 0.5)
                .padding(.horizontal, 12)
                .padding(.top, 14)

            HStack {
                Text("Topic chats")
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: onNewTopic) {
                    // Lighter and thinner than the header beside it, so it
                    // never outweighs the list.
                    Image(systemName: "plus")
                        .romeFont(15, .light)
                        .foregroundStyle(Palette.sub.opacity(0.75))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("New topic chat")
            }
            .padding(.leading, 12)
            .padding(.top, 6)

            ScrollView {
                VStack(spacing: 2) {
                    ForEach(workspace.topics.chats) { chat in
                        TopicItem(chat: chat, selected: section == .topic(chat.id)) {
                            onSection(.topic(chat.id))
                        }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: .infinity)

            Button(action: onSettings) {
                HStack(spacing: 12) {
                    InitialAvatar(text: workspace.accountLabel, imageURL: workspace.avatarURL)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(workspace.instanceName)
                            .romeFont(16, .semibold)
                            .foregroundStyle(Palette.fg)
                            .lineLimit(1)
                        Text(workspace.host)
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "gearshape")
                        .romeFont(17)
                        .foregroundStyle(Palette.fg)
                        .frame(width: 36, height: 36)
                        .background(Palette.drawerField, in: Circle())
                }
                .padding(.leading, 8)
                .padding(.trailing, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 60)
                .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(PressScaleStyle(scale: 0.98))
            .accessibilityLabel("\(workspace.instanceName), settings")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

private struct DrawerItem<Icon: View>: View {
    let title: LocalizedStringKey
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                icon()
                    .romeFont(18, selected ? .medium : .regular)
                    .foregroundStyle(selected ? Palette.primaryIcon : Palette.fg)
                    .frame(width: 22)
                Text(title)
                    .romeFont(17, selected ? .semibold : .regular)
                Spacer()
            }
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 12)
            .frame(height: 48)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.elevated)
                        .softElevation(radius: 14)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// One topic chat: its name and how many replies wait unread.
private struct TopicItem: View {
    let chat: ConciergeChat
    let selected: Bool
    let action: () -> Void

    private var unread: Int { chat.unread ?? 0 }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(verbatim: TopicChatsStore.title(chat))
                    // The highlight shows the selection; the weight stays.
                    .romeFont(16)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if unread > 0 {
                    Text(verbatim: "\(unread)")
                        .romeFont(12, .bold, monospacedDigits: true)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Palette.primary, in: Capsule())
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.elevated)
                        .softElevation(radius: 14)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityValue(unread > 0 ? Text("\(unread) unread") : Text(verbatim: ""))
    }
}

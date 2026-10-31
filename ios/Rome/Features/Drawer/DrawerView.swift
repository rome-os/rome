import SwiftUI

/// Board 2: search, Chat and Routines, the coming-soon entries, and the account row.
struct DrawerView: View {
    let workspace: Workspace
    let onChat: () -> Void
    let onRoute: (Route) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { onRoute(.search) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium))
                    Text("搜索").font(.system(size: 17))
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
                DrawerItem(title: "Chat", selected: true, action: onChat) {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Palette.primaryIcon)
                }
                DrawerItem(title: "Routines", selected: false, action: { onRoute(.routines) }) {
                    Image(systemName: "calendar")
                        .font(.system(size: 18))
                }
            }
            .padding(.top, 22)

            Text("即将推出")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 12)
                .padding(.top, 26)
                .padding(.bottom, 8)

            VStack(spacing: 2) {
                ComingSoonItem(title: "Apps", systemImage: "square.grid.2x2")
                ComingSoonItem(title: "Memory", systemImage: "archivebox")
                ComingSoonItem(title: "Activity", systemImage: "waveform.path.ecg")
            }

            Spacer()

            Button { onRoute(.settings) } label: {
                HStack(spacing: 12) {
                    InitialAvatar(text: workspace.accountLabel)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(workspace.instanceName)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Palette.fg)
                            .lineLimit(1)
                        Text(workspace.host)
                            .font(.system(size: 13))
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "gearshape")
                        .font(.system(size: 17))
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
            .accessibilityLabel("\(workspace.instanceName)，设置")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

private struct DrawerItem<Icon: View>: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                icon().frame(width: 22)
                Text(title)
                    .font(.system(size: 17, weight: selected ? .semibold : .regular))
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

private struct ComingSoonItem: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 16))
                .frame(width: 22)
            Text(title).font(.system(size: 17))
            Spacer()
        }
        .foregroundStyle(Palette.sub)
        .opacity(0.75)
        .padding(.horizontal, 12)
        .frame(height: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title)，即将推出")
    }
}

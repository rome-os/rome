import SwiftUI

/// The apps the guardian made or installed, each opening full screen; with
/// none, a short guide to making one with Chat.
struct AppsScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onOpen: (InstalledApp) -> Void
    /// Sends a ready prompt to the main Chat.
    let onAsk: (String) -> Void

    @State private var apps: [InstalledApp]?
    @State private var failed = false
    @State private var showIdeas = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let apps {
                    if apps.isEmpty {
                        AppGuide(onAsk: onAsk)
                            .padding(.top, 60)
                    } else {
                        card(apps)
                    }
                } else if failed {
                    CenteredMessage(title: "Could not load apps", detail: "Check the network and try again", actionTitle: "Try again") {
                        Task { await load() }
                    }
                    .frame(height: 320)
                } else {
                    Spinner(size: 20, color: Palette.sub).frame(maxWidth: .infinity).padding(.top, 60)
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .softTopScrollEdge()
        .floatingTopBar { DrawerPageHeader(title: Text("Apps"), onMenu: onMenu) }
        .pageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showIdeas) {
            AppIdeasSheet { prompt in
                showIdeas = false
                onAsk(prompt)
            }
            .presentationDetents([.height(320)])
            .presentationBackground(Palette.bg)
        }
    }

    private func card(_ list: [InstalledApp]) -> some View {
        VStack(spacing: 0) {
            ForEach(list) { app in
                AppRow(app: app, backend: workspace.backend) { onOpen(app) }
            }
            Button { showIdeas = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus")
                        .romeFont(17, .medium)
                        .foregroundStyle(Palette.sub)
                        .frame(width: 40, height: 40)
                        .background(Palette.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text("Make a new app")
                        .romeFont(17)
                        .foregroundStyle(Palette.sub)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
        }
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
        .padding(.horizontal, 16)
    }

    private func load() async {
        failed = false
        do {
            apps = AppLinks.mine(try await workspace.backend.apps())
        } catch {
            if apps == nil { failed = true }
        }
    }
}

/// One app: its icon, name and one line about it. An app that is not
/// running, or has no page, stays in the list but does not open.
private struct AppRow: View {
    let app: InstalledApp
    let backend: RomeBackend
    let onOpen: () -> Void

    private var opens: Bool { app.fullHref != nil }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                AppIcon(app: app, backend: backend)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: app.name)
                        .romeFont(17)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                    if let description = app.description, !description.isEmpty {
                        Text(verbatim: description)
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if opens {
                    Image(systemName: "chevron.right")
                        .romeFont(13, .semibold)
                        .foregroundStyle(Palette.sub)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .opacity(opens ? 1 : 0.5)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) {
                Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 68)
            }
        }
        .buttonStyle(RowPressStyle())
        .disabled(!opens)
        .accessibilityElement(children: .combine)
    }
}

/// The app's own icon from the instance, or a tile with its first letter.
struct AppIcon: View {
    let app: InstalledApp
    let backend: RomeBackend
    var size: CGFloat = 40
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(verbatim: String(app.name.prefix(1)).uppercased())
                    .romeFont(size * 0.45, .semibold)
                    .foregroundStyle(Palette.primaryIcon)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.primarySoft)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous))
        .accessibilityHidden(true)
        .task(id: app.iconUrl) {
            guard let icon = app.iconUrl, icon.hasPrefix("/api/") else { return }
            // Through the instance's client: the icon is the guardian's to see.
            if let data = try? await backend.apiFile(path: String(icon.dropFirst(4)), query: nil) {
                image = UIImage(data: data)
            }
        }
    }
}

/// With no apps yet: what an app is here, and three to start from.
struct AppGuide: View {
    let onAsk: (String) -> Void

    var body: some View {
        VStack(spacing: 14) {
            Mascot()
                .frame(width: 64)
            Text("Make your own app")
                .romeFont(22, .semibold)
                .multilineTextAlignment(.center)
            Text("Tell Chat what you need. Rome builds it as an app you can open here.")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            AppIdeaChips(onAsk: onAsk)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }
}

/// The three ideas, each a chip that asks Chat to build it.
struct AppIdeaChips: View {
    let onAsk: (String) -> Void

    var body: some View {
        VStack(spacing: 10) {
            ForEach(AppIdea.allCases) { idea in
                Button { onAsk(idea.prompt) } label: {
                    Text(idea.title)
                        .romeFont(15, .medium)
                        .foregroundStyle(Palette.fg)
                        .padding(.horizontal, 18)
                        .frame(minHeight: 40)
                        .background(Palette.elevated, in: Capsule())
                        .hairline(radius: 20)
                }
                .buttonStyle(PressScaleStyle())
            }
        }
    }
}

/// "Make a new app" with apps already there: the same ideas, in a small sheet.
private struct AppIdeasSheet: View {
    let onAsk: (String) -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text("Make a new app")
                .romeFont(17, .semibold)
                .padding(.top, 24)
            Text("Tell Chat what you need. Rome builds it as an app you can open here.")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            AppIdeaChips(onAsk: onAsk)
                .padding(.top, 4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

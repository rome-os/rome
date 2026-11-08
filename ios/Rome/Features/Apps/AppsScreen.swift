import SwiftUI

/// The apps the guardian made or installed, laid out like a home screen,
/// each opening full screen; with none, a short guide to making one with Chat.
struct AppsScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onOpen: (InstalledApp) -> Void
    /// Puts a starting prompt in the main Chat's composer, unsent.
    let onStart: (String) -> Void

    @State private var apps: [InstalledApp]?
    @State private var failed = false
    @State private var showIdeas = false
    /// The apps last opened from this phone, read again each time the page shows.
    @State private var recentIDs: [String] = []
    #if DEBUG
    @Environment(AppModel.self) private var model
    /// Snapshot runs draw the sheet in a stand-in frame: Mac Catalyst cannot
    /// capture a system sheet.
    @State private var ideasPreview = false
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let apps {
                    if apps.isEmpty {
                        AppGuide(onStart: onStart)
                            .padding(.top, 60)
                    } else {
                        let recent = RecentApps.pick(recentIDs, from: apps)
                        if recent.isEmpty {
                            AppGrid(apps: apps, backend: workspace.backend, onOpen: onOpen) { showIdeas = true }
                        } else {
                            AppGrid(title: "Recent", apps: recent, backend: workspace.backend, onOpen: onOpen)
                            AppGrid(title: "My apps", apps: apps, backend: workspace.backend, onOpen: onOpen) { showIdeas = true }
                        }
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
        .onAppear { recentIDs = RecentApps(host: workspace.host).ids() }
        .sheet(isPresented: $showIdeas) {
            AppIdeasSheet { prompt in
                showIdeas = false
                onStart(prompt)
            }
            .presentationDetents([.height(380), .large])
            .presentationBackground(Palette.bg)
        }
        #if DEBUG
        .overlay {
            if ideasPreview {
                ZStack(alignment: .bottom) {
                    Palette.scrim
                    AppIdeasSheet { _ in }
                        .frame(height: 380)
                        .frame(maxWidth: .infinity)
                        .background(Palette.bg)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                }
                .ignoresSafeArea()
            }
        }
        .onChange(of: model.debugCommand) { _, command in
            guard case .appIdeas(let open) = command else { return }
            if SnapshotRunner.directory != nil { ideasPreview = open } else { showIdeas = open }
        }
        #endif
    }

    private func load() async {
        failed = false
        do {
            let mine = AppLinks.mine(try await workspace.backend.apps())
            apps = mine
            Task { await workspace.shelve(mine) }
        } catch {
            if apps == nil { failed = true }
        }
    }
}

/// The apps as a home screen: icons in rows of four, three at the largest
/// text sizes, with "New app" as the last one.
private struct AppGrid: View {
    /// A group's title; none when the page has one group.
    var title: LocalizedStringKey? = nil
    let apps: [InstalledApp]
    let backend: RomeBackend
    let onOpen: (InstalledApp) -> Void
    /// The "New app" cell at the end; none for Recent.
    var onNew: (() -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var width: CGFloat = 0

    private static let padding: CGFloat = 20
    private static let spacing: CGFloat = 8
    private var count: Int { typeSize.isAccessibilitySize ? 3 : 4 }

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: Self.spacing, alignment: .top), count: count)
    }

    /// Where the first icon starts: the title sits on that edge, as a section
    /// title sits on its card's edge.
    private var iconEdge: CGFloat {
        let column = (width - Self.padding * 2 - Self.spacing * CGFloat(count - 1)) / CGFloat(count)
        return Self.padding + max(0, (column - AppGridMetrics.icon) / 2)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.sub)
                    .padding(.leading, iconEdge)
                    .accessibilityAddTraits(.isHeader)
            }
            LazyVGrid(columns: columns, spacing: 22) {
                ForEach(apps) { app in
                    AppCell(app: app, backend: backend) { onOpen(app) }
                }
                if let onNew { NewAppCell(action: onNew) }
            }
            .padding(.horizontal, Self.padding)
        }
        .padding(.top, 12)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// The apps last opened from this phone, newest first, per instance.
struct RecentApps {
    static let shown = 4
    static let kept = 16

    let host: String
    var defaults: UserDefaults = .standard

    private var key: String { "recentApps.\(host)" }

    func ids() -> [String] { defaults.stringArray(forKey: key) ?? [] }

    func record(_ appId: String) {
        let list = [appId] + ids().filter { $0 != appId }
        defaults.set(Array(list.prefix(Self.kept)), forKey: key)
    }

    /// The recent apps the list still has, newest first, at most `shown`.
    static func pick(_ ids: [String], from apps: [InstalledApp]) -> [InstalledApp] {
        Array(ids.compactMap { id in apps.first { $0.id == id } }.prefix(shown))
    }
}

/// One app: its icon and its name below. An app that is not running, or has
/// no page, stays in the grid, dimmed, and does not open.
private struct AppCell: View {
    let app: InstalledApp
    let backend: RomeBackend
    let onOpen: () -> Void

    private var opens: Bool { app.fullHref != nil }

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: 6) {
                AppIcon(app: app, backend: backend, size: AppGridMetrics.icon)
                AppCellName(Text(verbatim: app.name))
            }
            .opacity(opens ? 1 : 0.4)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!opens)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// The last cell: makes a new app from an idea.
private struct NewAppCell: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: "plus")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(Palette.sub)
                    .frame(width: AppGridMetrics.icon, height: AppGridMetrics.icon)
                    .background(Palette.fill, in: AppGridMetrics.shape(AppGridMetrics.icon))
                    .overlay(AppGridMetrics.shape(AppGridMetrics.icon).strokeBorder(Palette.hair, lineWidth: 1))
                AppCellName(Text("New app"))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// A cell's name: one line of small text, cut at the end.
private struct AppCellName: View {
    let text: Text
    init(_ text: Text) { self.text = text }

    var body: some View {
        text
            .romeFont(12)
            .foregroundStyle(Palette.fg)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity)
    }
}

enum AppGridMetrics {
    static let icon: CGFloat = 60
    /// The home screen's continuous corner, about 22.5% of the side.
    static func shape(_ size: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
    }
}

/// The app's own icon from the instance, or a tile with its first letter in
/// the app's own color.
struct AppIcon: View {
    let app: InstalledApp
    let backend: RomeBackend
    var size: CGFloat = AppGridMetrics.icon
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                // A fixed size: the tile does not grow with the text setting.
                Text(verbatim: String(app.name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.appTiles[AppTile.colorIndex(for: app.name)])
            }
        }
        .frame(width: size, height: size)
        .clipShape(AppGridMetrics.shape(size))
        .accessibilityHidden(true)
        .task(id: app.iconUrl) {
            // Another app's icon never stays on a reused cell.
            image = nil
            guard let icon = app.iconUrl, icon.hasPrefix("/api/") else { return }
            // Through the instance's client: the icon is the guardian's to see.
            if let data = try? await backend.apiFile(path: String(icon.dropFirst(4)), query: nil) {
                image = await AppIconImage.decode(data, side: size)
            }
        }
    }
}

/// With no apps yet: what an app is here, a blank start, and three ideas.
struct AppGuide: View {
    let onStart: (String) -> Void

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
            AppIdeaChips(onStart: onStart)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }
}

/// A blank start and the three ideas, each a chip that puts its prompt in
/// Chat's composer for the guardian to finish.
struct AppIdeaChips: View {
    let onStart: (String) -> Void

    var body: some View {
        VStack(spacing: 10) {
            ForEach(AppIdea.allCases) { idea in
                Button { onStart(idea.prompt) } label: {
                    HStack(spacing: 6) {
                        if idea == .own {
                            Image(systemName: "pencil").romeFont(14, .medium)
                        }
                        Text(idea.title)
                    }
                    .romeFont(15, .medium)
                    .foregroundStyle(idea == .own ? Palette.primaryText : Palette.fg)
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

/// "New app" with apps already there: the same choices, in a small sheet.
private struct AppIdeasSheet: View {
    let onStart: (String) -> Void

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
            AppIdeaChips(onStart: onStart)
                .padding(.top, 4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

import SwiftUI

/// The apps the guardian made or installed, laid out like a home screen,
/// each opening full screen; with none, a short guide to making one with Chat.
struct AppsScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onOpen: (InstalledApp) -> Void
    /// Puts a starting prompt in the main Chat's composer, unsent.
    let onStart: (String) -> Void

    /// The list as last read on this instance, shown at once; refetched each time.
    @State private var apps: [InstalledApp]?
    @State private var failed = false

    init(workspace: Workspace, onMenu: @escaping () -> Void, onOpen: @escaping (InstalledApp) -> Void, onStart: @escaping (String) -> Void) {
        self.workspace = workspace
        self.onMenu = onMenu
        self.onOpen = onOpen
        self.onStart = onStart
        _apps = State(initialValue: workspace.appsCache)
    }
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
                            AppGrid(title: "My apps", apps: apps, backend: workspace.backend, onOpen: onOpen) { showIdeas = true }
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
        .onAppear { recentIDs = RecentApps(host: workspace.host).ids() }
        .sheet(isPresented: $showIdeas) {
            AppIdeasSheet { prompt in
                showIdeas = false
                onStart(prompt)
            }
            .presentationDetents([.medium, .large])
            .presentationBackground(Palette.sheet)
            .presentationCornerRadius(22)
        }
        #if DEBUG
        .overlay {
            if ideasPreview {
                ZStack(alignment: .bottom) {
                    Palette.scrim
                    AppIdeasSheet { _ in }
                        .frame(height: 470)
                        .frame(maxWidth: .infinity)
                        .background(Palette.sheet)
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
            // Only a change redraws the grid.
            if apps != mine { apps = mine }
            await workspace.shelve(mine)
        } catch {
            if apps == nil { failed = true }
        }
    }
}

/// The apps as a home screen: icons in rows of four, three at the largest
/// text sizes, more on a wide page, with "New app" as the last one.
struct AppGrid: View {
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
    private var count: Int { Self.columns(width: width, accessibility: typeSize.isAccessibilitySize) }

    /// Four columns on a phone, three at the largest text sizes. A wider
    /// page, such as an iPad's, adds columns of about a phone's width
    /// instead of spreading four apart.
    static func columns(width: CGFloat, accessibility: Bool) -> Int {
        let base = accessibility ? 3 : 4
        let narrowest: CGFloat = accessibility ? 120 : 92
        let fits = Int((width - padding * 2 + spacing) / (narrowest + spacing))
        return max(base, fits)
    }

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

/// The apps last opened from this phone, newest first, per instance, for
/// the signed-in account only.
struct RecentApps {
    static let shown = 4
    static let kept = 16
    static let prefix = "recentApps."

    let host: String
    /// Whose list it is; once that account has ended, nothing is recorded.
    var account: AccountStamp = .unchecked
    var defaults: UserDefaults = .standard

    private var key: String { Self.prefix + host }

    func ids() -> [String] { defaults.stringArray(forKey: key) ?? [] }

    func record(_ appId: String) {
        guard account.isCurrent else { return }
        let list = [appId] + ids().filter { $0 != appId }
        defaults.set(Array(list.prefix(Self.kept)), forKey: key)
    }

    /// Sign-out, or another account: every instance's list.
    static func removeAll(defaults: UserDefaults = .standard) {
        defaults.removeKeys(prefix: prefix)
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
    /// The icon as drawn last time, from disk, so it shows in the first frame.
    @State private var image: UIImage?

    init(app: InstalledApp, backend: RomeBackend, size: CGFloat = AppGridMetrics.icon) {
        self.app = app
        self.backend = backend
        self.size = size
        _image = State(initialValue: app.iconUrl == nil ? nil : CachedImage.cached(instance: backend.displayOrigin, key: Self.cacheKey(app)))
    }

    static func cacheKey(_ app: InstalledApp) -> String { "app-icon-\(app.id)" }

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
        .task(id: "\(app.id)|\(app.iconUrl ?? "")|\(app.version ?? "")") {
            let key = Self.cacheKey(app)
            let instance = backend.displayOrigin
            // Another app's icon never stays on a reused cell.
            image = app.iconUrl == nil ? nil : CachedImage.cached(instance: instance, key: key)
            guard let icon = app.iconUrl, icon.hasPrefix("/api/") else { return }
            // Checked again in the background; replaced only when it changed.
            // Through the instance's client: the icon needs this person's session.
            let side = size
            if let fresh = await CachedImage.refresh(
                instance: instance, key: key, version: app.version, account: backend.account,
                fetch: { try await backend.apiFile(path: String(icon.dropFirst(4)), query: nil) },
                draw: { await AppIconImage.decode($0, side: side) }
            ) {
                image = fresh
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

/// "New app": a blank start that looks like Chat's composer, then ideas in one
/// card, the way Chat's starters and Settings' cards look.
private struct AppIdeasSheet: View {
    let onStart: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.grabber)
                .frame(width: 36, height: 5)
                .padding(.top, 7)
            HStack {
                Text("New app")
                    .romeFont(24, .bold)
                    .tracking(-0.6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 54)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Tell Chat what you need. Rome builds it as an app.")
                        .romeFont(15)
                        .foregroundStyle(Palette.sub)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 10)
                    SectionTitle("Describe your own")
                    ownIdea
                        .padding(.bottom, 14)
                    SectionTitle("Ideas")
                    ideas
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    /// Looks like the composer: the + and a placeholder on glass.
    private var ownIdea: some View {
        Button { onStart(AppIdea.own.prompt) } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                    .romeFont(17, .medium)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 36, height: 36)
                Text("An app that…")
                    .romeFont(16)
                    .foregroundStyle(Palette.sub)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, 7)
            .padding(.trailing, 14)
            .frame(minHeight: 50)
            .glassSurface(RoundedRectangle(cornerRadius: 25, style: .continuous), interactive: true, frost: Frost.composer)
            .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 25, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityLabel(Text("Describe your own"))
    }

    private var ideas: some View {
        VStack(spacing: 0) {
            ForEach(Array(AppIdea.ideas.enumerated()), id: \.element) { index, idea in
                Button { onStart(idea.prompt) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: idea.systemImage)
                            .romeFont(16, .medium)
                            .foregroundStyle(Palette.primaryText)
                            .frame(width: 34, height: 34)
                            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(idea.title)
                                .romeFont(16, .medium)
                                .foregroundStyle(Palette.fg)
                            Text(idea.detail)
                                .romeFont(13)
                                .foregroundStyle(Palette.sub)
                        }
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .romeFont(13, .semibold)
                            .foregroundStyle(Palette.sub)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                    .overlay(alignment: .bottom) {
                        if index < AppIdea.ideas.count - 1 {
                            Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 60)
                        }
                    }
                }
                .buttonStyle(RowPressStyle())
            }
        }
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
    }
}

/// A section title on its card's edge, as Settings writes them.
private struct SectionTitle: View {
    let text: LocalizedStringKey
    init(_ text: LocalizedStringKey) { self.text = text }

    var body: some View {
        Text(text)
            .romeFont(13, .medium)
            .foregroundStyle(Palette.sub)
            .accessibilityAddTraits(.isHeader)
    }
}

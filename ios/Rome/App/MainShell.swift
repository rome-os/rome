import SwiftUI

/// Screens pushed on the main stack.
enum Route: Hashable {
    case taskChat(chatId: String, title: String)
}

/// The pages the drawer switches between. Each is the root of the main stack,
/// so picking one in the drawer shows it in place, never pushed over Chat.
enum MainSection: Hashable {
    case chat
    case search
    /// The guardian's apps.
    case apps
    /// A Concierge topic chat.
    case topic(String)
    /// A blank topic chat, which creates its chat on the first send.
    case newTopic(UUID)
}

/// Pages pushed inside the Settings sheet.
enum SettingsRoute: Hashable {
    case instances
    /// This phone's connections.
    case connections
    /// One connection's page, by its id.
    case connection(String)
    /// One connection's live reads, by its id.
    case liveReads(String)
    /// A synced connection's Sync history, by its personal-data source.
    case syncHistory(String)
}

/// The signed-in app: Chat as the home screen, the drawer that pushes it aside,
/// and the Tasks and Settings sheets. On a regular width (an iPad, unless the
/// window is narrow) the drawer is pinned beside the page instead.
///
/// Both widths draw the same tree: the drawer and the page's stack sit in one
/// `ZStack` and only their frames and offsets change. A window resized across
/// compact and regular (Split View, Stage Manager) keeps the stack, its pushed
/// pages and their state.
struct MainShell: View {
    let workspace: Workspace
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The pinned drawer on a regular width: shown, or slid away by the header's button.
    @State private var sidebarShown = true
    @State private var section: MainSection = .chat
    @State private var path: [Route] = []
    @State private var drawerOpen = false
    /// Marks this view as the one that set the chat on screen.
    @State private var screenID = UUID()
    /// The Agent page, opened from a chat header's mascot.
    @State private var agentPage: AgentRoute?
    /// The Agent page's last tab, kept while the instance is open.
    @State private var agentTab: AgentTab = .tasks
    /// Pages pushed inside the Agent page: a task chat from its Tasks, or
    /// another task chat linked from there. Back returns to the Tasks.
    @State private var agentPath: [Route] = []
    /// A page of the instance opened from inside the Agent page, over it.
    @State private var agentLinkPage: URL?
    /// An app opened from inside the Agent page, in a sheet over it.
    @State private var agentApp: InstalledApp?
    /// Where the Agent page finds the avatar it zooms out of.
    @Namespace private var agentZoom
    /// A blank topic chat that started its chat keeps its view under the new id.
    @State private var startedTopics: [String: UUID] = [:]
    @State private var showSettings = false
    /// The Archived sheet, from the drawer's row under the topic chats.
    @State private var showArchived = false
    /// The archived chat tapped in that sheet: it opens once the sheet is gone.
    @State private var openArchived: String?
    /// Goes up with each widget link followed: a later one wins.
    @State private var linkSerial = 0
    /// A short notice after a widget link, such as an app that is gone.
    @State private var linkNotice: String?
    /// "See usage" was pressed inside the Agent page: Settings opens as it closes.
    @State private var openUsageAfterCover = false
    /// This window's actions for the views far below (`ShellActions`).
    @State private var actions = ShellActions()
    @State private var settingsPath: [SettingsRoute] = []
    /// A page of the instance, in a sheet over the main stack.
    @State private var page: URL?
    /// An app of the instance, in a sheet over the main stack.
    @State private var openApp: InstalledApp?
    /// A page opened from Settings, in a sheet over that sheet.
    @State private var settingsPage: URL?
    #if DEBUG
    @State private var settingsPreview = false
    @State private var photoViewerPreview = false
    @State private var pagePreview: URL?
    @State private var appPreview: InstalledApp?
    @State private var connectPreview: String?
    @State private var archivedPreview = false
    #endif

    /// The drawer pinned beside the page rather than pushed aside.
    static func usesSidebar(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        sizeClass == .regular
    }

    /// Mac Catalyst, which only runs the tests and the phone-sized snapshot
    /// pass, keeps the phone's layout.
    private var usesSidebar: Bool { Self.usesSidebar(sizeClass) && !ProcessInfo.processInfo.isMacCatalystApp }

    var body: some View {
        // Split in two: as one chain, the type checker gives up on CI.
        presented
        .onChange(of: path) { Keyboard.dismiss() }
        .onChange(of: agentPage) { _, shown in
            Keyboard.dismiss()
            // Opened or closed, it starts on its own page again.
            agentPath = []
            agentLinkPage = nil
            agentApp = nil
        }
        // The banner that offers a sign-in must not be covered, and a web
        // view on the expired session shows nothing useful.
        .onChange(of: model.sessionExpired) { _, expired in
            guard expired else { return }
            agentPage = nil
            openApp = nil
            page = nil
        }
        .onChange(of: showSettings) { _, shown in if shown { Keyboard.dismiss() } }
        .onChange(of: page) { _, shown in if shown != nil { Keyboard.dismiss() } }
        .onChange(of: openApp) { _, shown in if shown != nil { Keyboard.dismiss() } }
        // A tap on the widget: its app, Apps or Chat in front, nothing over it.
        // Taken on appear too: a link routed while this shell was being
        // built (a sign-in, a switch) waits for it.
        .onChange(of: model.widgetRequest, initial: true) {
            guard let link = model.takeWidgetLink(for: workspace.instanceID) else { return }
            Task { await follow(link) }
        }
        // A tapped "sign in again" notice: Settings at Apple Health's Sync history.
        // Taken on appear too: a tap that launched the app came before this shell.
        .onChange(of: model.settingsRequest, initial: true) {
            guard let routes = model.takeSettingsRequest() else { return }
            agentPage = nil
            page = nil
            openApp = nil
            settingsPage = nil
            closeDrawer()
            settingsPath = routes
            showSettings = true
        }
        // A tapped push for this instance: its chat in front, nothing over it.
        .onChange(of: model.chatRequest) { _, request in
            agentPage = nil
            showSettings = false
            page = nil
            openApp = nil
            settingsPage = nil
            closeDrawer()
            show(request.topicId.map(MainSection.topic) ?? .chat)
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.sessionExpired)
        // A window that turns wide pins the drawer; the one it pushed aside is closed.
        .onChange(of: usesSidebar) { drawerOpen = false }
        #if DEBUG
        .onAppear { PerfProbe.start(model: model) }
        .onChange(of: model.debugCommand) { _, command in
            switch command {
            case .drawer(let open):
                // Pinned, the drawer stays on screen in every capture.
                if !usesSidebar { open ? openDrawer() : closeDrawer() }
            case .agent(let tab):
                if let tab { agentTab = tab }
                agentPage = tab == nil ? nil : AgentRoute(tasksChatId: conciergeChatID, chatKey: conciergeChatID)
            case .agentBlank(let tab):
                agentTab = tab
                agentPage = AgentRoute(tasksChatId: "", chatKey: "snapshot-blank")
            case .agentRoute(let routes):
                agentPath = routes
            case .route(let routes):
                show(.chat)
                path = routes
            case .section(let picked): show(picked)
            case .settings(let routes):
                settingsPath = routes ?? []
                if SnapshotRunner.directory != nil { settingsPreview = routes != nil } else { showSettings = routes != nil }
            case .page(let url):
                if SnapshotRunner.directory != nil { pagePreview = url } else { page = url }
            case .app(let app):
                if SnapshotRunner.directory != nil { appPreview = app } else { openApp = app }
            case .photoViewer(let open):
                photoViewerPreview = open
            case .connectSheet(let id):
                connectPreview = id
            case .archivedSheet(let open):
                archivedPreview = open
            case .composerPhotos, .appIdeas, nil: break
            }
        }
        #endif
    }

    /// The shell with its sheets and covers; `body` adds the reactions to state.
    private var presented: some View {
        GeometryReader { geometry in
            let _ = PerfProbe.count("shellBody")
            let width = min(318, geometry.size.width * 0.81)
            // Pinned, the drawer takes this much of the width beside the page;
            // pushed aside (compact), none, and the slide moves the page instead.
            let column: CGFloat = usesSidebar && sidebarShown ? width : 0

            DrawerSlide(
                width: width,
                column: column,
                pinned: usesSidebar,
                pinnedShown: sidebarShown,
                edge: !usesSidebar && !drawerOpen && path.isEmpty,
                open: $drawerOpen
            ) {
                DrawerView(
                    workspace: workspace,
                    section: section,
                    onSection: { picked in
                        show(picked)
                        closeDrawer()
                    },
                    onNewTopic: {
                        show(.newTopic(UUID()))
                        closeDrawer()
                    },
                    // The sheet rises over the open drawer, and the drawer is still
                    // there when it closes: one motion each way, never two at once.
                    onSettings: {
                        settingsPath = []
                        showSettings = true
                    },
                    // The open chat archived or deleted from its row: the main
                    // Chat shows, as from the chat's own header; the drawer stays.
                    onTopicGone: leave,
                    // Over the open drawer, as Settings is.
                    onArchived: {
                        openArchived = nil
                        showArchived = true
                    }
                )
                .frame(width: width, height: geometry.size.height)
            } page: {
                NavigationStack(path: $path) {
                    root
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
                }
                .environment(\.chatLinkOpener, actions.linkOpener)
                .environment(\.openUsage, actions.openUsage)
                .environment(\.connectDevice, model.deviceConnectAction)
                .environment(\.openTaskChat, actions.openTaskChat)
                .environment(\.agentZoom, agentZoom)
                .environment(\.visibleChat, visibleChat)
                .instancePageSheet(workspace: workspace, url: $page)
                .appSheet(workspace: workspace, app: $openApp)
                .environment(\.isVisitor, workspace.isVisitor)
                .environment(\.shareAgentName, AgentName.display(workspace.agentName))
                // Over the page, so beside a pinned drawer they sit above the chat.
                // The page reaches under the status bar; they start below it.
                .overlay(alignment: .top) { banners.padding(.top, geometry.safeAreaInsets.top) }
                .frame(width: geometry.size.width - column, height: geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom)
            }
        }
        // The Archived sheet stops at half height and floats on iOS 26, and
        // the system dims nothing behind a sheet there: the drawer and the
        // chat would read clearly around it.
        .overlay { archivedScrim }
        .fullScreenCover(item: $agentPage, onDismiss: {
            // Settings is a sheet of this view, so it waits for the cover to be gone.
            guard openUsageAfterCover else { return }
            openUsageAfterCover = false
            settingsPath = []
            showSettings = true
        }) { route in
            // Its own stack: a task opens inside the page, and back returns
            // to the Tasks as they were.
            NavigationStack(path: $agentPath) {
                AgentPage(workspace: workspace, route: route, tab: $agentTab, onOpenTask: { chat in
                    agentPath.append(.taskChat(chatId: chat.id, title: chat.name))
                }, onClose: { agentPage = nil })
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
            }
            .environment(model)
            .environment(\.chatLinkOpener, actions.linkOpener)
            // Settings is a sheet of this view: the cover closes first.
            .environment(\.openUsage, actions.openUsageFromCover)
            .environment(\.connectDevice, model.deviceConnectAction)
            .environment(\.visibleChat, visibleChat)
            .environment(\.isVisitor, workspace.isVisitor)
            .environment(\.shareAgentName, AgentName.display(workspace.agentName))
            .instancePageSheet(workspace: workspace, url: $agentLinkPage)
            .appSheet(workspace: workspace, app: $agentApp)
            .presentationBackground(Palette.bg)
            .agentZoomTransition(route.zoomSource, in: agentZoom)
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
        .sheet(isPresented: $showArchived, onDismiss: {
            // The chat opens once the sheet is gone, and the drawer goes with it.
            guard let id = openArchived else { return }
            openArchived = nil
            show(.topic(id))
            closeDrawer()
        }) {
            archivedSheet
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Palette.sheet)
                .presentationCornerRadius(22)
        }
        // A connect card's device connection: its authorization, then the card checks.
        .sheet(item: Binding(get: { model.connections.request }, set: { if $0 == nil { model.connections.request?.finish(false) } })) { request in
            ConnectDeviceSheet(request: request)
                .presentationBackground(Palette.sheet)
                .presentationCornerRadius(22)
        }
        #if DEBUG
        .overlay {
            if photoViewerPreview {
                // Snapshot runs only: the viewer in place of its full-screen cover.
                PhotoViewer(images: [.markdown(ImageSource(src: "/projects/demo/trip/hotel.jpg"), alt: "河原町酒店外观", src: "/projects/demo/trip/hotel.jpg", position: 0)], start: 0)
            }
            // Snapshot runs only, for the same reason: the sheets in a stand-in frame.
            if let pagePreview {
                SheetStandIn { InstancePageScreen(workspace: workspace, url: pagePreview) }
            }
            if let appPreview {
                SheetStandIn { AppWebScreen(workspace: workspace, app: appPreview) }
            }
            if settingsPreview {
                SheetStandIn { settingsSheet }
            }
            if archivedPreview {
                // A sheet at medium height, over the open drawer.
                ZStack(alignment: .bottom) {
                    SheetScrim()
                    archivedSheet
                        .frame(height: 420)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                }
                .ignoresSafeArea(edges: .bottom)
            }
            if let connectPreview {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.4).ignoresSafeArea()
                    ConnectDeviceSheet(request: DeviceConnectRequest(capability: connectPreview) { _ in }, standIn: true)
                        .background(Palette.sheet)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                }
                .ignoresSafeArea(edges: .bottom)
            }
        }
        #endif
        // Which chat is in front, for pushes: none under a sheet or the drawer.
        .onChange(of: visibleChat, initial: true) { _, chat in model.show(chat, by: screenID) }
        .onChange(of: workspace.mainChatServerID) { model.rewatch() }
        .onAppear {
            installShellActions()
            workspace.register(actions)
        }
        // What toggling the navigation does depends on the width.
        .onChange(of: usesSidebar) { installShellActions() }
        .onDisappear {
            model.hide(by: screenID)
            // The actions hold this view's state, which they must not
            // outlive. The Agent page's cover takes the shell off screen too
            // and uses them meanwhile; the workspace empties them when it
            // stops, cover or not.
            guard agentPage == nil else { return }
            actions.reset()
            workspace.unregister(actions)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: drawerOpen)
        .onChange(of: drawerOpen) { _, open in
            if open {
                Keyboard.dismiss()
                workspace.topics.refresh()
                workspace.archivedTopics.refresh()
            }
        }
        // Whatever covers or replaces the chat takes the keyboard with it;
        // the composer keeps its text.
    }

    /// A tap on the widget: its app, Apps or Chat in front, nothing over it.
    /// Everything presented closes first, the screens' own sheets and covers
    /// included (a photo, a share sheet, a page from an app), and the link is
    /// followed once they are gone, so the app never opens under one. A later
    /// tap wins over one still on its way.
    private func follow(_ link: WidgetLink) async {
        linkSerial += 1
        let mine = linkSerial
        agentPage = nil
        agentPath = []
        agentLinkPage = nil
        agentApp = nil
        showSettings = false
        page = nil
        openApp = nil
        settingsPage = nil
        closeDrawer()
        Keyboard.dismiss()
        await Presentations.dismissAll()
        guard mine == linkSerial else { return }
        switch link {
        case .app(_, let appId):
            show(.apps)
            switch await WidgetApps.resolve(appId, in: workspace) {
            case .found(let app):
                guard mine == linkSerial else { return }
                path = []
                openApp = app
            case .gone:
                // Never a quiet nothing: the Apps grid, and why.
                guard mine == linkSerial else { return }
                path = []
                say(String(localized: "App not found"))
            }
        case .apps:
            show(.apps)
            path = []
        case .chat:
            show(.chat)
            path = []
        case .newApp:
            show(.chat)
            path = []
            workspace.composerPrefills[conciergeChatID] = AppIdea.own.prompt
        }
    }

    private func say(_ text: String) {
        linkNotice = text
        Task {
            try? await Task.sleep(for: .seconds(3))
            if linkNotice == text { linkNotice = nil }
        }
    }

    /// Session expired, at the top of the page's column.
    @ViewBuilder
    private var banners: some View {
        if let linkNotice {
            TopBanner(kind: .error, text: linkNotice)
                .readableColumn()
                .padding(.top, 58)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
        if model.sessionExpired {
            TopBanner(kind: .error, text: String(localized: "Session expired"), actionTitle: String(localized: "Sign in again")) {
                Task { await model.reauthenticate() }
            }
            .readableColumn()
            .padding(.top, 58)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .taskChat(let chatId, let title):
            TaskChatScreen(workspace: workspace, chatId: chatId, initialTitle: title)
                .id(chatId)
        }
    }

    /// What the chat rows call back into the shell. The environment holds
    /// these objects, never closures made in `body`: a shell update changes
    /// none of them, so it draws no row and no message's text again.
    private func installShellActions() {
        actions.linkOpener.run = { openChatLink($0) }
        actions.toggleNavigation.run = { _ in toggleNavigation() }
        actions.openAgent.run = { tab in
            if let tab { agentTab = tab }
            agentPage = AgentRoute(tasksChatId: conciergeChatID, chatKey: conciergeChatID)
        }
        actions.openTaskChat.run = { path.append(.taskChat(chatId: $0.chatId, title: $0.title)) }
        actions.openUsage.run = { _ in
            settingsPath = []
            showSettings = true
        }
        actions.openUsageFromCover.run = { _ in
            openUsageAfterCover = true
            agentPage = nil
        }
    }

    /// A link tapped in chat text: an app or a page of the instance opens in
    /// the app's web view in a sheet, anything else as the system
    /// opens it.
    private func openChatLink(_ url: URL) -> OpenURLAction.Result {
        switch AppLinks.chatLink(url, origin: workspace.backend.origin, apps: workspace.apps) {
        case .app(let id, let page):
            Task { await openLinkedApp(id, page: page) }
            return .handled
        case .page(let url):
            // Over whatever is in front: the Agent page covers the main stack.
            if agentPage != nil { agentLinkPage = url } else { page = url }
            return .handled
        case .external, .system:
            return .systemAction
        }
    }

    /// An app just built may not be in the list yet: it is read again first.
    /// Still missing, the link opens as a page.
    private func openLinkedApp(_ id: String, page: URL?) async {
        var app = workspace.apps.first { $0.id == id }
        if app == nil, let all = try? await workspace.backend.apps() {
            await workspace.shelve(AppLinks.mine(all))
            app = all.first { $0.id == id }
        }
        if let app {
            if agentPage != nil { agentApp = app } else { openApp = app }
        } else if let page {
            if agentPage != nil { agentLinkPage = page } else { self.page = page }
        }
    }

    private var root: some View {
        // Chat stays alive under the other pages: rebuilt, its list would load
        // again from the top and scroll down while the drawer closes onto it.
        ZStack {
            // References and a flag, no closures: a shell update that
            // changes none of them leaves Chat's body alone. Not
            // `.equatable()`: that keeps iOS 26 from fading the rows under
            // Chat's header.
            ChatScreen(
                workspace: workspace,
                shell: actions,
                // The same answer the server watch and push banners go by: a
                // sheet, the drawer or a pushed page over Chat hides it.
                visible: visibleChat == conciergeChatID
            )
            .opacity(section == .chat ? 1 : 0)
            .environment(\.offScreen, section != .chat || covered)
            .allowsHitTesting(section == .chat)
            .accessibilityHidden(section != .chat)
            switch section {
            case .chat:
                EmptyView()
            case .topic(let chatId):
                topicScreen(chatId: chatId, draftKey: chatId)
                    .id(startedTopics[chatId]?.uuidString ?? chatId)
            case .newTopic(let key):
                topicScreen(chatId: nil, key: key, draftKey: DraftStore.blankChat(key))
                    .id(key.uuidString)
            case .apps:
                AppsScreen(workspace: workspace, onMenu: { toggleNavigation() }, onOpen: { app in
                    openApp = app
                }, onStart: { prompt in
                    // The main Chat, with the prompt in its composer to edit.
                    show(.chat)
                    workspace.composerPrefills[conciergeChatID] = prompt
                })
                .environment(\.offScreen, covered)
            case .search:
                SearchScreen(workspace: workspace, onMenu: { toggleNavigation() }) { hit in
                    switch workspace.openSearchHit(hit.session) {
                    case .main: show(.chat)
                    case .topic(let id): show(.topic(id))
                    case .taskChat(let id, let title): path.append(.taskChat(chatId: id, title: title))
                    }
                }
            }
        }
    }

    /// A topic chat archived or deleted from the drawer or the Archived
    /// sheet: if it is open, the main Chat shows, as from the chat's own header.
    private func leave(_ chatId: String) {
        if let next = Self.section(after: section, retired: chatId) { show(next) }
    }

    /// Where the shell goes when topic chat `retired` leaves: the main Chat
    /// if it is the open one, else nowhere (nil).
    static func section(after current: MainSection, retired: String) -> MainSection? {
        current == .topic(retired) ? .chat : nil
    }

    /// The scrim behind the Archived sheet while it is up. Kept out of `body`,
    /// whose modifier chain is already near the type checker's limit.
    private var archivedScrim: some View {
        ZStack {
            if showArchived { SheetScrim().transition(.opacity) }
        }
        .animation(.easeOut(duration: 0.25), value: showArchived)
    }

    /// The Archived sheet: a tapped row closes it, and its chat opens after.
    private var archivedSheet: some View {
        ArchivedTopicsSheet(workspace: workspace, onOpen: { id in
            openArchived = id
            showArchived = false
        }, onDeleted: leave)
    }

    /// A pushed page, the Agent page's cover or a large sheet (an app, a
    /// dashboard page, Settings) hides the stack's root. A sheet leaves the
    /// root on screen, so its animations would keep running under it.
    private var covered: Bool { !path.isEmpty || agentPage != nil || openApp != nil || page != nil || showSettings || showArchived }

    private func topicScreen(chatId: String?, key: UUID? = nil, draftKey: String) -> some View {
        TopicChatScreen(
            workspace: workspace,
            chatId: chatId,
            draftKey: draftKey,
            onMenu: { toggleNavigation() },
            onAgent: { id, tab in
                // A blank chat has no tasks yet; its Tasks tab shows the empty state.
                if let tab { agentTab = tab }
                agentPage = AgentRoute(tasksChatId: id ?? "", chatKey: id ?? draftKey)
            },
            onArchived: { show(.chat) },
            onCreated: { id in
                if let key { startedTopics[id] = key }
                var instant = Transaction()
                instant.disablesAnimations = true
                withTransaction(instant) { section = .topic(id) }
            },
            // A blank chat has no id for `visibleChat`: in front, as that
            // answer goes, means nothing over it, the drawer included.
            inFront: !covered && !drawerOpen
        )
        .environment(\.offScreen, covered)
    }

    /// Swaps the stack's root with no motion of its own; the drawer's slide is
    /// the only movement the guardian sees.
    private func show(_ picked: MainSection) {
        // The page left behind stays in the tree (Chat only fades out), so its
        // composer would keep the keyboard; with the drawer pinned no drawer
        // opening has taken it first.
        Keyboard.dismiss()
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            path = []
            section = picked
        }
    }

    /// Settings slides up with its own stack, so its pages (instances,
    /// Connections) push inside the sheet and the X closes all of it.
    private var settingsSheet: some View {
        NavigationStack(path: $settingsPath) {
            SettingsScreen(
                workspace: workspace,
                onInstances: { settingsPath.append(.instances) },
                onConnections: { settingsPath.append(.connections) },
                onClose: { showSettings = false }
            )
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .instances:
                    InstancesScreen(onSwitched: {
                        showSettings = false
                        show(.chat)
                    })
                case .connections:
                    ConnectionsScreen(
                        isVisitor: workspace.isVisitor,
                        onConnection: { settingsPath.append(.connection($0)) },
                        onWeb: { if let web = model.webURL { settingsPage = InstancePages.connections(origin: web) } }
                    )
                case .connection(let id):
                    ConnectionScreen(
                        id: id,
                        onActivity: { settingsPath.append(.liveReads(id)) },
                        onHistory: { source in settingsPath.append(.syncHistory(source)) }
                    )
                case .liveReads(let id):
                    NodeRequestsScreen(capability: id)
                case .syncHistory(let source):
                    SyncHistoryScreen(source: source)
                }
            }
        }
        .environment(\.pageBackground, Palette.secondaryPage)
        // A dashboard page rises over Settings, which is still there when it closes.
        .instancePageSheet(workspace: workspace, url: $settingsPage)
        .presentationBackground(Palette.secondaryPage)
    }

    // MARK: Drawer motion

    static let drawerSpring = Animation.spring(response: 0.38, dampingFraction: 0.86)

    /// The chat on screen, by its store's id.
    private var visibleChat: String? {
        if agentPage != nil {
            return Self.visibleChat(agentPath: agentPath, covered: agentLinkPage != nil || agentApp != nil || workspace.sharingCoversChat)
        }
        // The Archived sheet covers it too: beside a pinned drawer (iPad)
        // the drawer is not open while the sheet shows.
        return Self.visibleChat(section: section, path: path, covered: drawerOpen || showSettings || showArchived || page != nil || openApp != nil || workspace.sharingCoversChat)
    }

    /// The chat on screen while the Agent page is up: a task chat pushed
    /// inside it, unless a sheet covers it; the page itself shows none.
    static func visibleChat(agentPath: [Route], covered: Bool) -> String? {
        guard !covered, case .taskChat(let chatId, _)? = agentPath.last else { return nil }
        return chatId
    }

    /// The chat on screen: none while something covers the page (the drawer,
    /// the Settings sheet, an app's or an instance page's sheet, a chat's
    /// share sheets); a pushed task chat; else the section's chat. Chat's read marks, the
    /// server's watch and push banners all go by this one answer, with
    /// `visibleChat(agentPath:covered:)` while the Agent page is up.
    static func visibleChat(section: MainSection, path: [Route], covered: Bool) -> String? {
        if covered { return nil }
        if case .taskChat(let chatId, _)? = path.last { return chatId }
        switch section {
        case .chat: return conciergeChatID
        case .topic(let chatId): return chatId
        default: return nil
        }
    }

    private func openDrawer() {
        withAnimation(Self.drawerSpring) { drawerOpen = true }
    }

    /// The header's drawer button: opens the drawer, or slides the pinned one
    /// away and back, the page following its edge.
    private func toggleNavigation() {
        guard usesSidebar else { return openDrawer() }
        Keyboard.dismiss()
        withAnimation(Self.drawerSpring) { sidebarShown.toggle() }
        if sidebarShown {
            workspace.topics.refresh()
            workspace.archivedTopics.refresh()
        }
    }

    private func closeDrawer() {
        withAnimation(Self.drawerSpring) { drawerOpen = false }
    }
}

/// The drawer and the page, and the drag that slides one over the other. The
/// drag's state lives here, not in the shell: a drag tick runs only this body,
/// and the drawer and the page, built once by the shell, are the same values
/// each time, so SwiftUI leaves their trees alone while the finger moves. Only
/// the offsets, corners, shadow and page color below follow it.
private struct DrawerSlide<Drawer: View, Page: View>: View {
    let width: CGFloat
    /// Pinned beside the page (regular width): how much width it takes.
    let column: CGFloat
    let pinned: Bool
    let pinnedShown: Bool
    /// The left edge opens the drawer.
    let edge: Bool
    @Binding var open: Bool
    let drawer: Drawer
    let page: Page

    /// A finger is on the drawer's edge.
    @State private var edgeTouched = false
    /// The finger's pull on the drawer while a drag runs. It springs back to
    /// zero with the drawer when the drag ends or the system cancels it.
    @GestureState(resetTransaction: Transaction(animation: MainShell.drawerSpring))
    private var drag = DrawerDrag()
    /// The axis the running drag locked on its first movement, for `onEnded`,
    /// which gets only the final translation.
    @State private var dragAxis: DragAxis?

    /// Built here, once per shell update, never per drag tick.
    init(
        width: CGFloat, column: CGFloat, pinned: Bool, pinnedShown: Bool, edge: Bool, open: Binding<Bool>,
        @ViewBuilder drawer: () -> Drawer, @ViewBuilder page: () -> Page
    ) {
        self.width = width
        self.column = column
        self.pinned = pinned
        self.pinnedShown = pinnedShown
        self.edge = edge
        _open = open
        self.drawer = drawer()
        self.page = page()
    }

    var body: some View {
        let progress = pinned ? 0 : dragProgress
        ZStack(alignment: .topLeading) {
            Palette.drawer.ignoresSafeArea()

            drawer
                // Pinned, it slides in from the left edge as the page makes room.
                .offset(x: pinned ? column - width : (progress - 1) * 36)
                // Closed, it is not drawn: under a page still fading in (the
                // opening screen's hand-off) its rows showed through.
                .opacity(pinned ? (pinnedShown ? 1 : 0) : (progress > 0 ? 0.4 + 0.6 * progress : 0))
                .allowsHitTesting(pinned ? pinnedShown : open)

            page
                // Pushed aside, the page becomes a card of its own color, following the drag.
                .environment(\.pageBackground, Palette.blend(Palette.bg, Palette.drawerPage, progress))
                .clipShape(RoundedRectangle(cornerRadius: 44 * progress, style: .continuous))
                .overlay {
                    if progress > 0 {
                        RoundedRectangle(cornerRadius: 44 * progress, style: .continuous)
                            .fill(Color.clear)
                            .contentShape(Rectangle())
                            .onTapGesture { close() }
                    }
                }
                .shadow(color: .black.opacity(0.12 * progress), radius: 15, x: -8, y: 0)
                .offset(x: column + width * progress)
                .ignoresSafeArea()
                .overlay(alignment: .leading) {
                    if edge {
                        Color.clear
                            .frame(width: 22)
                            .contentShape(Rectangle())
                            .gesture(drawerDrag)
                            // The edge sits above the list, which never feels this
                            // touch: stop its glide on touch-down, as the list would.
                            .simultaneousGesture(
                                DragGesture(minimumDistance: 0)
                                    .onChanged { _ in if !edgeTouched { edgeTouched = true; Scrolling.stopGlides() } }
                                    .onEnded { _ in edgeTouched = false }
                            )
                    }
                }
        }
        // While the drawer is open, a sideways drag anywhere, on the drawer or
        // the uncovered chat, pulls it closed.
        .gesture(drawerDrag, including: open ? .all : .subviews)
    }

    /// A drag's direction is fixed by its first movement, so a vertical scroll
    /// never moves the drawer.
    struct DrawerDrag {
        var horizontal: Bool?
        var offset: CGFloat = 0
    }

    struct DragAxis {
        let start: CGPoint
        let horizontal: Bool
    }

    /// How far the drawer is out, 0 to 1, the finger's pull included.
    private var dragProgress: CGFloat {
        let base: CGFloat = open ? 1 : 0
        return min(1, max(0, base + drag.offset / width))
    }

    private func close() {
        withAnimation(MainShell.drawerSpring) { open = false }
    }

    /// Opens from the left edge or closes from anywhere, following the finger.
    /// The translation is read in screen space: the chat moves under the finger,
    /// and reading it in the chat's own space would feed the motion back into itself.
    private var drawerDrag: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($drag) { value, state, _ in
                let move = value.translation
                if state.horizontal == nil { state.horizontal = abs(move.width) > abs(move.height) }
                guard state.horizontal == true else { return }
                state.offset = open ? min(0, move.width) : max(0, move.width)
            }
            .onChanged { value in
                // A new start point is a new drag, also after a cancelled one.
                // The rule matches the one above, on the same first movement.
                if dragAxis?.start != value.startLocation {
                    let horizontal = abs(value.translation.width) > abs(value.translation.height)
                    dragAxis = DragAxis(start: value.startLocation, horizontal: horizontal)
                    // The drawer starts to move: the keyboard goes now, not
                    // once it is open. A vertical scroll leaves it alone.
                    if horizontal {
                        Keyboard.dismiss()
                        // A drawer drag that starts in a glide stops it first.
                        Scrolling.stopGlides()
                    }
                }
            }
            .onEnded { value in
                defer { dragAxis = nil }
                guard let axis = dragAxis, axis.start == value.startLocation, axis.horizontal else { return }
                let travel = open ? -value.translation.width : value.translation.width
                let flung = open ? -value.predictedEndTranslation.width : value.predictedEndTranslation.width
                let toggle = travel > width * 0.35 || flung > width * 0.5
                if toggle { withAnimation(MainShell.drawerSpring) { open.toggle() } }
            }
    }
}

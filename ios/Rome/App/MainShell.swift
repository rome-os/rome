import SwiftUI

/// Screens pushed on the main stack.
enum Route: Hashable {
    case taskChat(chatId: String, title: String)
    /// An app of the instance, full screen.
    case app(InstalledApp)
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
    case requests
    case health
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
    @State private var agentTab: AgentTab = .uses
    /// Pages pushed inside the Agent page: a task chat from its Tasks, an app
    /// or another task chat linked from there. Back returns to the Tasks.
    @State private var agentPath: [Route] = []
    /// A page of the instance opened from inside the Agent page, over it.
    @State private var agentLinkPage: URL?
    /// Where the Agent page finds the avatar it zooms out of.
    @Namespace private var agentZoom
    /// A blank topic chat that started its chat keeps its view under the new id.
    @State private var startedTopics: [String: UUID] = [:]
    @State private var showSettings = false
    @State private var settingsPath: [SettingsRoute] = []
    /// A page of the instance, in a sheet over the main stack.
    @State private var page: URL?
    /// A page opened from Settings, in a sheet over that sheet.
    @State private var settingsPage: URL?
    #if DEBUG
    @State private var settingsPreview = false
    @State private var photoViewerPreview = false
    @State private var pagePreview: URL?
    #endif

    /// The drawer pinned beside the page rather than pushed aside.
    static func usesSidebar(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        sizeClass == .regular
    }

    /// Mac Catalyst, which only runs the tests and the phone-sized snapshot
    /// pass, keeps the phone's layout.
    private var usesSidebar: Bool { Self.usesSidebar(sizeClass) && !ProcessInfo.processInfo.isMacCatalystApp }

    var body: some View {
        GeometryReader { geometry in
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
                    onUpdate: {
                        closeDrawer()
                        model.update.openPage()
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
                .environment(\.chatLinkOpener, openChatLink)
                .environment(\.agentZoom, agentZoom)
                .environment(\.visibleChat, visibleChat)
                .instancePageSheet(workspace: workspace, url: $page)
                .environment(\.isVisitor, workspace.isVisitor)
                .environment(\.shareAgentName, AgentName.display(workspace.agentName))
                // Over the page, so beside a pinned drawer they sit above the chat.
                // The page reaches under the status bar; they start below it.
                .overlay(alignment: .top) { banners.padding(.top, geometry.safeAreaInsets.top) }
                .frame(width: geometry.size.width - column, height: geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom)
            }
        }
        .fullScreenCover(item: $agentPage) { route in
            // Its own stack: a task opens inside the page, and back returns
            // to the Tasks as they were.
            NavigationStack(path: $agentPath) {
                AgentPage(workspace: workspace, route: route, tab: $agentTab, onUse: { prompt in
                    // Into this chat's composer, unsent, as the page closes.
                    agentPage = nil
                    workspace.composerPrefills[route.composerKey] = prompt
                }, onOpenTask: { task in
                    guard let chat = task.chat else { return }
                    agentPath.append(.taskChat(chatId: chat.id, title: chat.name))
                }, onClose: { agentPage = nil })
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
            }
            .environment(model)
            .environment(\.chatLinkOpener, openChatLink)
            .environment(\.visibleChat, visibleChat)
            .environment(\.isVisitor, workspace.isVisitor)
            .environment(\.shareAgentName, AgentName.display(workspace.agentName))
            .instancePageSheet(workspace: workspace, url: $agentLinkPage)
            .presentationBackground(Palette.bg)
            .agentZoomTransition(route.zoomSource, in: agentZoom)
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
        #if DEBUG
        .overlay {
            if photoViewerPreview {
                // Snapshot runs only: the viewer in place of its full-screen cover.
                PhotoViewer(images: [.markdown(ImageSource(src: "/projects/demo/trip/hotel.jpg"), alt: "河原町酒店外观", src: "/projects/demo/trip/hotel.jpg", position: 0)], start: 0)
            }
            if let pagePreview {
                // Snapshot runs only, for the same reason.
                ZStack(alignment: .bottom) {
                    Color.black.ignoresSafeArea()
                    InstancePageScreen(workspace: workspace, url: pagePreview)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                        .padding(.top, 64)
                }
                .ignoresSafeArea()
            }
            if settingsPreview {
                // Snapshot runs only, for the same reason.
                ZStack(alignment: .bottom) {
                    Color.black.ignoresSafeArea()
                    settingsSheet
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                        .padding(.top, 64)
                }
                .ignoresSafeArea()
            }
        }
        #endif
        // Which chat is in front, for pushes: none under a sheet or the drawer.
        .onChange(of: visibleChat, initial: true) { _, chat in model.show(chat, by: screenID) }
        .onChange(of: workspace.mainChatServerID) { model.rewatch() }
        .onDisappear { model.hide(by: screenID) }
        .sensoryFeedback(.impact(weight: .light), trigger: drawerOpen)
        .onChange(of: drawerOpen) { _, open in
            if open {
                Keyboard.dismiss()
                workspace.topics.refresh()
            }
        }
        // Whatever covers or replaces the chat takes the keyboard with it;
        // the composer keeps its text.
        .onChange(of: path) { Keyboard.dismiss() }
        .onChange(of: agentPage) { _, shown in
            Keyboard.dismiss()
            // Opened or closed, it starts on its own page again.
            agentPath = []
            agentLinkPage = nil
        }
        // The banner that offers a sign-in must not be covered.
        .onChange(of: model.sessionExpired) { _, expired in if expired { agentPage = nil } }
        .onChange(of: showSettings) { _, shown in if shown { Keyboard.dismiss() } }
        .onChange(of: page) { _, shown in if shown != nil { Keyboard.dismiss() } }
        // A tapped push for this instance: its chat in front, nothing over it.
        .onChange(of: model.chatRequest) { _, request in
            agentPage = nil
            showSettings = false
            page = nil
            settingsPage = nil
            closeDrawer()
            show(request.topicId.map(MainSection.topic) ?? .chat)
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.sessionExpired)
        // A window that turns wide pins the drawer; the one it pushed aside is closed.
        .onChange(of: usesSidebar) { drawerOpen = false }
        #if DEBUG
        .onChange(of: model.debugCommand) { _, command in
            switch command {
            case .drawer(let open):
                // Pinned, the drawer stays on screen in every capture.
                if !usesSidebar { open ? openDrawer() : closeDrawer() }
            case .agent(let tab):
                if let tab { agentTab = tab }
                agentPage = tab == nil ? nil : AgentRoute(tasksChatId: conciergeChatID, composerKey: conciergeChatID)
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
            case .photoViewer(let open):
                photoViewerPreview = open
            case .composerPhotos, .appIdeas, nil: break
            }
        }
        #endif
    }

    /// Session expired, at the top of the page's column.
    @ViewBuilder
    private var banners: some View {
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
        case .app(let app):
            AppWebScreen(workspace: workspace, app: app)
                .id(app.id)
        }
    }

    /// A link tapped in chat text: an app opens full screen, a page of the
    /// instance in the app's web view in a sheet, anything else as the system
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
            if agentPage != nil { agentPath.append(.app(app)) } else { path.append(.app(app)) }
        } else if let page {
            if agentPage != nil { agentLinkPage = page } else { self.page = page }
        }
    }

    private var root: some View {
        // Chat stays alive under the other pages: rebuilt, its list would load
        // again from the top and scroll down while the drawer closes onto it.
        ZStack {
            ChatScreen(
                workspace: workspace,
                onMenu: { toggleNavigation() },
                onAgent: { agentPage = AgentRoute(tasksChatId: conciergeChatID, composerKey: conciergeChatID) },
                onOpenChat: { chatId, title in path.append(.taskChat(chatId: chatId, title: title)) },
                // The same answer the server watch and push banners go by: a
                // sheet, the drawer or a pushed page over Chat hides it.
                visible: visibleChat == conciergeChatID
            )
            .opacity(section == .chat ? 1 : 0)
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
                    path.append(.app(app))
                }, onStart: { prompt in
                    // The main Chat, with the prompt in its composer to edit.
                    show(.chat)
                    workspace.composerPrefills[conciergeChatID] = prompt
                })
            case .search:
                SearchScreen(workspace: workspace, onMenu: { toggleNavigation() }) { hit in
                    if workspace.isMainChat(hit.session.id) {
                        show(.chat)
                    } else if workspace.topics.chat(hit.session.id) != nil {
                        show(.topic(hit.session.id))
                    } else {
                        path.append(.taskChat(chatId: hit.session.id, title: hit.session.name))
                    }
                }
            }
        }
    }

    private func topicScreen(chatId: String?, key: UUID? = nil, draftKey: String) -> some View {
        TopicChatScreen(
            workspace: workspace,
            chatId: chatId,
            draftKey: draftKey,
            onMenu: { toggleNavigation() },
            onAgent: { id in
                // A blank chat has no tasks yet; its Tasks tab shows the empty state.
                agentPage = AgentRoute(tasksChatId: id ?? "", composerKey: id ?? draftKey)
            },
            onOpenChat: { id, title in path.append(.taskChat(chatId: id, title: title)) },
            onArchived: { show(.chat) },
            onCreated: { id in
                if let key { startedTopics[id] = key }
                var instant = Transaction()
                instant.disablesAnimations = true
                withTransaction(instant) { section = .topic(id) }
            }
        )
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

    /// Settings slides up with its own stack, so the instances page pushes
    /// inside the sheet and the X closes all of it.
    private var settingsSheet: some View {
        NavigationStack(path: $settingsPath) {
            SettingsScreen(
                workspace: workspace,
                onInstances: { settingsPath.append(.instances) },
                onHealth: { settingsPath.append(.health) },
                onRequests: { settingsPath.append(.requests) },
                onClose: { showSettings = false }
            )
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .instances:
                    InstancesScreen(onSwitched: {
                        showSettings = false
                        show(.chat)
                    })
                case .requests:
                    NodeRequestsScreen()
                case .health:
                    HealthAccessScreen()
                }
            }
        }
        // A dashboard page rises over Settings, which is still there when it closes.
        .instancePageSheet(workspace: workspace, url: $settingsPage)
        .presentationBackground(Palette.bg)
    }

    // MARK: Drawer motion

    static let drawerSpring = Animation.spring(response: 0.38, dampingFraction: 0.86)

    /// The chat on screen, by its store's id.
    private var visibleChat: String? {
        if agentPage != nil {
            return Self.visibleChat(agentPath: agentPath, covered: agentLinkPage != nil || workspace.sharingCoversChat)
        }
        return Self.visibleChat(section: section, path: path, covered: drawerOpen || showSettings || page != nil || workspace.sharingCoversChat)
    }

    /// The chat on screen while the Agent page is up: a task chat pushed
    /// inside it, unless a sheet covers it; the page itself shows none.
    static func visibleChat(agentPath: [Route], covered: Bool) -> String? {
        guard !covered, case .taskChat(let chatId, _)? = agentPath.last else { return nil }
        return chatId
    }

    /// The chat on screen: none while something covers the page (the drawer,
    /// the Settings sheet, an instance page's sheet, a chat's share sheets);
    /// a pushed task chat; else the section's chat. Chat's read marks, the
    /// server's watch and push banners all go by this one answer, with
    /// `visibleChat(agentPath:covered:)` while the Agent page is up.
    static func visibleChat(section: MainSection, path: [Route], covered: Bool) -> String? {
        if covered { return nil }
        if let top = path.last {
            if case .taskChat(let chatId, _) = top { return chatId }
            return nil
        }
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
        if sidebarShown { workspace.topics.refresh() }
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

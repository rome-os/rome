import SwiftUI

/// Screens pushed on the main stack.
enum Route: Hashable {
    case taskChat(chatId: String, title: String)
    /// An app of the instance, full screen.
    case app(InstalledApp)
    /// A page of the instance a chat linked to, in the app's web view.
    case page(URL)
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
}

/// The signed-in app: Chat as the home screen, the drawer that pushes it aside,
/// and the Tasks and Settings sheets.
struct MainShell: View {
    let workspace: Workspace
    @Environment(AppModel.self) private var model
    @State private var section: MainSection = .chat
    @State private var path: [Route] = []
    @State private var drawerOpen = false
    /// Marks this view as the one that set the chat on screen.
    @State private var screenID = UUID()
    /// A finger is on the drawer's edge.
    @State private var edgeTouched = false
    /// The finger's pull on the drawer while a drag runs. It springs back to
    /// zero with the drawer when the drag ends or the system cancels it.
    @GestureState(resetTransaction: Transaction(animation: MainShell.drawerSpring))
    private var drag = DrawerDrag()
    /// The axis the running drag locked on its first movement, for `onEnded`,
    /// which gets only the final translation.
    @State private var dragAxis: DragAxis?
    @State private var showTasks = false
    /// The Concierge chat whose tasks the sheet lists.
    @State private var tasksChatId = conciergeChatID
    /// A blank topic chat that started its chat keeps its view under the new id.
    @State private var startedTopics: [String: UUID] = [:]
    @State private var showSettings = false
    @State private var settingsPath: [SettingsRoute] = []
    #if DEBUG
    @State private var sheetPreview = false
    @State private var settingsPreview = false
    @State private var photoViewerPreview = false
    #endif

    var body: some View {
        GeometryReader { geometry in
            let width = min(318, geometry.size.width * 0.81)
            let progress = drawerProgress(width: width)

            ZStack(alignment: .topLeading) {
                Palette.drawer.ignoresSafeArea()

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
                    }
                )
                .frame(width: width, height: geometry.size.height)
                .offset(x: (progress - 1) * 36)
                .opacity(0.4 + 0.6 * progress)
                .allowsHitTesting(drawerOpen)

                NavigationStack(path: $path) {
                    root
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
                }
                .environment(\.chatLinkOpener, openChatLink)
                // Pushed aside, the page becomes a card of its own color, following the drag.
                .environment(\.pageBackground, Palette.blend(Palette.bg, Palette.drawerPage, progress))
                .frame(width: geometry.size.width, height: geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom)
                .clipShape(RoundedRectangle(cornerRadius: 44 * progress, style: .continuous))
                .overlay {
                    if progress > 0 {
                        RoundedRectangle(cornerRadius: 44 * progress, style: .continuous)
                            .fill(Color.clear)
                            .contentShape(Rectangle())
                            .onTapGesture { closeDrawer() }
                    }
                }
                .shadow(color: .black.opacity(0.12 * progress), radius: 15, x: -8, y: 0)
                .offset(x: width * progress)
                .ignoresSafeArea()
                .overlay(alignment: .leading) {
                    if !drawerOpen && path.isEmpty {
                        Color.clear
                            .frame(width: 22)
                            .contentShape(Rectangle())
                            .gesture(drawerDrag(width: width))
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
            .gesture(drawerDrag(width: width), including: drawerOpen ? .all : .subviews)
        }
        .sheet(isPresented: $showTasks) {
            TasksSheet(store: workspace.tasks, chatId: tasksChatId) { task in
                openTask(task)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(22)
            .presentationBackground(Palette.sheet)
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
        #if DEBUG
        .overlay {
            if sheetPreview {
                // Snapshot runs only: the system sheet cannot be captured on Mac Catalyst,
                // so show its content in the same frame a large-detent sheet has.
                ZStack(alignment: .bottom) {
                    Color.black.ignoresSafeArea()
                    TasksSheet(store: workspace.tasks, chatId: tasksChatId) { _ in }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                        .padding(.top, 64)
                }
                .ignoresSafeArea()
            }
            if photoViewerPreview {
                // Snapshot runs only: the viewer in place of its full-screen cover.
                PhotoViewer(images: [.markdown(ImageSource(src: "/projects/demo/trip/hotel.jpg"), alt: "河原町酒店外观", src: "/projects/demo/trip/hotel.jpg", position: 0)], start: 0)
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
        .onChange(of: showTasks) { _, shown in if shown { Keyboard.dismiss() } }
        .onChange(of: showSettings) { _, shown in if shown { Keyboard.dismiss() } }
        // A tapped push for this instance: its chat in front, nothing over it.
        .onChange(of: model.chatRequest) { _, request in
            showTasks = false
            showSettings = false
            closeDrawer()
            show(request.topicId.map(MainSection.topic) ?? .chat)
        }
        .overlay(alignment: .top) {
            if model.sessionExpired {
                TopBanner(kind: .error, text: String(localized: "Session expired"), actionTitle: String(localized: "Sign in again")) {
                    Task { await model.reauthenticate() }
                }
                .padding(.top, 58)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.sessionExpired)
        #if DEBUG
        .onChange(of: model.debugCommand) { _, command in
            switch command {
            case .drawer(let open): open ? openDrawer() : closeDrawer()
            case .tasks(let show):
                if SnapshotRunner.directory != nil { sheetPreview = show } else { showTasks = show }
            case .route(let routes):
                show(.chat)
                path = routes
            case .section(let picked): show(picked)
            case .settings(let routes):
                settingsPath = routes ?? []
                if SnapshotRunner.directory != nil { settingsPreview = routes != nil } else { showSettings = routes != nil }
            case .photoViewer(let open):
                photoViewerPreview = open
            case .composerPhotos, .appIdeas, nil: break
            }
        }
        #endif
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
        case .page(let url):
            AppWebScreen(workspace: workspace, app: InstalledApp(id: url.absoluteString, displayName: workspace.instanceName), pageURL: url)
                .id(url)
        }
    }

    /// A link tapped in chat text: an app opens full screen, a page of the
    /// instance in the app's web view, anything else as the system opens it.
    private func openChatLink(_ url: URL) -> OpenURLAction.Result {
        switch AppLinks.chatLink(url, origin: workspace.backend.origin, apps: workspace.apps) {
        case .app(let id, let page):
            Task { await openLinkedApp(id, page: page) }
            return .handled
        case .page(let page):
            path.append(.page(page))
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
            path.append(.app(app))
        } else if let page {
            path.append(.page(page))
        }
    }

    private var root: some View {
        // Chat stays alive under the other pages: rebuilt, its list would load
        // again from the top and scroll down while the drawer closes onto it.
        ZStack {
            ChatScreen(
                workspace: workspace,
                onMenu: { openDrawer() },
                onTasks: {
                    tasksChatId = conciergeChatID
                    showTasks = true
                },
                onOpenChat: { chatId, title in path.append(.taskChat(chatId: chatId, title: title)) }
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
                AppsScreen(workspace: workspace, onMenu: { openDrawer() }, onOpen: { app in
                    path.append(.app(app))
                }, onStart: { prompt in
                    // The main Chat, with the prompt in its composer to edit.
                    show(.chat)
                    workspace.composerPrefill = prompt
                })
            case .search:
                SearchScreen(workspace: workspace, onMenu: { openDrawer() }) { hit in
                    if hit.session.id == conciergeChatID {
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
            onMenu: { openDrawer() },
            onTasks: { id in
                // A blank chat has no tasks yet; its sheet shows the empty state.
                tasksChatId = id ?? ""
                showTasks = true
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
                onClose: { showSettings = false }
            )
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .instances:
                    InstancesScreen(onSwitched: {
                        showSettings = false
                        show(.chat)
                    })
                }
            }
        }
        .presentationBackground(Palette.bg)
    }

    private func openTask(_ task: ConciergeTask) {
        showTasks = false
        Task {
            try? await Task.sleep(for: .milliseconds(250))
            if let chat = task.chat {
                path = [.taskChat(chatId: chat.id, title: chat.name)]
            } else if let message = task.sourceMessageId, TasksStore.belongs(task, toChat: conciergeChatID) {
                path = []
                workspace.focusMessageID = message
            }
        }
    }

    // MARK: Drawer motion

    static let drawerSpring = Animation.spring(response: 0.38, dampingFraction: 0.86)

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

    /// The chat on screen, by its store's id.
    private var visibleChat: String? {
        if drawerOpen || showTasks || showSettings { return nil }
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

    private func drawerProgress(width: CGFloat) -> CGFloat {
        let base: CGFloat = drawerOpen ? 1 : 0
        return min(1, max(0, base + drag.offset / width))
    }

    private func openDrawer() {
        withAnimation(Self.drawerSpring) { drawerOpen = true }
    }

    private func closeDrawer() {
        withAnimation(Self.drawerSpring) { drawerOpen = false }
    }

    /// Opens from the left edge or closes from anywhere, following the finger.
    /// The translation is read in screen space: the chat moves under the finger,
    /// and reading it in the chat's own space would feed the motion back into itself.
    private func drawerDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($drag) { value, state, _ in
                let move = value.translation
                if state.horizontal == nil { state.horizontal = abs(move.width) > abs(move.height) }
                guard state.horizontal == true else { return }
                state.offset = drawerOpen ? min(0, move.width) : max(0, move.width)
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
                let travel = drawerOpen ? -value.translation.width : value.translation.width
                let flung = drawerOpen ? -value.predictedEndTranslation.width : value.predictedEndTranslation.width
                let toggle = travel > width * 0.35 || flung > width * 0.5
                if toggle { withAnimation(Self.drawerSpring) { drawerOpen.toggle() } }
            }
    }
}

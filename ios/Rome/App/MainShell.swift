import SwiftUI

/// Screens pushed on the main stack.
enum Route: Hashable {
    case taskChat(chatId: String, title: String)
    case settings
    case instances
    case search
    case routines
}

/// The signed-in app: Chat as the home screen, the drawer that pushes it aside,
/// and the Tasks sheet.
struct MainShell: View {
    let workspace: Workspace
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var drawerOpen = false
    /// The finger's pull on the drawer while a drag runs. It springs back to
    /// zero with the drawer when the drag ends or the system cancels it.
    @GestureState(resetTransaction: Transaction(animation: MainShell.drawerSpring))
    private var drag = DrawerDrag()
    @State private var showTasks = false
    #if DEBUG
    @State private var sheetPreview = false
    #endif

    var body: some View {
        GeometryReader { geometry in
            let width = min(318, geometry.size.width * 0.81)
            let progress = drawerProgress(width: width)

            ZStack(alignment: .topLeading) {
                Palette.drawer.ignoresSafeArea()

                DrawerView(
                    workspace: workspace,
                    onChat: { closeDrawer(popToRoot: true) },
                    onRoute: { route in
                        path = [route]
                        closeDrawer(popToRoot: false)
                    }
                )
                .frame(width: width, height: geometry.size.height)
                .offset(x: (progress - 1) * 36)
                .opacity(0.4 + 0.6 * progress)
                .allowsHitTesting(drawerOpen)

                NavigationStack(path: $path) {
                    ChatScreen(
                        workspace: workspace,
                        onMenu: { openDrawer() },
                        onTasks: { showTasks = true },
                        onOpenChat: { chatId, title in path.append(.taskChat(chatId: chatId, title: title)) }
                    )
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom)
                .clipShape(RoundedRectangle(cornerRadius: 44 * progress, style: .continuous))
                .overlay {
                    if progress > 0 {
                        RoundedRectangle(cornerRadius: 44 * progress, style: .continuous)
                            .fill(Palette.drawerScrim.opacity(progress))
                            .contentShape(Rectangle())
                            .onTapGesture { closeDrawer(popToRoot: false) }
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
                    }
                }
            }
            // While the drawer is open, a sideways drag anywhere, on the drawer or
            // the uncovered chat, pulls it closed.
            .gesture(drawerDrag(width: width), including: drawerOpen ? .all : .subviews)
        }
        .sheet(isPresented: $showTasks) {
            TasksSheet(store: workspace.tasks) { task in
                openTask(task)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(22)
            .presentationBackground(Palette.sheet)
        }
        #if DEBUG
        .overlay {
            if sheetPreview {
                // Snapshot runs only: the system sheet cannot be captured on Mac Catalyst,
                // so show its content in the same frame a large-detent sheet has.
                ZStack(alignment: .bottom) {
                    Color.black.ignoresSafeArea()
                    TasksSheet(store: workspace.tasks) { _ in }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                        .padding(.top, 64)
                }
                .ignoresSafeArea()
            }
        }
        #endif
        .sensoryFeedback(.impact(weight: .light), trigger: drawerOpen)
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
            case .drawer(let open): open ? openDrawer() : closeDrawer(popToRoot: false)
            case .tasks(let show):
                if SnapshotRunner.directory != nil { sheetPreview = show } else { showTasks = show }
            case .route(let routes): path = routes
            case nil: break
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
        case .settings:
            SettingsScreen(workspace: workspace, onInstances: { path.append(.instances) })
        case .instances:
            InstancesScreen(onSwitched: { path = [] })
        case .search:
            SearchScreen(workspace: workspace) { hit in
                if hit.session.id == conciergeChatID {
                    path = []
                } else {
                    path.append(.taskChat(chatId: hit.session.id, title: hit.session.name))
                }
            }
        case .routines:
            RoutinesScreen()
        }
    }

    private func openTask(_ task: ConciergeTask) {
        showTasks = false
        Task {
            try? await Task.sleep(for: .milliseconds(250))
            if let chat = task.chat {
                path = [.taskChat(chatId: chat.id, title: chat.name)]
            } else if let message = task.sourceMessageId {
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

    private func drawerProgress(width: CGFloat) -> CGFloat {
        let base: CGFloat = drawerOpen ? 1 : 0
        return min(1, max(0, base + drag.offset / width))
    }

    private func openDrawer() {
        withAnimation(Self.drawerSpring) { drawerOpen = true }
    }

    private func closeDrawer(popToRoot: Bool) {
        if popToRoot { path = [] }
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
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let travel = drawerOpen ? -value.translation.width : value.translation.width
                let flung = drawerOpen ? -value.predictedEndTranslation.width : value.predictedEndTranslation.width
                let toggle = travel > width * 0.35 || flung > width * 0.5
                if toggle { withAnimation(Self.drawerSpring) { drawerOpen.toggle() } }
            }
    }
}

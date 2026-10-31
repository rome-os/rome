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
    @State private var drag: CGFloat = 0
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
                            .onTapGesture { closeDrawer(popToRoot: false) }
                            .gesture(closeDrag(width: width))
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
                            .gesture(openDrag(width: width))
                    }
                }
            }
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

    private func drawerProgress(width: CGFloat) -> CGFloat {
        let base: CGFloat = drawerOpen ? 1 : 0
        return min(1, max(0, base + drag / width))
    }

    private func openDrawer() {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            drawerOpen = true
            drag = 0
        }
    }

    private func closeDrawer(popToRoot: Bool) {
        if popToRoot { path = [] }
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            drawerOpen = false
            drag = 0
        }
    }

    private func openDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in drag = max(0, value.translation.width) }
            .onEnded { value in
                let open = value.predictedEndTranslation.width > width * 0.4 || value.translation.width > width * 0.5
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    drawerOpen = open
                    drag = 0
                }
            }
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in drag = min(0, value.translation.width) }
            .onEnded { value in
                let close = value.predictedEndTranslation.width < -width * 0.3
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    drawerOpen = !close
                    drag = 0
                }
            }
    }
}

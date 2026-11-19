import SwiftUI
import UIKit

/// The Agent page's tabs; it opens on Tasks.
enum AgentTab: Hashable { case tasks, routines, outputs }

/// The Agent page as opened from one chat's header: which chat's tasks and
/// outputs it lists, and the avatar it grows out of.
struct AgentRoute: Identifiable, Equatable {
    /// The Concierge chat whose tasks and outputs show: the main chat, a
    /// topic chat, or "" for a blank topic chat, which has none yet.
    let tasksChatId: String
    /// The chat's key on this phone: its id, or a blank chat's draft key.
    let chatKey: String

    var id: String { chatKey }
    /// The header avatar the page zooms out of and back into.
    var zoomSource: String { AgentZoom.source(chatKey) }
}

/// Opened from the mascot in a chat's header: the Agent, big, with its name;
/// then what it is doing in this chat (Tasks), what runs on its own (Routines) and the files it made (Outputs).
struct AgentPage: View {
    let workspace: Workspace
    let route: AgentRoute
    @Binding var tab: AgentTab
    /// A task's chat was asked for: it opens inside the page.
    let onOpenTask: (ConciergeTask.LinkedChat) -> Void
    let onClose: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pokes = 0
    @State private var streak = TapStreak()
    @State private var haptic = UIImpactFeedbackGenerator(style: .soft)
    /// The stacking game, opened from the big mascot over this page.
    @State private var game: StackGameLaunch?
    /// The chat's task list, kept by the workspace: in the first frame, so
    /// the tab never shows "No tasks yet" while it is looked up.
    private var taskList: TaskListStore? { workspace.taskList(forChat: route.tasksChatId) }
    /// The chat's outputs, kept by the workspace, read again each time the tab opens.
    private var outputs: ChatOutputsStore? { workspace.outputs(forChat: route.tasksChatId) }

    static let discSize: CGFloat = 96

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker(selection: $tab) {
                Text("Tasks").tag(AgentTab.tasks)
                Text("Routines").tag(AgentTab.routines)
                Text("Outputs").tag(AgentTab.outputs)
            } label: {
                EmptyView()
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 360)
            .padding(.horizontal, Metrics.pagePadding)
            .padding(.top, 14)
            .padding(.bottom, 12)
            switch tab {
            case .outputs:
                AgentOutputsView(store: outputs, backend: workspace.backend, onOpenChat: onOpenTask)
            case .tasks:
                TaskListView(store: taskList, mode: .tasks, onOpenChat: onOpenTask)
            case .routines:
                TaskListView(store: taskList, mode: .routines, onOpenChat: onOpenTask)
            }
        }
        // The list as it was last read shows at once, and is read again.
        .holdsTaskList(taskList)
        .readableColumn()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.bg.ignoresSafeArea())
        .overlay(alignment: .topLeading) {
            GlassCircleButton(accessibilityLabel: "Close", action: onClose) {
                Image(systemName: "xmark").romeFont(16, .semibold)
            }
            .padding(.leading, 16)
            .padding(.top, 4)
        }
        .fullScreenCover(item: $game) { launch in
            StackGameScreen(launch: launch) { game = nil }
                .environment(model)
                .presentationBackground(Palette.bg)
        }
    }


    private var header: some View {
        VStack(spacing: 10) {
            // A tap pokes it; ten quick ones open the stacking game.
            // The header avatar's disc, grown: the mascot keeps its share.
            Mascot(blinks: !reduceMotion, pokes: pokes)
                .frame(height: Self.discSize * 28 / ChatIdentity.avatarSize)
                .frame(width: Self.discSize, height: Self.discSize)
                .background(Palette.elevated, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                .shadow(color: Palette.avatarShadow, radius: 6, x: 0, y: 2)
                .contentShape(Circle())
                .onTapGesture {
                    haptic.impactOccurred()
                    haptic.prepare()
                    pokes += 1
                    if streak.tap(at: CACurrentMediaTime()) {
                        game = StackGameLaunch(backTo: workspace.agentDisplayName)
                    }
                }
                .onAppear { haptic.prepare() }
                .accessibilityHidden(true)
            Text(verbatim: workspace.agentDisplayName)
                .romeFont(24, .bold)
                .tracking(-0.5)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
        }
        // The disc's top is level with the close button's, in its row: the
        // disc is centred, so the two never meet, even on the narrowest phone.
        .padding(.top, 4)
    }
}

/// The zoom from a chat header's avatar into the Agent page (iOS 18 and
/// later; before that the page rises as a plain cover).
enum AgentZoom {
    static func source(_ chatKey: String) -> String { "agent-" + chatKey }
}

private struct AgentZoomNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
    /// Where the Agent page's zoom finds its source avatar; nil draws none.
    var agentZoom: Namespace.ID? {
        get { self[AgentZoomNamespaceKey.self] }
        set { self[AgentZoomNamespaceKey.self] = newValue }
    }
}

extension View {
    /// Marks the avatar the Agent page grows out of.
    @ViewBuilder
    func agentZoomSource(_ id: String?, in namespace: Namespace.ID?) -> some View {
        if #available(iOS 18, *), let id, let namespace {
            matchedTransitionSource(id: id, in: namespace)
        } else {
            self
        }
    }

    /// The Agent page grows out of its avatar and shrinks back into it.
    @ViewBuilder
    func agentZoomTransition(_ id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18, *) {
            navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            self
        }
    }
}

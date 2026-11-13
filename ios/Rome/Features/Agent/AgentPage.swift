import SwiftUI
import UIKit

/// The Agent page's tabs; it opens on Tasks.
enum AgentTab: Hashable { case tasks, uses }

/// The Agent page as opened from one chat's header: which chat's tasks it
/// lists, which composer a picked prompt goes to, and the avatar it grows
/// out of.
struct AgentRoute: Identifiable, Equatable {
    /// The Concierge chat whose tasks show: the main chat, a topic chat, or
    /// "" for a blank topic chat, which has none yet.
    let tasksChatId: String
    /// The composer a picked prompt goes to (`Workspace.composerPrefills`).
    let composerKey: String

    var id: String { composerKey }
    /// The header avatar the page zooms out of and back into.
    var zoomSource: String { AgentZoom.source(composerKey) }
}

/// Opened from the mascot in a chat's header: the Agent, big, with its name;
/// then what to ask it (Uses) and what it is doing in this chat (Tasks).
struct AgentPage: View {
    let workspace: Workspace
    let route: AgentRoute
    @Binding var tab: AgentTab
    /// A prompt was picked: the page closes and it goes in the composer.
    let onUse: (String) -> Void
    /// A task's chat was asked for: it opens inside the page.
    let onOpenTask: (ConciergeTask.LinkedChat) -> Void
    /// Respond on a task that needs the guardian: the page closes and the
    /// chat shows the message with the card it waits on.
    let onRespond: (_ messageId: String) -> Void
    let onClose: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pokes = 0
    @State private var streak = TapStreak()
    @State private var haptic = UIImpactFeedbackGenerator(style: .soft)
    /// The stacking game, opened from the big mascot over this page.
    @State private var game: StackGameLaunch?
    /// The chat's task list, listened to while the page is open.
    @State private var taskList: TaskListStore?

    static let discSize: CGFloat = 96

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker(selection: $tab) {
                Text("Tasks").tag(AgentTab.tasks)
                Text("Uses").tag(AgentTab.uses)
            } label: {
                EmptyView()
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 320)
            .padding(.horizontal, Metrics.pagePadding)
            .padding(.top, 18)
            .padding(.bottom, 12)
            switch tab {
            case .uses:
                uses
            case .tasks:
                TaskListView(store: taskList, onRespond: respond, onOpenChat: onOpenTask)
            }
        }
        .task(id: route.tasksChatId) {
            // The list as it was last read shows at once, and is read again.
            guard let store = workspace.taskList(forChat: route.tasksChatId) else { return }
            taskList = store
            store.open()
        }
        .onDisappear { taskList?.stop() }
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

    /// To the card in the chat; with no message of this chat showing it,
    /// to the task chat that holds it.
    private func respond(_ item: TaskListItem.Task) {
        if let messageId = item.cardMessageId {
            onRespond(messageId)
        } else if let chat = item.task.chat {
            onOpenTask(chat)
        } else {
            taskList?.fail(String(localized: "Could not find the card"))
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
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
        .padding(.top, 56)
    }

    private var uses: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(AgentUse.all.enumerated()), id: \.element.id) { index, use in
                    useRow(use, last: index == AgentUse.all.count - 1)
                }
            }
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
            .hairline(radius: Metrics.groupRadius)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    private func useRow(_ use: AgentUse, last: Bool) -> some View {
        Button { onUse(use.prompt) } label: {
            HStack(spacing: 12) {
                Image(systemName: use.symbol)
                    .romeFont(17)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(verbatim: use.title)
                    .romeFont(16)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 13)
            .padding(.horizontal, 16)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 52) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityHint(Text("Puts it in the message box."))
    }
}

/// The zoom from a chat header's avatar into the Agent page (iOS 18 and
/// later; before that the page rises as a plain cover).
enum AgentZoom {
    static func source(_ composerKey: String) -> String { "agent-" + composerKey }
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

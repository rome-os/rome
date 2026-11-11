import SwiftUI
import UIKit

/// The Agent page's tabs; it opens on Uses.
enum AgentTab: Hashable { case uses, tasks }

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
    let onOpenTask: (ConciergeTask) -> Void
    let onClose: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pokes = 0
    @State private var streak = TapStreak()
    @State private var haptic = UIImpactFeedbackGenerator(style: .soft)
    /// The stacking game, opened from the big mascot over this page.
    @State private var game: StackGameLaunch?

    static let mascotWidth: CGFloat = 80

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker(selection: $tab) {
                Text("Uses").tag(AgentTab.uses)
                Text("Tasks").tag(AgentTab.tasks)
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
                TasksList(store: workspace.tasks, chatId: route.tasksChatId, onOpen: onOpenTask)
            }
        }
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
        VStack(spacing: 12) {
            // A tap pokes it; ten quick ones open the stacking game.
            Mascot(blinks: !reduceMotion, pokes: pokes)
                .frame(width: Self.mascotWidth)
                .contentShape(Rectangle())
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
            VStack(alignment: .leading, spacing: 18) {
                ForEach(AgentUseGroup.all) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: group.title)
                            .romeFont(13, .semibold)
                            .foregroundStyle(Palette.sub)
                            .padding(.horizontal, 6)
                            .accessibilityAddTraits(.isHeader)
                        VStack(spacing: 0) {
                            ForEach(Array(group.prompts.enumerated()), id: \.offset) { index, prompt in
                                useRow(prompt, last: index == group.prompts.count - 1)
                            }
                        }
                        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                        .hairline(radius: Metrics.groupRadius)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    private func useRow(_ prompt: String, last: Bool) -> some View {
        Button { onUse(prompt) } label: {
            Text(verbatim: prompt)
                .romeFont(16)
                .foregroundStyle(Palette.fg)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
                .overlay(alignment: .bottom) {
                    if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
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

import SwiftUI

/// Archive or Delete asked for a topic chat, from its header's "…" or from its
/// row in the drawer.
struct TopicRetireRequest: Equatable {
    enum Action: Equatable { case archive, delete }

    let chatId: String
    /// The chat's name as the guardian sees it, for the alert.
    let name: String
    let action: Action
}

extension View {
    /// Archives or deletes a topic chat once `request` is set, asking what the
    /// header always asked: it reads the chat's follows and open tasks first,
    /// then a delete always asks, and an archive asks only when there is
    /// something to move or stop. `onRetired` gets the chat's id once it is
    /// archived or deleted. A request made while one is read is ignored.
    func topicRetire(_ request: Binding<TopicRetireRequest?>, workspace: Workspace, onRetired: @escaping (String) -> Void) -> some View {
        modifier(TopicRetireModifier(request: request, workspace: workspace, onRetired: onRetired))
    }
}

private struct TopicRetireModifier: ViewModifier {
    @Binding var request: TopicRetireRequest?
    let workspace: Workspace
    let onRetired: (String) -> Void
    /// The delete alert, once the chat's follows and open tasks are read.
    @State private var deleting: TopicDeletePrompt?
    /// The archive alert, once they are read and there is something to ask about.
    @State private var archiving: TopicArchivePrompt?

    func body(content: Content) -> some View {
        content
            .onChange(of: request) { _, asked in
                if let asked { ask(asked) }
            }
            .deleteTopicChatAlert($deleting) { id, stoppingWork in
                Task { if await workspace.deleteTopic(id, stoppingWork: stoppingWork) { onRetired(id) } }
            }
            .archiveTopicChatAlert($archiving) { id, stoppingWork in
                archive(id, stoppingWork: stoppingWork)
            }
    }

    /// Reads what the chat would move, then asks; an archive with nothing to
    /// ask about, or whose read fails, goes ahead at once, as before.
    private func ask(_ asked: TopicRetireRequest) {
        Task {
            let work = await workspace.topicWork(asked.chatId)
            request = nil
            switch asked.action {
            case .delete:
                deleting = TopicDeletePrompt(id: asked.chatId, name: asked.name, work: work)
            case .archive:
                if let work, !work.isEmpty {
                    archiving = TopicArchivePrompt(id: asked.chatId, name: asked.name, work: work)
                } else {
                    archive(asked.chatId)
                }
            }
        }
    }

    private func archive(_ id: String, stoppingWork: Bool = false) {
        Task { if await workspace.archiveTopic(id, stoppingWork: stoppingWork) { onRetired(id) } }
    }
}

/// Pin or Unpin, as the header's "…", a drawer row's swipe and its menu show it.
struct TopicPinButton: View {
    let pinned: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if pinned {
                Label("Unpin", systemImage: "pin.slash")
            } else {
                Label("Pin", systemImage: "pin")
            }
        }
    }
}

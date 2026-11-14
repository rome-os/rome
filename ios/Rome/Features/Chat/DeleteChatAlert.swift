import SwiftUI

extension View {
    /// Asks before a chat is deleted for good. An alert, not an action sheet:
    /// on current iOS an action sheet opens as a popover and drops Cancel.
    func deleteChatAlert(isPresented: Binding<Bool>, onDelete: @escaping () -> Void) -> some View {
        alert("Delete this chat?", isPresented: isPresented) {
            Button("Delete", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
    }
}

/// What deleting a topic chat asks, as on the web: its follows and open tasks
/// move to the main Chat, or stop. Made once they are read, so the alert
/// never changes while it is up.
struct TopicDeletePrompt: Identifiable {
    /// How many follows and tasks the alert lists before "and N more".
    static let listed = 5

    /// The chat's id.
    let id: String
    /// The chat's name as the guardian sees it.
    let name: String
    /// nil when they could not be read: the delete moves them, as it always has.
    let work: ConciergeChatWork?

    var title: String { String(localized: "Delete “\(name)”?") }

    /// Whether there is anything to choose for.
    var asksAboutWork: Bool { !(work?.isEmpty ?? true) }

    var message: String {
        guard let work else {
            return String(localized: "This chat is deleted permanently. Its follows and open tasks move to Chat.")
        }
        if work.isEmpty { return String(localized: "This chat is deleted permanently.") }
        let items = work.follows.map { String(localized: "Following \($0.label) · \($0.target)") }
            + work.openTasks.map { String(localized: "Open task: \($0.title)") }
        var lines = [String(localized: "This chat is deleted permanently. It has:")]
        lines += items.prefix(Self.listed).map { "• \($0)" }
        if items.count > Self.listed {
            lines.append(String(localized: "and \(items.count - Self.listed) more"))
        }
        lines += ["", String(localized: "What happens to them?")]
        return lines.joined(separator: "\n")
    }
}

extension View {
    /// Asks before a topic chat is deleted for good. With follows or open
    /// tasks, the guardian picks whether they move to the main Chat or stop;
    /// `onDelete` gets the chat's id and whether to stop them.
    func deleteTopicChatAlert(_ prompt: Binding<TopicDeletePrompt?>, onDelete: @escaping (_ chatId: String, _ stoppingWork: Bool) -> Void) -> some View {
        alert(
            prompt.wrappedValue?.title ?? "",
            isPresented: Binding(get: { prompt.wrappedValue != nil }, set: { if !$0 { prompt.wrappedValue = nil } }),
            presenting: prompt.wrappedValue
        ) { prompt in
            // Both delete the chat; they differ in what becomes of its work.
            if prompt.asksAboutWork {
                Button("Move to Chat", role: .destructive) { onDelete(prompt.id, false) }
                Button("Stop them", role: .destructive) { onDelete(prompt.id, true) }
            } else {
                Button("Delete", role: .destructive) { onDelete(prompt.id, false) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { prompt in
            Text(prompt.message)
        }
    }
}

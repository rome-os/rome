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
        return Self.asking(String(localized: "This chat is deleted permanently. It has:"), about: work)
    }

    /// `lead`, the chat's follows and open tasks (five, then "and N more"),
    /// and the question, as the delete and archive alerts ask it.
    static func asking(_ lead: String, about work: ConciergeChatWork) -> String {
        let items = work.follows.map { String(localized: "Following \($0.label) · \($0.target)") }
            + work.openTasks.map { String(localized: "Open task: \($0.title)") }
        return asking(lead, items: items)
    }

    /// `lead`, `items` (five, then "and N more"), and the question.
    static func asking(_ lead: String, items: [String]) -> String {
        var lines = [lead]
        lines += items.prefix(listed).map { "• \($0)" }
        if items.count > listed {
            lines.append(String(localized: "and \(items.count - listed) more"))
        }
        lines += ["", String(localized: "What happens to them?")]
        return lines.joined(separator: "\n")
    }
}

/// What archiving a topic chat with follows or open tasks asks, as on the
/// web: they move to the main Chat, or stop. Only made when there is
/// something to ask about; otherwise the chat is archived at once.
struct TopicArchivePrompt: Identifiable {
    /// The chat's id.
    let id: String
    /// The chat's name as the guardian sees it.
    let name: String
    let work: ConciergeChatWork

    var title: String { String(localized: "Archive “\(name)”?") }

    var message: String {
        TopicDeletePrompt.asking(String(localized: "This chat will be archived. It has:"), about: work)
    }
}

/// What restoring an archived topic chat asks, as on the web: the follows
/// its archive moved to the main Chat move back, or stay. Only made when
/// some are still there; otherwise the chat is restored at once.
struct TopicRestorePrompt: Identifiable {
    /// The chat's id.
    let id: String
    /// The chat's name as the guardian sees it.
    let name: String
    let moved: [ConciergeChatWork.Follow]

    var title: String { String(localized: "Unarchive “\(name)”?") }

    var message: String {
        TopicDeletePrompt.asking(
            String(localized: "When this chat was archived, these follows moved to Chat:"),
            items: moved.map { String(localized: "Following \($0.label) · \($0.target)") }
        )
    }
}

extension View {
    /// Asks before an archived topic chat whose follows moved to the main
    /// Chat is restored: they move back, the default, or stay. `onRestore`
    /// gets the chat's id and whether to move them back.
    func restoreTopicChatAlert(_ prompt: Binding<TopicRestorePrompt?>, onRestore: @escaping (_ chatId: String, _ movingBack: Bool) -> Void) -> some View {
        alert(
            prompt.wrappedValue?.title ?? "",
            isPresented: Binding(get: { prompt.wrappedValue != nil }, set: { if !$0 { prompt.wrappedValue = nil } }),
            presenting: prompt.wrappedValue
        ) { prompt in
            // Both restore the chat; they differ in where its follows' alerts go.
            Button("Move them back") { onRestore(prompt.id, true) }
                .keyboardShortcut(.defaultAction)
            Button("Keep in Chat") { onRestore(prompt.id, false) }
            Button("Cancel", role: .cancel) {}
        } message: { prompt in
            Text(prompt.message)
        }
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

extension View {
    /// Asks before a topic chat with follows or open tasks is archived: they
    /// move to the main Chat or stop. `onArchive` gets the chat's id and
    /// whether to stop them.
    func archiveTopicChatAlert(_ prompt: Binding<TopicArchivePrompt?>, onArchive: @escaping (_ chatId: String, _ stoppingWork: Bool) -> Void) -> some View {
        alert(
            prompt.wrappedValue?.title ?? "",
            isPresented: Binding(get: { prompt.wrappedValue != nil }, set: { if !$0 { prompt.wrappedValue = nil } }),
            presenting: prompt.wrappedValue
        ) { prompt in
            // Both archive the chat; they differ in what becomes of its work.
            Button("Move to Chat") { onArchive(prompt.id, false) }
            Button("Stop them", role: .destructive) { onArchive(prompt.id, true) }
            Button("Cancel", role: .cancel) {}
        } message: { prompt in
            Text(prompt.message)
        }
    }
}

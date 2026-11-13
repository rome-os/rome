import Foundation

/// What a transcript's rows do when the guardian acts on them: Retry, Delete,
/// Reply, Share, a thread label, a quote, a task card. One object for each
/// store, so a row holds a reference that never changes, not closures made
/// anew each time its screen is drawn: a row that did not change is not drawn
/// again.
@MainActor
final class ChatActions {
    weak var store: TranscriptStore?
    /// Opens a task chat. The screen that shows the transcript sets it.
    var onOpenChat: (String, String) -> Void = { _, _ in }

    func retry(_ rowId: String) { store?.retry(rowId) }
    func remove(_ rowId: String) { store?.removePending(rowId) }
    func reply(to messageId: String) { store?.reply(to: messageId) }
    func share(fromRow rowId: String) { store?.share.begin(fromRow: rowId) }
    func openThread(at messageId: String) { store?.openThread(at: messageId) }
    func quote(reply replyId: String, original: String) { store?.quoteAction(reply: replyId, original: original)?() }

    /// `inThread`: from a row in a thread view, which closes first, or the chat would be pushed under it.
    func openChat(_ chatId: String, _ title: String, inThread: Bool = false) {
        if inThread { store?.closeThread() }
        onOpenChat(chatId, title)
    }
}

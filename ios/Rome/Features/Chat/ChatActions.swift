import Foundation

/// What a transcript's rows do when the guardian acts on them: Retry, Delete,
/// Reply, Share, a thread label, a quote. One object for each
/// store, so a row holds a reference that never changes, not closures made
/// anew each time its screen is drawn: a row that did not change is not drawn
/// again.
@MainActor
final class ChatActions {
    weak var store: TranscriptStore?

    func retry(_ rowId: String) { store?.retry(rowId) }
    func remove(_ rowId: String) { store?.removePending(rowId) }
    func reply(to messageId: String) { store?.reply(to: messageId) }
    func share(fromRow rowId: String) { store?.share.begin(fromRow: rowId) }
    func openThread(at messageId: String) { store?.openThread(at: messageId) }
    func quote(reply replyId: String, original: String) { store?.quoteAction(reply: replyId, original: original)?() }
}

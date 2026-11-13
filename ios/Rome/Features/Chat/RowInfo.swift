import Foundation

/// What a text row draws from the message it belongs to: its time, the quote
/// it carries, Rome's mark, whether it is a send the app still holds. The
/// store reads it once when it builds the rows, so a row's body never
/// searches the messages, and a row whose message did not change compares equal
/// and is not drawn again.
struct RowInfo: Hashable {
    /// When the message was written; nil for a send the instance has not stored.
    var date: Date?
    /// The message is in a turn, so share mode can start on it.
    var canShare = false
    /// The quote a reply carries, on its first bubble.
    var quote: MessagePart.ReplyQuote?
    /// The quote leads somewhere: the task's thread view, or the original.
    var quoteLeads = false
    /// Rome's mark on a guardian message.
    var mark: StatusMark?
    /// The row is a send the app still holds, which only it can drop.
    var isPending = false
    /// A task chat's message the Concierge wrote on the guardian's side.
    var saidByAgent = false
    var senderName: String?

    /// The info of every text row, by row id. `messages` are the ones the
    /// rows were built from, and everything the quote may lead to.
    @MainActor
    static func build(
        rows: [TranscriptRow],
        messages: [ChatMessage],
        pending: [PendingSend],
        kind: TranscriptStore.Kind
    ) -> [String: RowInfo] {
        var byID: [String: ChatMessage] = [:]
        for message in messages { byID[message.id] = message }
        let pendingIDs = Set(pending.map(\.id))
        // The threads a task has, found once: a lookup per quoted row would
        // scan every message for each (`TranscriptStore.taskThreadTitle`).
        let titledThreads = Set(messages.compactMap { $0.chatThreadTitle == nil ? nil : $0.chatThreadId })
        var infos: [String: RowInfo] = [:]
        for row in rows {
            var info = RowInfo()
            switch row {
            case .userText(_, _, _, let state):
                info.isPending = pendingIDs.contains(row.id)
                if kind == .concierge, state == nil, let id = row.messageId {
                    info.mark = byID[id]?.statusReaction.flatMap(StatusMark.init(rawValue:))
                }
            case .agentText:
                break
            default:
                continue
            }
            if let message = row.messageId.flatMap({ byID[$0] }) {
                info.date = message.date
                info.canShare = message.turnId != nil
                info.saidByAgent = message.saidByAgent
                info.senderName = message.sender?.name
                // The quote leads where `TranscriptStore.quoteAction` would take it.
                if case .userText = row, let quote = Self.quote(of: message, row: row) {
                    info.quote = quote
                    let inThread = message.chatThreadId.map(titledThreads.contains) ?? false
                    info.quoteLeads = kind == .concierge && (inThread || byID[quote.messageId] != nil)
                }
            }
            infos[row.id] = info
        }
        return infos
    }

    /// The quote a reply carries, drawn on the first bubble of its message only.
    private static func quote(of message: ChatMessage, row: TranscriptRow) -> MessagePart.ReplyQuote? {
        let parts = message.parts
        guard let first = parts.firstIndex(where: { $0.textContent != nil }),
              row.id == "\(message.id):\(first)" else { return nil }
        return parts.lazy.compactMap(\.replyQuote).first
    }
}

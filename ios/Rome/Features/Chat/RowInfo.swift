import Foundation

/// What a text row or a task card draws from the message it belongs to: its
/// time, the quote it carries, Rome's mark, whether it is a send the app still holds. The
/// store reads it once when it builds the rows, so a row's body never
/// searches the messages, and a row whose message did not change compares equal
/// and is not drawn again.
struct RowInfo: Hashable {
    /// When the message was written; nil for a send the instance has not stored.
    var date: Date?
    /// The message is in a turn, so share mode can start on it.
    var canShare = false
    /// The quote a reply draws, on its first bubble: not for a reply that sits
    /// right under what it answers, or in a run of replies to one message.
    var quote: MessagePart.ReplyQuote?
    /// The badge on a guardian message: Rome's status, else the Concierge's reaction.
    var mark: MessageMark?
    /// The row is a send the app still holds, which only it can drop.
    var isPending = false
    /// A task chat's message the Concierge wrote on the guardian's side.
    var saidByAgent = false
    var senderName: String?

    /// The info of every text and task card row, by row id. `messages` are the ones the
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
        var infos: [String: RowInfo] = [:]
        for (index, row) in rows.enumerated() {
            var info = RowInfo()
            switch row {
            case .userText(_, _, _, let state):
                info.isPending = pendingIDs.contains(row.id)
                if kind == .concierge, state == nil, let id = row.messageId {
                    info.mark = byID[id].flatMap { MessageMark(status: $0.status, reaction: $0.reaction) }
                }
            case .agentText, .taskCard, .taskAsk:
                break
            default:
                continue
            }
            if let message = row.ownMessageId.flatMap({ byID[$0] }) {
                info.date = message.date
                info.canShare = message.turnId != nil
                info.saidByAgent = message.saidByAgent
                info.senderName = message.sender?.name
                if let quote = Self.quote(of: message, row: row), Self.drawsQuote(message, row: row, previous: Self.messageAbove(index, rows: rows, byID: byID)) {
                    info.quote = quote
                }
            }
            infos[row.id] = info
        }
        return infos
    }

    /// The message drawn above the row at `index`, which is not its own: the
    /// rows between, such as time lines and notices, are not messages.
    private static func messageAbove(_ index: Int, rows: [TranscriptRow], byID: [String: ChatMessage]) -> ChatMessage? {
        let own = rows[index].ownMessageId
        for above in rows[..<index].reversed() {
            if let id = above.ownMessageId, id != own { return byID[id] }
        }
        return nil
    }

    /// Whether a reply draws its quote (docs/domains/chats.md#chat-thread).
    /// The guardian's reply always does. The Concierge's does not when it sits
    /// in a run of replies to one message, or right under the guardian's
    /// message it answers. A card draws none.
    private static func drawsQuote(_ message: ChatMessage, row: TranscriptRow, previous: ChatMessage?) -> Bool {
        if message.isUser { return true }
        guard case .agentText(_, _, _, _, let position) = row else { return false }
        if position.joinsAbove { return false }
        let target = message.parts.lazy.compactMap(\.replyQuote).first?.messageId
        if let previous, previous.isUser, previous.id == target { return false }
        return true
    }

    /// The quote a reply carries, drawn on the first bubble or card of its message only.
    private static func quote(of message: ChatMessage, row: TranscriptRow) -> MessagePart.ReplyQuote? {
        let parts = message.parts
        guard let first = parts.firstIndex(where: { $0.textContent != nil || $0.isTaskChat }),
              row.id == "\(message.id):\(first)" else { return nil }
        return parts.lazy.compactMap(\.replyQuote).first
    }
}

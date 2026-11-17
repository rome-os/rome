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
    /// The quote a reply carries, on its first bubble.
    var quote: MessagePart.ReplyQuote?
    /// The quote leads somewhere: the reply's thread view, or the original.
    var quoteLeads = false
    /// The thread this message roots, when it has replies: its stack, drawn
    /// under the message's last bubble.
    var stack: ThreadStack?
    /// The badge on a guardian message: Rome's status, else the Concierge's reaction.
    var mark: MessageMark?
    /// The row is a send the app still holds, which only it can drop.
    var isPending = false
    /// A task chat's message the Concierge wrote on the guardian's side.
    var saidByAgent = false
    var senderName: String?

    /// The info of every text and task card row, by row id. `messages` are the ones the
    /// rows were built from, and everything the quote may lead to. `threads`
    /// are the stacks the main line draws: each goes on the last bubble or
    /// card of its root.
    @MainActor
    static func build(
        rows: [TranscriptRow],
        messages: [ChatMessage],
        pending: [PendingSend],
        kind: TranscriptStore.Kind,
        threads: ThreadStacks = .none
    ) -> [String: RowInfo] {
        var byID: [String: ChatMessage] = [:]
        for message in messages { byID[message.id] = message }
        let pendingIDs = Set(pending.map(\.id))
        var infos: [String: RowInfo] = [:]
        // A reply the main line leaves out for a stack is not the message above another.
        let adjacent = TranscriptBuilder.adjacentReplies(messages, hidden: threads.stacked)
        // The last bubble or card of each message, which carries its stack.
        var lastBubble: [String: String] = [:]
        if !threads.stacks.isEmpty {
            for row in rows {
                switch row {
                case .userText, .agentText, .taskCard:
                    if let message = row.ownMessageId { lastBubble[message] = row.id }
                default:
                    break
                }
            }
        }
        for row in rows {
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
                // The quote leads where `TranscriptStore.quoteAction` would take it:
                // a reply is in a thread of more than one, since its root is
                // another message.
                // A reply that sits right under what it answers shows nothing.
                if !adjacent.contains(message.id), let quote = Self.quote(of: message, row: row) {
                    info.quote = quote
                    let inThread = message.chatThreadId.map { $0 != message.id } ?? false
                    info.quoteLeads = kind == .concierge && (inThread || byID[quote.messageId] != nil)
                }
            }
            if let own = row.ownMessageId, lastBubble[own] == row.id { info.stack = threads.stacks[own] }
            infos[row.id] = info
        }
        return infos
    }

    /// The quote a reply carries, drawn on the first bubble or card of its message only.
    private static func quote(of message: ChatMessage, row: TranscriptRow) -> MessagePart.ReplyQuote? {
        let parts = message.parts
        guard let first = parts.firstIndex(where: { $0.textContent != nil || $0.isTaskChat }),
              row.id == "\(message.id):\(first)" else { return nil }
        return parts.lazy.compactMap(\.replyQuote).first
    }
}

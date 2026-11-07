import SwiftUI

/// Which card a row that asks or reports draws. The same in every chat: the
/// main chat, a topic chat and a task chat.
enum InteractionCard: Equatable {
    case approval
    case question(sessionId: String)
    case tools
    /// Drawn only on the web dashboard; "Open" goes to this chat there.
    case webOnly

    init?(_ row: TranscriptRow) {
        switch row {
        case .approval: self = .approval
        case .question(_, _, let sessionId, _): self = .question(sessionId: sessionId)
        case .tools: self = .tools
        case .webOnly: self = .webOnly
        default: return nil
        }
    }
}

/// An approval or question card answered here, a tool summary, or the link
/// to the web for the rest. Answers go to the row's own session.
struct InteractionRow: View {
    let row: TranscriptRow
    let store: TranscriptStore

    var body: some View {
        switch row {
        case .tools(_, let traceID, let count):
            ToolSummary(count: count, calls: store.toolCalls[traceID]) { store.loadToolCalls(traceID) }
        case .approval(_, let part, _):
            ApprovalCardView(
                part: part,
                status: store.approvals[part.approvalId] == nil ? nil : store.approvalStatus(part),
                submitting: store.resolvingApproval[part.approvalId],
                error: store.approvalErrors[part.approvalId],
                resolvedAt: RomeDate.parse(store.approvals[part.approvalId]?.resolvedAt ?? store.approvals[part.approvalId]?.updatedAt)
            ) { approve in
                store.resolve(part.approvalId, approve: approve)
            }
            .onAppear { store.watchApproval(part.approvalId) }
        case .question(_, let part, let sessionId, let answered):
            QuestionCardView(part: part, answered: answered, sending: store.answering.contains(part.toolUseId)) { values in
                store.answer(part, values: values, sessionId: sessionId)
            }
        case .webOnly:
            WebOnlyCard(sessionId: store.sessionId)
        default:
            EmptyView()
        }
    }
}

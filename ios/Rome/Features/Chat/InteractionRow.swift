import SwiftUI

/// Which card a row that asks or reports draws. The same in every chat: the
/// main chat, a topic chat and a task chat.
enum InteractionCard: Equatable {
    case approval
    case question(sessionId: String)
    case connect
    case tools
    /// Drawn only on the web dashboard; "Open" goes to this chat there.
    case webOnly
    case routineDraft
    case widget

    init?(_ row: TranscriptRow) {
        switch row {
        case .approval: self = .approval
        case .question(_, _, let sessionId, _): self = .question(sessionId: sessionId)
        case .connect: self = .connect
        case .tools: self = .tools
        case .webOnly: self = .webOnly
        case .routineDraft: self = .routineDraft
        case .widgetUI: self = .widget
        default: return nil
        }
    }
}

/// An approval or question card answered here, a tool summary, or the link
/// to the web for the rest. Answers go to the row's own session.
struct InteractionRow: View {
    let row: TranscriptRow
    let store: TranscriptStore
    @Environment(\.isVisitor) private var isVisitor

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
                resolvedAt: RomeDate.parse(store.approvals[part.approvalId]?.resolvedAt ?? store.approvals[part.approvalId]?.updatedAt),
                canResolve: !isVisitor
            ) { approve in
                store.resolve(part.approvalId, approve: approve)
            }
            // The record is the guardian's to read: a visitor would only get 403s.
            .onAppear { if !isVisitor { store.watchApproval(part.approvalId) } }
        case .question(_, let part, let sessionId, let answered):
            QuestionCardView(part: part, answered: answered, sending: store.answering.contains(part.toolUseId)) { answers in
                store.answer(part, answers: answers, sessionId: sessionId)
            }
        case .connect(let id, let part, let sessionId):
            ConnectCardView(part: part, phase: store.connectPhases[id] ?? TranscriptStore.previewPhase(part.service) ?? .idle) {
                store.connect(part, rowId: id, chatId: sessionId)
            }
            .task(id: id) { await store.checkConnected(part, rowId: id) }
        case .widgetUI(_, let part):
            WidgetUICardView(part: part) { method, path, body in
                try await store.appCall(appId: part.appId, method: method, path: path, body: body)
            }
        case .webOnly(_, let kind, let done):
            WebOnlyCard(kind: kind, done: done, sessionId: store.sessionId)
        case .routineDraft(_, let part):
            RoutineDraftCardView(part: part, status: store.routineStatus(part), canTurnOn: !isVisitor, sessionId: store.sessionId)
                .task { if !isVisitor { await store.loadRoutines() } }
        default:
            EmptyView()
        }
    }
}
